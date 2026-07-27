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
-- │                                                                       │
-- │ 익명 인증(auth.signInAnonymously)은 여전히 미결정이다 (SPEC §15-2).    │
-- │ 붙이면 방 격리를 DB로 내릴 수 있다 (SPEC §7.3, §15-6).                 │
-- └───────────────────────────────────────────────────────────────────────┘

alter table rooms         enable row level security;
alter table players       enable row level security;
alter table player_roles  enable row level security;
alter table questions     enable row level security;
alter table answers       enable row level security;
alter table messages      enable row level security;
alter table votes         enable row level security;
alter table agent_logs    enable row level security;
alter table question_pool enable row level security;
alter table bot_line_pool enable row level security;

-- 정책이 하나도 없는 테이블 = 전면 거부. service_role만 통과한다.
-- player_roles, agent_logs, question_pool, bot_line_pool은 의도적으로 정책을 만들지 않는다.
--
-- 문구 풀을 막는 이유는 보안이 아니라 게임이다 (I1). 봇 문구 풀을 읽을 수 있으면
-- 채팅을 풀과 대조해서 봇을 즉시 특정할 수 있다. is_bot을 가린 의미가 없어진다.
revoke all on question_pool from anon, authenticated;
revoke all on bot_line_pool from anon, authenticated;
revoke all on player_roles  from anon, authenticated;
revoke all on agent_logs    from anon, authenticated;

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
drop view if exists public_players;
do $$
declare v_cols constant text :=
  'select id, room_id, nickname, mask_id, seat, connected from players';
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
-- select만 준다. 쓰기는 전부 service role 서버를 거친다 (I9).
grant select on rooms, questions, answers, messages, votes to anon, authenticated;

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
