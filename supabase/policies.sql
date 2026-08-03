-- 사람인 척 (whois-human) — RLS
-- SPEC §7, §17. 소유: A
--
-- 이 게임에서 RLS는 보안이 아니라 게임 규칙이다. 뚫리면 게임이 성립하지 않는다.
-- 이 파일도 여러 번 돌려도 된다.
--
-- ┌─ 전제 ────────────────────────────────────────────────────────────────┐
-- │ 익명 플레이라 Supabase Auth를 쓰지 않는다. 따라서 DB는 "지금 이 요청이  │
-- │ 어느 player인지"를 알 수 없다. "본인 답변은 항상 허용", "insert는 본인  │
-- │ 것만"은 현재 구조로는 표현할 수 없다.                                   │
-- │                                                                       │
-- │ 결론: 클라이언트는 읽기만 한다. 모든 쓰기는 service_role을 쥔 서버      │
-- │ (Route Handler)를 거치고, 거기서 쿠키의 player_token으로 player_id를   │
-- │ 되찾는다 (SPEC §17.4). RLS는 "읽으면 안 되는 것"만 막는 역할로 좁힌다. │
-- └───────────────────────────────────────────────────────────────────────┘
--
-- ┌─ 익명 인증이 붙은 뒤에도 위 전제는 그대로다 (SPEC §15-2-결정) ─────────┐
-- │ auth.uid()를 쓰는 정책은 **새로 만든 profiles 하나뿐**이다.            │
-- │ rooms · players · answers · messages · votes 의 정책은 한 줄도 안      │
-- │ 바꿨다. 방 안의 본인 확인은 여전히 player_token이 한다 (§17.4).        │
-- │                                                                       │
-- │ 왜 안 바꾸는가: Realtime Postgres Changes는 **배달 시점에** RLS를      │
-- │ 평가한다. rooms에 auth.uid() 조건을 걸면 토큰이 없거나 만료된 순간     │
-- │ 이벤트가 **에러 없이 아무에게도 안 간다.** 방이 통째로 멈춘다 (§7.3).  │
-- │ 방 격리를 DB로 내리는 것은 여전히 별도 결정이다 (§15-6).               │
-- │                                                                       │
-- │ 기존 정책이 전부 `to anon, authenticated` 라서 로그인한 사용자로       │
-- │ 바뀌어도 읽기가 하나도 안 깨진다. 이 파일에서 그게 지켜져야 한다 —     │
-- │ 새 정책에 authenticated를 빠뜨리면 로그인한 사람만 화면이 빈다.        │
-- └───────────────────────────────────────────────────────────────────────┘

alter table rooms         enable row level security;
alter table players       enable row level security;
alter table profiles      enable row level security;
alter table match_results enable row level security;
alter table player_roles  enable row level security;
alter table questions     enable row level security;
alter table answers       enable row level security;
alter table messages      enable row level security;
alter table votes         enable row level security;
alter table agent_logs    enable row level security;
alter table question_pool enable row level security;
alter table bot_line_pool enable row level security;
alter table world_agent_logs enable row level security;

-- 정책이 하나도 없는 테이블 = 전면 거부. service_role만 통과한다.
-- player_roles, agent_logs, question_pool, bot_line_pool, world_agent_logs는
-- 의도적으로 정책을 만들지 않는다.
--
-- 문구 풀을 막는 이유는 보안이 아니라 게임이다 (I1). 봇 문구 풀을 읽을 수 있으면
-- 채팅을 풀과 대조해서 봇을 즉시 특정할 수 있다. is_bot을 가린 의미가 없어진다.
revoke all on question_pool from anon, authenticated;
revoke all on bot_line_pool from anon, authenticated;
revoke all on player_roles  from anon, authenticated;
revoke all on agent_logs    from anon, authenticated;
-- 월드 AI가 실제로 한 말이 방·시각과 함께 들어 있다. 채팅과 대조하면 봇이 특정된다.
revoke all on world_agent_logs from anon, authenticated;

------------------------------------------------------------------------------
-- players — is_bot 차단
------------------------------------------------------------------------------
-- SPEC §7.2: is_bot이 클라이언트로 새어나가면 게임이 즉시 끝난다.
-- 테이블 접근 자체를 끊고, 안전한 컬럼만 고른 뷰를 노출한다.
revoke all on players from anon, authenticated;

