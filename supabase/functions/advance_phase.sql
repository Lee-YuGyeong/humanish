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
    when 'vote'   then phase := 'reveal'; round := p_round;
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
    -- 30초다. 60초면 나머지 넷이 멍하니 기다린다. 특히 대상이 봇이면 조기 종료가
    -- 없어서(early_exit_met 참고) 매번 꽉 채운다. 답을 씹는 시간은 뒤의 chat이 맡는다.
    when 'target'   then interval '30 seconds'
    when 'chat'     then interval '120 seconds'
    when 'vote'     then interval '30 seconds'
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
  v_target uuid;
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

  elsif p_phase = 'target' then
    select q.target_id into v_target
      from questions q
     where q.room_id = p_room_id and q.kind = 'target'
     order by q.round desc limit 1;
    if v_target is null then return false; end if;

    -- ★ 대상이 봇이면 조기 종료하지 않는다 (SPEC §5.3, §17).
    --   봇은 진입 즉시 답변이 생기므로, 그대로 두면 60초짜리 페이즈가 0초에 끝나고
    --   그것만으로 대상이 봇임이 드러난다. I5와 같은 함정인데 I5 문장으로는 안 걸린다.
    if (select is_bot from players where id = v_target) then
      return false;
    end if;

    return exists (
      select 1 from answers a join questions q on q.id = a.question_id
       where q.room_id = p_room_id and q.kind = 'target' and a.player_id = v_target
    );

  elsif p_phase = 'vote' then
    select count(*) into v_done
      from votes v join players p on p.id = v.voter_id
     where v.room_id = p_room_id and not p.is_bot;
    return v_done >= v_humans;
  end if;

  -- lobby / chat / reveal / replay — 조기 종료 없음 (chat은 시간 만료만, SPEC §5.1)
  return false;
end;
$$;

------------------------------------------------------------------------------
-- 문구 뽑기 — SPEC §17.2
------------------------------------------------------------------------------
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
begin
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
    insert into answers (question_id, room_id, player_id, text, visible_at)
    select v_qid, p_room_id, p.id, pick_bot_line('question'), p_ends_at
      from players p
     where p.room_id = p_room_id and p.is_bot
    on conflict (question_id, player_id) do nothing;

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
      insert into answers (question_id, room_id, player_id, text, visible_at)
      values (v_qid, p_room_id, v_target, pick_bot_line('target'), p_ends_at)
      on conflict do nothing;
    end if;

  elsif p_phase = 'vote' then
    -- 봇 투표. 자기 아닌 사람 중 하나.
    insert into votes (room_id, voter_id, target_id, reason)
    select p_room_id, b.id,
           (select p2.id from players p2
             where p2.room_id = p_room_id and p2.id <> b.id
             order by random() limit 1),
           pick_bot_line('vote')
      from players b
     where b.room_id = p_room_id and b.is_bot
    on conflict (room_id, voter_id) do nothing;

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
  v_room    rooms%rowtype;
  v_next    record;
  v_ends_at timestamptz;
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
      -- 역할 배정은 TS(assignRoles, SPEC §8)라 DB가 못 한다.
      -- /api/room/start가 봇을 채우고 역할을 넣은 뒤에 이 함수를 부른다.
      if not exists (select 1 from player_roles where room_id = p_room_id) then
        raise exception '역할이 배정되지 않았다 — /api/room/start를 거칠 것 (SPEC §8)';
      end if;
    end if;
  end if;

  -- 4. 다음 페이즈 계산
  select * into v_next from next_phase(v_room.phase, v_room.round);
  v_ends_at := case
    when phase_duration(v_next.phase) is null then null
    else now() + phase_duration(v_next.phase)
  end;

  update rooms
     set phase         = v_next.phase,
         round         = v_next.round,
         phase_seq     = phase_seq + 1,
         phase_ends_at = v_ends_at
   where id = p_room_id;

  -- 5. 진입 훅 (SPEC §5.3). 같은 트랜잭션이라 훅이 실패하면 전환도 통째로 롤백된다.
  perform on_enter_phase(p_room_id, v_next.phase, v_next.round, v_ends_at);

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
