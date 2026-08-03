-- 사람인 척 (whois-human) — 페이즈 상태머신
-- SPEC §5, §12.1, §16.2, §17.2. 소유: A
--
--   psql "$SUPABASE_DB_URL_DIRECT" -f supabase/functions/advance_phase.sql
--
-- 여기가 게임의 심장이다. 꼬이면 전부 멈춘다.
-- 판정은 전부 서버 now() 기준이다. 클라이언트 카운트다운은 표시용이다 (I2).
--
-- ┌─ 왜 Edge Function이 아니라 plpgsql인가 (SPEC §17.2) ───────────────────┐
-- │ pg_cron 워치독은 SQL만 실행할 수 있다. 전환이 Edge Function 안에 있으면 │
-- │ 워치독이 방을 넘길 수 없어 SPEC §12.1의 안전망이 반쪽이 된다.           │
-- │                                                                       │
-- │ AI를 쓰지 않는 동안 진입 훅에 필요한 일이 전부 SQL로 된다 — 질문도 봇   │
-- │ 답변도 DB 안의 문구 풀에서 뽑기 때문이다. 그래서 전환 한 트랜잭션 안에서 │
-- │ 다 끝난다. 점수 계산(calcScores)만 TS라서 /api/reveal로 뺐다.           │
-- │                                                                       │
-- │ LLM을 붙이면 이 파일에서 바뀌는 건 한 줄이다 —                          │
-- │ 봇 답변 insert 앞에 "이미 준비된 답변이 있으면 건드리지 않는다"가 붙는다.│
-- └───────────────────────────────────────────────────────────────────────┘

------------------------------------------------------------------------------
-- 전환표 — SPEC §5.1
------------------------------------------------------------------------------
-- lib/server/phase.ts의 nextPhase()와 **같은 표여야 한다.** 한쪽만 고치지 않는다.
create or replace function next_phase(
  p_phase text, p_round int,
  out phase text, out round int
) language plpgsql immutable as $$
begin
  case p_phase
    when 'lobby' then
      phase := 'question'; round := 1;
    when 'question' then
      if p_round < 2 then
        phase := 'question'; round := 2;
      else
        phase := 'target';   round := p_round;
      end if;
    when 'target' then phase := 'chat';   round := p_round;
    when 'chat'   then phase := 'vote';   round := p_round;
    -- vote 의 기본 다음은 reveal 이다. **사람 표가 동점이면** advance_phase 본체가
    -- 이걸 revote 로 갈아탄다 (SPEC §18.3) — 표 집계는 DB를 봐야 하므로 순수 함수인
    -- 여기서는 못 정한다. revote 는 언제나 reveal 로 끝난다(재투표는 한 번뿐).
    when 'vote'   then phase := 'reveal'; round := p_round;
    when 'revote' then phase := 'reveal'; round := p_round;
    when 'reveal' then phase := 'replay'; round := p_round;
    else               phase := 'replay'; round := p_round;
  end case;
end;
$$;

------------------------------------------------------------------------------
-- 기준 시계 — SPEC §12.5, I2
------------------------------------------------------------------------------
-- ★ 이 게임의 시계는 DB 하나다. phase_ends_at도 visible_at도 전부 여기서 나온다.
--   Route Handler가 new Date()로 시각을 만들면 앱 서버 시계가 섞인다. 실제로
--   개발 기계에서 두 시계가 2.26초 어긋나 있었고, 그만큼 카운트다운이 밀렸다.
--   /api/time은 이 함수를 부른다.
create or replace function server_now()
returns timestamptz
language sql
stable
as $$ select now() $$;

-- lobby / reveal / replay는 시간이 아니라 사람 조작으로 넘어간다 → null
create or replace function phase_duration(p_phase text)
returns interval language sql immutable as $$
  select case p_phase
    when 'question' then interval '60 seconds'
    -- 30초다. 60초면 나머지가 멍하니 기다린다. target에는 조기 종료가 없어서
    -- (early_exit_met 참고) 대상이 누구든 매번 꽉 채운다 — 그래서 이 숫자가 곧
    -- 죽은 시간이다. 답을 씹는 시간은 뒤의 chat이 맡는다.
    when 'target'   then interval '30 seconds'
    when 'chat'     then interval '120 seconds'
    when 'vote'     then interval '30 seconds'
    -- 재투표는 짧다. 후보가 좁혀졌고 생각도 이미 굳었다 (SPEC §18.3)
    when 'revote'   then interval '20 seconds'
    else null
  end;