-- ★ 뷰에서 뺄 것은 is_bot만이 아니다 (SPEC §7.2)
--   created_at — 봇은 게임 시작 순간 한꺼번에 만들어져 생성 시각이 몇 ms 안에 뭉친다.
--                사람은 몇 분에 걸쳐 들어온다. 이거 하나로 봇이 전부 특정된다.
--   token      — 본인 확인용 비밀값 (SPEC §17.4)
--
-- Omit이 아니라 **넣을 컬럼을 하나씩 적는다.** players에 컬럼이 늘어도 자동으로
-- 새어나가지 않게 하려는 것이다. 컬럼을 더할 때마다 "이걸로 봇을 골라낼 수 있나"를 묻는다.
--
-- security_invoker = off 는 "뷰를 소유자 권한으로 실행한다"는 뜻이다. 그래야 anon에게서
-- revoke한 players를 뷰가 대신 읽어줄 수 있다. Postgres 14 이하에는 이 옵션 자체가 없고
-- (원래 그게 유일한 동작이었다) Supabase는 15 이상이라 명시해둔다.
-- 버전을 나누는 이유는 로컬 Postgres에서도 이 파일이 돌아야 §14.2 침투 테스트를
-- Supabase 없이 해볼 수 있기 때문이다.
-- ★ 대기방 값(is_ready · lobby_line · lobby_name)은 **phase = 'lobby' 일 때만** 내려준다.
--
--   시작하면 shuffle_seats 가 네 컬럼을 다 비우므로 원래는 이 조건 없이도 안전하다.
--   그런데 그건 "지우는 코드가 반드시 돈다"에 기대는 안전이고, I1 은 한 번 새면
--   게임이 그 자리에서 끝난다. 지우기가 빠져도 뷰에서 다시 막히도록 두 겹으로 둔다.
--
--   왜 위험한가: 대기방에는 사람만 있다(봇은 fill_with_bots 로 시작할 때 앉는다).
--   그래서 발화·준비 상태가 게임까지 따라가면 **값이 있는 자리 = 사람**이 되어
--   봇 명단이 통째로 드러난다.
--
--   ☐ §15-3 에 "봇을 로비에서 채우는 안"이 열려 있다. 그쪽으로 가면 봇도 이 값을
--     사람처럼 채워야 한다 — 준비 완료를 봇만 즉시 누르면 그게 곧 정답이다.
drop view if exists public_players;
do $$
declare v_cols constant text :=
  'select p.id, p.room_id, p.nickname, p.mask_id, p.seat, p.connected,
          case when r.phase = ''lobby'' then p.is_ready else false end as is_ready,
          case when r.phase = ''lobby'' then p.lobby_line end as lobby_line,
          case when r.phase = ''lobby'' then p.lobby_line_at end as lobby_line_at,
          case when r.phase = ''lobby'' then p.lobby_name end as lobby_name
     from players p join rooms r on r.id = p.room_id';
begin
  if current_setting('server_version_num')::int >= 150000 then
    execute 'create view public_players with (security_invoker = off) as ' || v_cols;
  else
    execute 'create view public_players as ' || v_cols;
  end if;
end $$;

grant select on public_players to anon, authenticated;

-- 뷰가 방으로 스코프되지 않는다. where 절 없이 긁으면 전체 방의 닉네임·좌석이 보인다.
-- 아래 answers/messages/questions/rooms 정책도 마찬가지로 방 조건이 없다. 의도된 상태다.
--
-- 헤더나 GUC로 방 id를 넘겨 정책에 쓰는 방법은 쓰지 않는다. Realtime Postgres Changes는
-- 배달 시점에 RLS를 평가하는데 그 경로에는 REST 요청 헤더가 없다. rooms·players에
-- 그런 정책을 걸면 실시간 이벤트가 아무에게도 배달되지 않는다 (SPEC §7.3).
--
-- 방 격리는 클라이언트 계약으로 유지한다 — 모든 구독·쿼리에 방 필터 (SPEC §6.3, I10).
-- DB로 강제하려면 익명 인증이 선행돼야 한다 (SPEC §15-2, §15-6).

