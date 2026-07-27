-- 사람인 척 (whois-human) — RLS
-- SPEC §7. 소유: A
--
-- 이 게임에서 RLS는 보안이 아니라 게임 규칙이다. 뚫리면 게임이 성립하지 않는다.
--
-- ┌─ 전제 ────────────────────────────────────────────────────────────────┐
-- │ 익명 플레이라 Supabase Auth를 쓰지 않는다. 따라서 DB는 "지금 이 요청이  │
-- │ 어느 player인지"를 알 수 없다. SPEC §7의 "본인 답변은 항상 허용",       │
-- │ "insert는 본인 것만"은 현재 구조로는 표현할 수 없다.                    │
-- │                                                                       │
-- │ 결론: 클라이언트는 읽기만 한다. 모든 쓰기는 service_role을 쥔 서버      │
-- │ (Route Handler / Edge Function)를 거치고, 거기서 player_id를 검증한다. │
-- │ RLS는 "읽으면 안 되는 것"만 막는 역할로 좁힌다.                        │
-- │                                                                       │
-- │ TODO(A): 익명 인증(auth.signInAnonymously)을 붙이면 players에          │
-- │ user_id 컬럼을 추가해 본인 판별을 DB로 내릴 수 있다. types.ts 변경을   │
-- │ 동반하므로 팀 공지 후 진행할 것.                                       │
-- └───────────────────────────────────────────────────────────────────────┘

alter table rooms        enable row level security;
alter table players      enable row level security;
alter table player_roles enable row level security;
alter table questions    enable row level security;
alter table answers      enable row level security;
alter table messages     enable row level security;
alter table votes        enable row level security;
alter table agent_logs   enable row level security;

-- 정책이 하나도 없는 테이블 = 전면 거부. service_role만 통과한다.
-- player_roles, agent_logs는 의도적으로 정책을 만들지 않는다.
-- (SPEC §7: 역할은 reveal 시점에 Edge Function이 계산해 반환한다)

------------------------------------------------------------------------------
-- players — is_bot 차단
------------------------------------------------------------------------------
-- SPEC §7: is_bot이 클라이언트로 새어나가면 게임이 즉시 끝난다.
-- 테이블 접근 자체를 끊고, is_bot을 뺀 뷰만 노출한다.
revoke all on players from anon, authenticated;

create view public_players
with (security_invoker = off) as
  select id, room_id, nickname, mask_id, seat, connected, created_at
  from players;

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
-- rooms — 코드로 방을 찾아야 하므로 읽기는 열어둔다
------------------------------------------------------------------------------
create policy rooms_select on rooms
  for select to anon, authenticated
  using (true);

------------------------------------------------------------------------------
-- questions — 방에 들어온 이상 질문은 보여야 한다
------------------------------------------------------------------------------
create policy questions_select on questions
  for select to anon, authenticated
  using (true);

------------------------------------------------------------------------------
-- answers / messages — visible_at 게이팅
------------------------------------------------------------------------------
-- 남의 답변을 제출 전에 훔쳐보는 걸 막는다.
--
-- 주의: Postgres Changes는 배달 시점에 RLS를 평가하므로, visible_at이 미래인
-- 행은 구독자에게 아예 전달되지 않는다. 그래서 SPEC §6의 "미래 레코드를 받아
-- 두고 그 시각에 렌더" 방식이 이 정책과 충돌한다.
--
-- 해결: 답변·채팅은 SPEC §6.1대로 Broadcast로 배달한다. 트리거가 쏘는
-- 페이로드에는 visible_at이 실려 있고 클라이언트가 그 시각에 렌더한다.
-- 아래 select 정책은 재접속·새로고침 시의 백필 경로에만 적용된다.
create policy answers_select on answers
  for select to anon, authenticated
  using (visible_at <= now());

create policy messages_select on messages
  for select to anon, authenticated
  using (visible_at <= now());

------------------------------------------------------------------------------
-- votes — reveal 이후에만
------------------------------------------------------------------------------
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
-- 검증 (SPEC §7) — anon 키로 직접 뚫어본다. 이 기록이 기술 문서 근거가 된다.
------------------------------------------------------------------------------
-- 아래는 전부 0행 또는 에러여야 한다.
--   select * from player_roles;
--   select is_bot from players;
--   select * from players;
--   select * from answers where visible_at > now();
--   select * from votes;                      -- reveal 이전 방에서
--   select * from agent_logs;