$$;

------------------------------------------------------------------------------
-- 조기 종료 판정 — SPEC §5.1, I5
------------------------------------------------------------------------------
-- ★ "사람 전원"은 is_bot = false만 센다. 봇은 페이즈 진입 즉시 제출하므로
--   봇을 포함해 세면 모든 페이즈가 시작하자마자 끝난다.
create or replace function early_exit_met(p_room_id uuid, p_phase text, p_round int)
returns boolean
language plpgsql stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_humans int;
  v_done   int;
  v_qid    uuid;
begin
  select count(*) into v_humans
    from players where room_id = p_room_id and not is_bot;

  -- 사람이 하나도 없으면 조기 종료는 의미가 없다. 시간 만료만 기다린다.
  if v_humans = 0 then
    return false;
  end if;

  if p_phase = 'question' then
    select id into v_qid from questions
     where room_id = p_room_id and round = p_round and kind = 'common'
     limit 1;
    if v_qid is null then return false; end if;

    select count(*) into v_done
      from answers a join players p on p.id = a.player_id
     where a.question_id = v_qid and not p.is_bot;
    return v_done >= v_humans;

  elsif p_phase = 'vote' or p_phase = 'revote' then
    -- 사람 전원이 (재)투표를 냈으면 시간 만료를 안 기다린다. 봇은 제외한다 (I5).
    -- revote 도 사람 전원이 다시 내면 넘어간다 — 진입 훅이 vote 표를 지우므로
    -- 여기 세는 건 이번 재투표 표뿐이다.
    select count(*) into v_done
      from votes v join players p on p.id = v.voter_id
     where v.room_id = p_room_id and not p.is_bot;
    return v_done >= v_humans;
  end if;

  -- lobby / target / chat / reveal / replay — 조기 종료 없음 (SPEC §5.1, §5.3)
  --
  -- ┌─ ★ target에 조기 종료를 두지 않는 이유 ────────────────────────────────┐
  -- │ 한때 "대상이 봇이면 조기 종료하지 않는다"였다. 봇은 진입 즉시 답변이    │
  -- │ 생겨서 그대로 두면 페이즈가 0초에 끝나고, 그것만으로 대상이 봇임이      │
  -- │ 드러나기 때문이다.                                                     │
  -- │                                                                       │
  -- │ 그런데 그 처방은 **누수의 방향만 뒤집었다.** 봇이 대상이면 항상 30초를  │
  -- │ 채우고 사람이 대상이면 답하는 즉시 넘어가니, "빨리 넘어갔다"가 곧       │
  -- │ "대상은 사람"이라는 확정 신호가 된다. SPEC §5.3이 스스로 적어둔 경고    │
  -- │ ("봇일 때만 짧게 하면 그게 다시 신호가 된다")의 거울상이다.             │
  -- │                                                                       │
  -- │ 대칭을 만드는 방법은 하나뿐이다 — 양쪽 다 시간을 채운다.                │
  -- │ 그 대가(죽은 시간)는 60초를 30초로 줄이면서 이미 치렀다.                │
  -- │ lib/server/phase.ts의 EARLY_EXIT.target도 'none'이다. 한쪽만 고치지 않는다.│
  -- └───────────────────────────────────────────────────────────────────────┘
  return false;
end;
$$;

------------------------------------------------------------------------------
-- 투표 집계 · 지목 확정 — SPEC §18.3, §18.4
------------------------------------------------------------------------------
-- **승패를 정하는 표는 사람 표뿐이다** (§18.3, §8.1). 봇도 던지고 reveal에 보이지만
-- 집계에서 뺀다 — 봇은 아무나 찍으므로 세면 판정이 주사위가 된다.
--
-- 반환 두 갈래:
--   candidates 가 non-null  →  사람 표 최다가 **동점**이다. 이 동점자들로 좁혀 revote 로 간다
--                              (vote 페이즈에서만 나온다).
--   nominated 가 non-null    →  지목이 확정됐다. reveal 로 간다.
--
-- p_candidates 를 주면(revote) 그 안에서만 센다. 거기서도 동점이면 **무작위 한 명**을
-- 지목한다 — 재투표는 한 번뿐이라 판은 최대 2라운드에 끝난다 (§18.3).
--
-- 사람 표가 하나도 없는 판(전원 미투표·이탈)도 멈추면 안 되므로 무작위로 지목한다.
create or replace function resolve_vote(
  p_room_id   uuid,
  p_phase     text,
  p_candidates uuid[],
  out nominated  uuid,
  out candidates uuid[]
) language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_top uuid[];
  v_n   int;