------------------------------------------------------------------------------
-- 읽기 권한 — RLS보다 먼저 통과해야 하는 관문
------------------------------------------------------------------------------
-- RLS 정책은 **grant가 있는 위에서만** 의미가 있다. grant가 없으면 정책과 무관하게
-- "permission denied"다. Supabase는 public 스키마 테이블에 anon/authenticated 기본
-- grant를 깔아주지만, 그 암묵적 동작에 기대면 이 파일만으로는 재현되지 않는다.
-- 로컬 Postgres에 그대로 적용하면 클라이언트가 아무것도 못 읽는 게임이 된다.
--
-- ★ 반드시 revoke를 먼저 한다.
--   Supabase는 public 스키마의 새 테이블에 anon·authenticated 권한을 자동으로 깔아준다
--   (alter default privileges). 그래서 아무것도 안 하면 anon이 insert·update·delete까지
--   갖는다. RLS에 해당 정책이 없어 실제 쓰기는 막히지만, 권한을 남겨둘 이유가 없다.
--   PUBLIC에서 회수하는 것으로는 anon에게 준 명시적 권한이 없어지지 않는다 — 따로 적는다.
--
-- select만 준다. 쓰기는 전부 service role 서버를 거친다 (I9).
revoke all on rooms, questions, answers, messages, votes from anon, authenticated;
grant select on rooms, questions, answers, votes to anon, authenticated;
-- messages는 테이블을 주지 않는다. 아래 public_messages 뷰만 준다.

------------------------------------------------------------------------------
-- messages — created_at을 가리고 visible_at을 뷰에서 강제한다
------------------------------------------------------------------------------
-- ★ created_at이 봇을 드러낸다. 봇 메시지는 타이핑 지연 때문에 created_at보다
--   visible_at이 몇 초 뒤다. 사람 메시지는 둘이 같다. 그 간격만 보면 봇이 갈린다 (I1).
--   public_players에서 created_at을 뺀 것과 같은 이유다 (§7.2).
--
-- ★ 필터를 뷰 안에 박는다. RLS 정책으로 거는 것과 결과는 같지만, 이쪽은 컬럼을
--   고르는 일과 행을 고르는 일이 한 군데 모여 있어 빠뜨리기 어렵다.
--
-- 이 뷰는 방으로 스코프되지 않는다. 클라이언트가 .eq('room_id', ...)를 걸어야 한다 (I10).
drop view if exists public_messages;
do $$
declare v_sql constant text :=
  'select id, room_id, player_id, text, visible_at from messages where visible_at <= now()';
begin
  if current_setting('server_version_num')::int >= 150000 then
    execute 'create view public_messages with (security_invoker = off) as ' || v_sql;
  else
    execute 'create view public_messages as ' || v_sql;
  end if;
end $$;

grant select on public_messages to anon, authenticated;

------------------------------------------------------------------------------
-- rooms — 코드로 방을 찾아야 하므로 읽기는 열어둔다
------------------------------------------------------------------------------
drop policy if exists rooms_select on rooms;
create policy rooms_select on rooms
  for select to anon, authenticated
  using (true);

------------------------------------------------------------------------------
-- questions — 방에 들어온 이상 질문은 보여야 한다
------------------------------------------------------------------------------
drop policy if exists questions_select on questions;
create policy questions_select on questions
  for select to anon, authenticated
  using (true);

------------------------------------------------------------------------------
-- answers / messages — visible_at 게이팅
------------------------------------------------------------------------------
-- 남의 답변을 제출 전에 훔쳐보는 걸 막는다.
--
-- 주의: Postgres Changes는 배달 시점에 RLS를 평가하므로, visible_at이 미래인
-- 행은 구독자에게 아예 전달되지 않는다. 그래서 "미래 레코드를 받아두고 그 시각에
-- 렌더"하는 방식은 Postgres Changes로 못 한다 (SPEC §6.1).
--
-- 답변은 아예 실시간으로 쏘지 않는다. 페이즈가 넘어가면 rooms 구독이 알려주고,
-- 그때 클라이언트가 다시 읽는다. 채팅(Broadcast)은 SPEC §13-6에서 붙인다.
drop policy if exists answers_select on answers;
create policy answers_select on answers
  for select to anon, authenticated
  using (visible_at <= now());

drop policy if exists messages_select on messages;
create policy messages_select on messages
  for select to anon, authenticated
  using (visible_at <= now());

------------------------------------------------------------------------------
-- votes — reveal 이후에만
------------------------------------------------------------------------------
drop policy if exists votes_select on votes;
create policy votes_select on votes
  for select to anon, authenticated
  using (
    exists (
      select 1 from rooms r
      where r.id = votes.room_id
        and r.phase in ('reveal', 'replay')
    )
  );

------------------------------------------------------------------------------
-- profiles — 본인 것만. auth.uid()를 쓰는 유일한 정책이다 (SPEC §15-2-결정)
------------------------------------------------------------------------------
-- ★ anon에게는 아예 주지 않는다. 로그인하지 않은 사람이 남의 표시 이름을 훑을
--   이유가 없다. 랭킹 화면은 나중에 집계 뷰(leaderboard)로 따로 연다 —
--   거기에는 room_id도 user_id도 없어서 계정과 방이 이어지지 않는다.
--
-- ★ 쓰기 권한은 authenticated에게도 주지 않는다 (I9). 프로필을 만드는 곳은
--   구글 연결 콜백(app/api/auth/callback) 하나뿐이고 service role로 쓴다.
--   열어두면 남이 자기 display_name을 20자 아무 문자열로 바꿔 랭킹을 어지럽힌다.
--
-- ★ profiles는 Realtime publication에 넣지 않는다. 넣는 순간 이 정책이
--   배달 시점에 평가되기 시작하고, §7.3의 함정이 여기까지 따라온다.
revoke all on profiles from anon, authenticated;
grant select on profiles to authenticated;

drop policy if exists profiles_select_own on profiles;
create policy profiles_select_own on profiles
  for select to authenticated
  using (auth.uid() = user_id);

------------------------------------------------------------------------------
-- match_results — 본인 것만. profiles와 같은 모양이다 (SPEC §15-2-결정)
------------------------------------------------------------------------------
-- ★ **여기서 방 세계가 새면 I1이 깨진다.** 한 행에 room_id 와 role 이 같이 있어서,
--   남의 행을 읽을 수 있으면 "그 방에서 누가 스파이였나"가 나온다. 게다가 한 방의
--   행 수를 세면 **사람이 몇이었는지**가 나오고, 정원에서 빼면 봇 수가 나온다.
--   그래서 anon 에게는 권한 자체를 주지 않고, authenticated 에게는 자기 행만 연다.
--
-- ★ 쓰기는 아무에게도 열지 않는다 (I9). 적는 곳은 /api/reveal 하나뿐이고
--   service role 로 쓴다. 열어두면 자기 전적을 직접 적어 랭킹을 만들 수 있다.
--
-- ★ Realtime publication 에 넣지 않는다. profiles 와 같은 이유다 (§7.3).
revoke all on match_results from anon, authenticated;
grant select on match_results to authenticated;

drop policy if exists match_results_select_own on match_results;
create policy match_results_select_own on match_results
  for select to authenticated
  using (auth.uid() = user_id);

------------------------------------------------------------------------------
-- 검증 (SPEC §14.2) — anon 키로 직접 뚫어본다. 이 기록이 기술 문서 근거가 된다.
------------------------------------------------------------------------------
-- 아래는 전부 0행 또는 에러여야 한다.
--   select * from player_roles;
--   select is_bot from players;
--   select * from players;
--   select * from answers where visible_at > now();
--   select * from votes;                       -- reveal 이전 방에서
--   select * from agent_logs;
--   select * from bot_line_pool;               -- 봇 문구 풀 (I1)
--   select * from question_pool;
--   select created_at from public_players;     -- 컬럼이 없어야 한다 (I1)
--   select token from public_players;          -- 컬럼이 없어야 한다
--   select user_id from public_players;        -- 컬럼이 없어야 한다 (I1, §15-2-결정)
--   select * from profiles;                    -- anon은 권한 자체가 없다
--   select * from profiles;                    -- 남으로 로그인한 상태에서 0행
--   select * from match_results;               -- anon은 권한 자체가 없다 (I1)
--   select * from match_results;               -- 남으로 로그인한 상태에서 0행