begin
  -- 사람 표만, (revote면) 후보 안에서만 센다. 최다 득표 자리들을 v_top 에 모은다.
  with tally as (
    select v.target_id, count(*) as c
      from votes v join players p on p.id = v.voter_id
     where v.room_id = p_room_id and not p.is_bot
       and (p_candidates is null or v.target_id = any(p_candidates))
     group by v.target_id
  )
  select array_agg(target_id) into v_top
    from tally
   where c = (select max(c) from tally);

  -- 세는 표가 하나도 없다. 판을 끝내야 하므로 무작위 지목으로 떨어진다.
  if v_top is null then
    if p_phase = 'revote' then
      select array_agg(id) into v_top
        from players where room_id = p_room_id and id = any(p_candidates);
    else
      select array_agg(id) into v_top
        from players where room_id = p_room_id;
    end if;
  end if;

  v_n := coalesce(array_length(v_top, 1), 0);

  -- vote 에서 동점이면 후보를 좁혀 재투표로 넘긴다 (지목은 아직 없다).
  if p_phase = 'vote' and v_n > 1 then
    nominated  := null;
    candidates := v_top;
    return;
  end if;

  -- 단독이면 그 자리, revote 동점이면 그중 무작위 하나. (배열은 1-기반)
  nominated  := v_top[1 + floor(random() * v_n)::int];
  candidates := null;
end;
$$;

------------------------------------------------------------------------------
-- 문구 뽑기 — SPEC §17.2
------------------------------------------------------------------------------
-- ★ 한 줄만 필요할 때 쓴다 (자유 채팅의 bot_reply). **질문을 가리지 않는다.**
--   질문이 있는 페이즈(question · target)는 아래 on_enter_phase가 질문에 맞는 문구를
--   서로 겹치지 않게 배정한다 — 이 함수를 봇마다 따로 부르면 안 된다. 그렇게 했다가
--   두 가지가 한꺼번에 깨졌다: 답이 질문과 무관했고, 봇끼리 같은 말을 했다 (I1).
create or replace function pick_bot_line(p_phase text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_text text;
begin
  select text into v_text
    from bot_line_pool where phase = p_phase
   order by random() limit 1;

  if v_text is null then
    raise exception 'bot_line_pool(%)이 비었다 — supabase/seed.sql을 적용할 것', p_phase;
  end if;
  return v_text;
end;
$$;

------------------------------------------------------------------------------
-- 페이즈 진입 훅 — SPEC §5.3, §17.2
------------------------------------------------------------------------------
create or replace function on_enter_phase(
  p_room_id uuid, p_phase text, p_round int, p_ends_at timestamptz
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_qid    uuid;
  v_text   text;
  v_asker  uuid;
  v_target uuid;
  v_line   text;
  v_bots   int;
  v_lines  int;
  v_cands  uuid[];
begin
  -- 이 방의 봇 수. 문구가 봇 수보다 적으면 답이 빈 봇이 생기므로 미리 센다.
  select count(*) into v_bots
    from players where room_id = p_room_id and is_bot;

  if p_phase = 'question' then
    -- 이 방에서 아직 안 나온 질문 하나
    select q.text into v_text
      from question_pool q
     where q.kind = 'common'
       and not exists (
         select 1 from questions x where x.room_id = p_room_id and x.text = q.text
       )
     order by random() limit 1;

    if v_text is null then
      raise exception 'question_pool(common)이 비었다 — supabase/seed.sql을 적용할 것';
    end if;

    insert into questions (room_id, round, kind, text)
    values (p_room_id, p_round, 'common', v_text)
    returning id into v_qid;

    -- 봇 답변. visible_at을 페이즈 종료 시각으로 박아 **사람 답변과 같이 뜨게** 한다.
    -- 먼저 뜨면 그것만으로 봇이 드러난다 (I1). 사람 답변도 같은 시각을 쓴다.
    --
    -- ┌─ ★ 질문에 맞는 문구를, 서로 겹치지 않게 ───────────────────────────┐
    -- │ 옛 코드는 봇마다 pick_bot_line('question')을 따로 불렀다. 두 가지가  │
    -- │ 깨져 있었다.                                                        │
    -- │  1. 문구가 질문과 무관했다 — '배터리 몇 퍼센트야?'에 '어제랑 비슷했던│
    -- │     것 같아'. 사람은 숫자를 대는데 봇만 딴소리를 하니 **첫 질문 한   │
    -- │     번으로 봇이 전부 갈렸다** (I1).                                  │
    -- │  2. 봇마다 독립적으로 뽑아서 겹쳤다 — 봇 6명이면 약 68% 확률로 두    │
    -- │     봇이 토씨 하나 안 틀리고 같은 말을 했다. 그것만으로 둘 다 봇이다.│
    -- │                                                                    │
    -- │ 그래서 봇에 번호를 매기고 문구에도 번호를 매겨 1:1로 붙인다.         │
    -- │ 이 질문에 달린 문구를 먼저 쓰고, 모자라면 질문을 가리지 않는 일반    │
    -- │ 문구(question_text is null)로 뒤를 채운다.                           │
    -- │                                                                    │
    -- │ ★ CTE에 materialized를 박는 이유: 안 붙이면 플래너가 join 안쪽을     │
    -- │   다시 훑을 수 있고, 그때 random()이 새로 굴러 번호가 어긋난다.      │
    -- │   겹치지 않게 만든 의미가 통째로 사라진다.                           │
    -- └────────────────────────────────────────────────────────────────────┘
    if v_bots > 0 then
      select count(*) into v_lines
        from bot_line_pool
       where phase = 'question'
         and (question_text is null or question_text = v_text);

      -- 모자라면 조용히 답이 빈 봇이 생긴다. 빈칸은 사람만 만들 수 있으므로 그 자리가
      -- 그대로 드러난다 (I1). 조용히 새느니 전환이 실패하는 편이 낫다.
      if v_lines < v_bots then
        raise exception '봇 문구가 모자란다 (question, 문구 % < 봇 %) — supabase/seed.sql을 채울 것',
          v_lines, v_bots;
      end if;

      with bots as materialized (
        select p.id, row_number() over (order by random()) as rn
          from players p
         where p.room_id = p_room_id and p.is_bot
      ), lines as materialized (
        select text,
               row_number() over (
                 order by (question_text is null), random()   -- 특화 문구 먼저
               ) as rn
          from bot_line_pool
         where phase = 'question'
           and (question_text is null or question_text = v_text)
      )
      insert into answers (question_id, room_id, player_id, text, visible_at)
      select v_qid, p_room_id, b.id, l.text, p_ends_at
        from bots b join lines l on l.rn = b.rn
      on conflict (question_id, player_id) do nothing;
    end if;

  elsif p_phase = 'target' then
    -- 누가 누구에게 묻는지는 서버가 정한다. 봇도 지목 대상이 될 수 있다.
    select id into v_asker
      from players where room_id = p_room_id order by random() limit 1;
    select id into v_target
      from players where room_id = p_room_id and id <> v_asker order by random() limit 1;

    select text into v_text
      from question_pool where kind = 'target' order by random() limit 1;
    if v_text is null then
      raise exception 'question_pool(target)이 비었다 — supabase/seed.sql을 적용할 것';
    end if;

    insert into questions (room_id, round, kind, text, asked_by, target_id)
    values (p_room_id, p_round, 'target', v_text, v_asker, v_target)
    returning id into v_qid;

    if (select is_bot from players where id = v_target) then
      -- 한 명만 답하므로 겹칠 일은 없다. 다만 **질문에는 맞아야 한다** —
      -- 위 question 훅과 같은 이유다. 이 지목 질문에 달린 문구를 먼저 쓴다.
      select l.text into v_line
        from bot_line_pool l
       where l.phase = 'target'
         and (l.question_text is null or l.question_text = v_text)
       order by (l.question_text is null), random()
       limit 1;

      if v_line is null then
        raise exception 'bot_line_pool(target)이 비었다 — supabase/seed.sql을 적용할 것';
      end if;

      insert into answers (question_id, room_id, player_id, text, visible_at)
      values (v_qid, p_room_id, v_target, v_line, p_ends_at)
      on conflict do nothing;
    end if;

  elsif p_phase = 'vote' then
    -- 봇 투표. 자기 아닌 사람 중 하나.
    --
    -- ★ 이유도 봇끼리 겹치지 않게 배정한다. 옛 코드는 봇마다 pick_bot_line('vote')을
    --   따로 불렀는데, 풀이 8개뿐이라 봇 6명이면 약 92% 확률로 두 봇이 똑같은 이유를
    --   달았고 그게 reveal 화면에 나란히 떴다 (I1). 이유는 질문과 무관하므로
    --   question_text is null인 줄만 쓴다.
    if v_bots > 0 then
      select count(*) into v_lines
        from bot_line_pool where phase = 'vote' and question_text is null;

      if v_lines < v_bots then
        raise exception '봇 투표 이유가 모자란다 (문구 % < 봇 %) — supabase/seed.sql을 채울 것',
          v_lines, v_bots;
      end if;

      with bots as materialized (
        select p.id, row_number() over (order by random()) as rn
          from players p
         where p.room_id = p_room_id and p.is_bot
      ), lines as materialized (
        select text, row_number() over (order by random()) as rn
          from bot_line_pool
         where phase = 'vote' and question_text is null
      )
      insert into votes (room_id, voter_id, target_id, reason)
      select p_room_id, b.id,
             (select p2.id from players p2
               where p2.room_id = p_room_id and p2.id <> b.id
               order by random() limit 1),
             l.text
        from bots b join lines l on l.rn = b.rn
      on conflict (room_id, voter_id) do nothing;
    end if;

  elsif p_phase = 'revote' then
    -- 재투표는 **처음부터 다시 센다** (SPEC §18.3). vote 페이즈의 표(사람·봇)를 지운다.
    -- 안 지우면 사람은 upsert 로 덮어써도 봇 표가 남아 두 라운드가 섞인다.
    delete from votes where room_id = p_room_id;

    -- 후보는 advance_phase 가 rooms.revote_candidates 에 이미 박아뒀다(이 훅보다 먼저).
    select revote_candidates into v_cands from rooms where id = p_room_id;

    -- 봇도 후보 중 자기 아닌 하나를 찍는다. 이유 문구는 vote 풀을 그대로 쓰고,
    -- 봇끼리 겹치지 않게 1:1로 배정한다 (vote 훅과 같은 이유 — I1).
    if v_bots > 0 and v_cands is not null then
      select count(*) into v_lines
        from bot_line_pool where phase = 'vote' and question_text is null;

      if v_lines < v_bots then
        raise exception '봇 투표 이유가 모자란다 (재투표, 문구 % < 봇 %) — supabase/seed.sql을 채울 것',
          v_lines, v_bots;
      end if;

      with bots as materialized (
        select p.id, row_number() over (order by random()) as rn
          from players p
         where p.room_id = p_room_id and p.is_bot
      ), lines as materialized (
        select text, row_number() over (order by random()) as rn
          from bot_line_pool
         where phase = 'vote' and question_text is null
      )
      insert into votes (room_id, voter_id, target_id, reason)
      select p_room_id, b.id,
             -- 후보 중 자기 아닌 하나. 동점이라 후보는 늘 둘 이상이니 반드시 있다.
             (select c from unnest(v_cands) c where c <> b.id order by random() limit 1),
             l.text
        from bots b join lines l on l.rn = b.rn
      on conflict (room_id, voter_id) do nothing;
    end if;

  -- chat   : 봇 쿨다운 초기화는 자유 채팅을 붙일 때 (SPEC §5.4, §13-6). 지금은 할 일 없음
  -- reveal : 점수는 /api/reveal이 calcScores로 계산한다 (SPEC §17.2)
  end if;
end;
$$;

------------------------------------------------------------------------------
-- 전환 본체 — SPEC §5.2
------------------------------------------------------------------------------
-- 반환값: 실제로 전환했으면 true, 아무것도 안 했으면 false.
--
-- ★ anon에게 execute를 주지 않는다 (파일 끝 revoke 참고).
--   p_actor_id는 호출자가 마음대로 넣을 수 있는 값이라 그것만으로는 방장을 확인할 수
--   없다. 쿠키의 player_token으로 player_id를 되찾은 뒤 이 함수를 부르는 것은
--   service role을 쥔 /api/phase/advance 하나뿐이다 (I9, SPEC §17.4).
create or replace function advance_phase(
  p_room_id      uuid,
  p_expected_seq int,
  p_actor_id     uuid default null
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room      rooms%rowtype;
  v_next      record;
  v_phase     text;
  v_round     int;
  v_ends_at   timestamptz;
  v_nom       uuid;
  v_cands     uuid[];
  v_set_nom   uuid;
  v_set_cands uuid[];
begin
  -- 1. 행 잠금
  select * into v_room from rooms where id = p_room_id for update;
  if not found then
    raise exception '방을 찾을 수 없다: %', p_room_id;
  end if;

  -- 2. 낙관적 잠금 (I6). 5명이 동시에 불러도 첫 호출만 통과한다.
  --    늦게 온 호출은 에러가 아니라 조용히 false다 — 정상 동작이기 때문이다.
  if v_room.phase_seq <> p_expected_seq then
    return false;
  end if;

  -- 3. 전환해도 되는가
  if v_room.phase_ends_at is not null then
    -- 시간이 있는 페이즈: 만료했거나 조기 종료 조건을 채웠어야 한다
    if now() < v_room.phase_ends_at
       and not early_exit_met(p_room_id, v_room.phase, v_room.round) then
      return false;
    end if;
  else
    -- 시간이 없는 페이즈(lobby / reveal / replay)는 사람이 넘긴다 (SPEC §5.1).
    -- null과 비교하면 결과가 null이라 위 조건으로는 절대 안 걸린다. 그래서 따로 판다.
    if v_room.phase = 'replay' then
      return false;   -- 갈 곳이 없다 (SPEC §15-5 미결정)
    end if;

    if p_actor_id is null then
      raise exception '% 페이즈는 호출자(actor)가 필요하다', v_room.phase;
    end if;
    if not exists (select 1 from players where id = p_actor_id and room_id = p_room_id) then
      raise exception '이 방의 플레이어가 아니다';
    end if;

    if v_room.phase = 'lobby' then
      if p_actor_id is distinct from v_room.host_id then
        raise exception '방장만 게임을 시작할 수 있다';
      end if;
      -- ★ 사람이 둘 이상이어야 한다 (SPEC §8, §17.6).
      --   혼자 시작하면 assignRoles가 스파이를 배정하지 않고(사람 2명 이상 조건),
      --   남은 자리가 전부 봇이라 **아무나 찍어도 정답**이다. 게임의 절반(스파이)과
      --   나머지 절반(추리)이 같이 죽는다. 정원 하한 3의 근거(§17.6)를 실제로
      --   강제하는 자리다 — 여지만 만들고 강제하지 않으면 의미가 없다.
      --
      --   /api/room/start에도 같은 검사가 있다(MIN_HUMANS_TO_START). 두 겹인 이유는
      --   그쪽이 먼저 걸러 봇을 채우기 전에 거절하기 위해서고, 여기는 그 라우트를
      --   거치지 않는 경로를 막기 위해서다.
      if (select count(*) from players
           where room_id = p_room_id and not is_bot) < 2 then
        raise exception '사람이 2명 이상이어야 시작할 수 있다' using errcode = 'P0001';
      end if;
      -- 역할 배정은 TS(assignRoles, SPEC §8)라 DB가 못 한다.
      -- /api/room/start가 봇을 채우고 역할을 넣은 뒤에 이 함수를 부른다.
      if not exists (select 1 from player_roles where room_id = p_room_id) then
        raise exception '역할이 배정되지 않았다 — /api/room/start를 거칠 것 (SPEC §8)';
      end if;
    end if;
  end if;

  -- 4. 다음 페이즈 계산. record 필드에 직접 대입하지 않고 지역 변수로 옮겨 다룬다
  --    (동점이면 아래에서 v_phase 를 revote 로 갈아탄다).
  select * into v_next from next_phase(v_room.phase, v_room.round);
  v_phase := v_next.phase;
  v_round := v_next.round;

  -- 4.1 투표 결과 확정 (SPEC §18.3, §18.4).
  --   vote  : 사람 표 최다가 동점이면 revote 로 갈아타고, 아니면 지목을 확정한다.
  --   revote: 후보 안에서 다시 세고, 또 동점이면 무작위로 한 명을 지목한다.
  --   그 밖의 전환은 지목·후보 컬럼을 그대로 둔다.
  v_set_nom   := v_room.nominated_player_id;
  v_set_cands := v_room.revote_candidates;

  if v_room.phase = 'vote' then
    select nominated, candidates into v_nom, v_cands
      from resolve_vote(p_room_id, 'vote', null);
    if v_cands is not null then
      v_phase     := 'revote';   -- next_phase 는 reveal 을 줬지만 동점이라 갈아탄다
      v_set_nom   := null;
      v_set_cands := v_cands;
    else
      v_set_nom   := v_nom;
      v_set_cands := null;
    end if;
  elsif v_room.phase = 'revote' then
    select nominated, candidates into v_nom, v_cands
      from resolve_vote(p_room_id, 'revote', v_room.revote_candidates);
    v_set_nom   := v_nom;   -- 재투표는 무조건 지목으로 끝난다
    v_set_cands := null;
  end if;

  -- ★ v_ends_at 은 v_phase 가 바뀐 **뒤에** 계산한다. 위에서 revote 로 갈아탔으면
  --   20초가 붙어야 하는데, 먼저 계산하면 reveal(무기한)의 null 로 굳는다.
  v_ends_at := case
    when phase_duration(v_phase) is null then null
    else now() + phase_duration(v_phase)
  end;

  update rooms
     set phase               = v_phase,
         round               = v_round,
         phase_seq           = phase_seq + 1,
         phase_ends_at       = v_ends_at,
         nominated_player_id = v_set_nom,
         revote_candidates   = v_set_cands
   where id = p_room_id;

  -- 4.5 지나간 페이즈의 답변을 공개한다 (SPEC §13-4).
  --
  -- ★ 이게 없으면 답변이 게임 내내 한 번도 화면에 뜨지 않는다.
  --   답변의 visible_at은 제출 당시의 phase_ends_at이다 (app/api/answer/route.ts).
  --   조기 종료로 넘어가면 그 시각이 아직 미래라서 RLS(visible_at <= now())가
  --   계속 가리고, 정작 그 시각이 되면 화면은 이미 다음 질문을 보고 있다.
  --   페이즈가 끝났으면 그 페이즈의 답은 열려야 한다.
  --
  -- ★ 반드시 on_enter_phase보다 **먼저** 돈다. 훅은 새 페이즈의 봇 답변을 미래
  --   visible_at으로 넣는데, 그 뒤에 이걸 돌리면 봇 답이 사람이 답하기도 전에 뜬다.
  --   먼저 뜨는 답은 그것만으로 봇이다 (I1). 순서를 바꾸지 말 것.
  update answers
     set visible_at = now()
   where room_id = p_room_id
     and visible_at > now();

  -- 5. 진입 훅 (SPEC §5.3). 같은 트랜잭션이라 훅이 실패하면 전환도 통째로 롤백된다.
  --    ★ v_next.phase 가 아니라 v_phase 를 넘긴다 — 동점으로 revote 로 갈아탔으면
  --    훅도 revote 로 들어가 vote 표를 지우고 봇 재투표를 넣어야 한다.
  perform on_enter_phase(p_room_id, v_phase, v_round, v_ends_at);

  -- 6. Realtime이 rooms 변경을 자동 브로드캐스트한다 (SPEC §6)
  return true;
end;
$$;

------------------------------------------------------------------------------
-- 워치독 — SPEC §12.1 3번 안전망, §16.2
------------------------------------------------------------------------------
-- ★ 이건 선택이 아니다. 없으면 백그라운드 탭에서 방이 그 자리에 멈춘다.
--   특히 아무도 입력하지 않는 chat 페이즈에서 잘 터진다.
--
-- 여러 방이 동시에 돌 때 안전망이 오히려 단일 장애점이 되지 않도록 세 가지를 넣는다.
create or replace function advance_expired_rooms(p_limit int default 50)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r       record;
  v_count int := 0;
begin
  -- ③ 중복 실행 방지: 한 번 실행이 15초를 넘겨도 다음 cron과 겹치지 않는다.
  --    xact 버전이라 트랜잭션이 끝나면 자동으로 풀린다 (예외가 나도 새지 않는다).
  if not pg_try_advisory_xact_lock(hashtext('whois-human:phase-watchdog')) then
    return 0;
  end if;

  for r in
    select id, phase_seq
      from rooms
     where phase_ends_at is not null
       and phase_ends_at < now()
     order by phase_ends_at
     limit p_limit
     -- ① 잠긴 방은 기다리지 않고 건너뛴다. 안 그러면 전환 중인 방 하나 때문에
     --    뒤쪽 방이 전부 밀린다.
     for update skip locked
  loop
    -- ② 방마다 예외 격리. 한 방에서 예외가 나도 나머지 방은 그대로 전환된다.
    begin
      if advance_phase(r.id, r.phase_seq) then
        v_count := v_count + 1;
      end if;
    exception when others then
      raise warning 'advance_expired_rooms: 방 % 전환 실패: %', r.id, sqlerrm;
    end;
  end loop;

  return v_count;
end;
$$;

------------------------------------------------------------------------------
-- 끝난 방 정리 — SPEC §16.4
------------------------------------------------------------------------------
-- 안 하면 코드(4자 × 24글자 = 331,776가지)가 계속 점유되고 워치독 스캔 대상으로도 남는다.
-- cascade가 딸린 데이터는 함께 지워진다.
--
-- replay 방은 아직 지우지 않는다 — replay가 같은 방 재시작인지 새 방인지가
-- 미결정이라(SPEC §15-5), 지금 지우면 재시작이 깨진다. 정해지면 조건을 더한다.
create or replace function cleanup_stale_rooms(p_max_age interval default interval '24 hours')
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_count int;
begin
  delete from rooms where created_at < now() - p_max_age;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

------------------------------------------------------------------------------
-- 권한 — I9
------------------------------------------------------------------------------
-- ★ 함수는 기본으로 PUBLIC에게 execute가 열린다. 게다가 Supabase는 public 스키마의
--   새 함수에 anon·authenticated execute를 자동으로 깔아준다(alter default privileges).
--   security definer 함수라 anon이 부르면 **RLS를 통째로 우회한다** — 누구나 남의 방
--   페이즈를 넘길 수 있다는 뜻이다. RLS로는 못 막는다.
--
--   PUBLIC에서 회수하는 것만으로는 anon에게 준 명시적 권한이 없어지지 않는다.
--   anon·authenticated를 따로 적어야 한다. 전부 닫고 service role만 남긴다.
--   클라이언트는 /api/phase/advance를 거친다 (I9, SPEC §17.4).
revoke all on function server_now()                             from public, anon, authenticated;
revoke all on function next_phase(text, int)                    from public, anon, authenticated;
revoke all on function phase_duration(text)                     from public, anon, authenticated;
revoke all on function early_exit_met(uuid, text, int)          from public, anon, authenticated;
-- ★ resolve_vote 는 사람 표 집계를 RLS 우회로 읽는다. anon 이 부르면 reveal 전에
--   판세가 샌다. internal 전용이라 service_role 에도 명시 grant 를 주지 않는다
--   (advance_phase 가 definer 로 부른다).
revoke all on function resolve_vote(uuid, text, uuid[])         from public, anon, authenticated;
revoke all on function pick_bot_line(text)                      from public, anon, authenticated;
revoke all on function on_enter_phase(uuid, text, int, timestamptz) from public, anon, authenticated;
revoke all on function advance_phase(uuid, int, uuid)           from public, anon, authenticated;
revoke all on function advance_expired_rooms(int)               from public, anon, authenticated;
revoke all on function cleanup_stale_rooms(interval)            from public, anon, authenticated;
revoke all on function bump_roster_seq()                        from public, anon, authenticated;

grant execute on function server_now()                          to service_role;
grant execute on function advance_phase(uuid, int, uuid)        to service_role;
grant execute on function advance_expired_rooms(int)            to service_role;
grant execute on function cleanup_stale_rooms(interval)         to service_role;

------------------------------------------------------------------------------
-- pg_cron — SPEC §12.1
------------------------------------------------------------------------------
-- Supabase 대시보드에서 pg_cron 확장을 먼저 켜야 할 수 있다 (Database → Extensions).
--
-- 전체를 예외로 감싼다. pg_cron이 없는 로컬 Postgres에서도 이 파일이 끝까지 돌아야
-- 상태머신을 테스트할 수 있기 때문이다. 실패하면 경고만 내고 넘어간다.
-- ★ 배포 DB에서는 이 경고를 그냥 넘기지 않는다 — 워치독이 없으면 방이 멈춘다 (SPEC §12.1).
do $$
begin
  execute 'create extension if not exists pg_cron';

  -- 같은 이름의 job이 있으면 지우고 다시 건다 (이 파일도 여러 번 돌 수 있어야 한다)
  begin perform cron.unschedule('phase-watchdog'); exception when others then null; end;
  begin perform cron.unschedule('room-cleanup');   exception when others then null; end;

  perform cron.schedule('phase-watchdog', '15 seconds', 'select advance_expired_rooms();');
  perform cron.schedule('room-cleanup',   '0 * * * *',  'select cleanup_stale_rooms();');
  raise notice 'pg_cron 워치독 등록 완료 (15초 주기)';
exception when others then
  raise warning 'pg_cron 설정 실패: % — 배포 DB라면 대시보드에서 pg_cron을 켜고 이 파일을 다시 돌릴 것 (SPEC §12.1)', sqlerrm;
end $$;

-- 확인:
--   select jobname, schedule, active from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 10;
