-- 사람인 척 (whois-human) — 대기방 프리셋 발화 · 준비 상태
-- SPEC §5.1(lobby), §15-3-결정, §17.3. 소유: A
--
--   psql "$SUPABASE_DB_URL_DIRECT" -f supabase/functions/lobby.sql
--
-- ┌─ 무엇을 막는 함수인가 ────────────────────────────────────────────────────┐
-- │ 대기방은 자유 채팅을 열지 않는다. 문구 목록은 lib/server/lobby-lines.ts 에 │
-- │ 있고 라우트가 화이트리스트로 강제한다 (I9 — 쓰기는 전부 service role 서버).│
-- │                                                                          │
-- │ 여기서 보는 건 목록이 아니라 **조합**이다. 문구를 8개로 좁혀도 마음대로   │
-- │ 연타할 수 있으면 3비트짜리 통신 채널이 된다 — "ㅋㅋㅋ 두 번 = 나랑 짜자". │
-- │ 그래서 세 가지를 건다: 쿨다운 · 같은 문구 연속 금지 · 1인 총량.           │
-- │                                                                          │
-- │ ★ 목록을 DB 로 옮기지 않았다. 화이트리스트가 두 군데로 갈리면 한쪽만 아는 │
-- │   문구가 생긴다 — 이 저장소가 검사 목록으로 두 번 데인 것과 같은 모양이다.│
-- │   여기는 "얼마나 자주" 만 본다.                                           │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- ★ 발화를 messages 에 넣지 않는다. 대기방 발화가 player_id 와 함께 남으면
--   shuffle_seats 가 끊어놓은 "로비의 그 사람 ↔ 게임의 이 자리"가 되살아난다
--   (§15-3-결정의 '남는 구멍'과 같은 통로). 사람마다 현재 한 줄만 들고 있고,
--   시작할 때 shuffle_seats 가 비운다.
--
-- ★ 명단 신호(roster_seq)를 직접 올리지 않는다. players 를 update 하면
--   players_roster_bump 트리거가 이미 올린다 (schema.sql). 클라이언트는 그
--   신호를 보고 public_players 를 다시 읽는다 (§17.3) — 대기방 발화 전용
--   실시간 경로를 새로 깔 이유가 없다.

------------------------------------------------------------------------------
-- 프리셋 문구 하나를 말한다
------------------------------------------------------------------------------
-- p_text 는 라우트가 이미 화이트리스트로 검증한 값이다. 여기서 다시 보지 않는다.
--
-- ★ 방 행을 잠그고 시작한다. 잠그지 않으면 같은 사람이 두 탭에서 동시에 눌렀을 때
--   둘 다 쿨다운 검사를 통과한다.
create or replace function say_lobby_line(
  p_room_id      uuid,
  p_player_id    uuid,
  p_text         text,
  -- 기본값은 **폴백일 뿐이다.** 앱은 언제나 lib/server/lobby-lines.ts 의
  -- LOBBY_LINE_COOLDOWN_SEC 를 넘긴다 (lib/server/lobby.ts). 그쪽을 고치면 여기도 맞춘다.
  p_cooldown_sec int default 4,
  p_max_lines    int default 10
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prev    text;
  v_prev_at timestamptz;
  v_count   int;
begin
  perform 1 from rooms where id = p_room_id and phase = 'lobby' for update;
  if not found then
    raise exception '대기방에서만 말할 수 있다' using errcode = 'P0001';
  end if;

  select lobby_line, lobby_line_at, lobby_line_count
    into v_prev, v_prev_at, v_count
    from players
   where id = p_player_id and room_id = p_room_id
     for update;

  if not found then
    raise exception '이 방의 플레이어가 아니다' using errcode = 'P0001';
  end if;

  -- ┌─ 총량 상한: 0 이면 없다 (2026-08-07 사용자 지시 "제한 다 풀어") ───────┐
  -- │ 예전에는 1인 10회를 넘기면 거절했다. 대기방이 길어지면 멀쩡히 기다리던  │
  -- │ 사람이 **말을 못 하게 되는데**, 화면에는 그게 고장으로 보였다.          │
  -- │                                                                        │
  -- │ 인자는 남긴다. create or replace 로는 시그니처를 못 바꾸고              │
  -- │ (supabase/apply.sh 가 그걸로 올린다), checks.sh 도 이 시그니처를 본다.  │
  -- │ 그래서 **0 = 무제한**으로 두었다 — 되살리고 싶으면                      │
  -- │ lib/server/lobby-lines.ts 의 LOBBY_LINE_MAX 에 숫자만 넣으면 된다.      │
  -- │                                                                        │
  -- │ ★ lobby_line_count 는 계속 센다. 지금 아무도 안 보지만, 세는 걸 멈추면  │
  -- │   나중에 상한을 되살릴 때 이미 말한 횟수가 0부터 다시 시작한다.         │
  -- └────────────────────────────────────────────────────────────────────────┘
  if p_max_lines > 0 and v_count >= p_max_lines then
    raise exception '대기방에서 말할 수 있는 횟수를 다 썼다' using errcode = 'P0001';
  end if;

  -- 쿨다운. 시각은 전부 서버 now() 다 (I2).
  if v_prev_at is not null
     and v_prev_at > now() - make_interval(secs => p_cooldown_sec) then
    raise exception '너무 빠르다' using errcode = 'P0001';
  end if;

  -- ┌─ 같은 문구 연속 금지를 걷었다 (2026-08-07 사용자 지시) ────────────────┐
  -- │ 예전에는 v_prev 와 같으면 거절했다. 근거는 "연타가 곧 뜻이 된다" 였다 — │
  -- │ 문구가 8개면 3비트라 「ㅋㅋㅋ 두 번 = 나랑 짜자」 같은 약속이 성립한다.  │
  -- │                                                                        │
  -- │ 화면 쪽이 바뀌면서 이 규칙이 **고장으로 보이기 시작했다**: 말풍선이 3초 │
  -- │ 뒤 걷히는데(room-lobby.tsx 의 LOBBY_LINE_TTL_MS), 사라진 말을 다시      │
  -- │ 하려고 누르면 그 버튼만 영영 잠겨 있었다.                              │
  -- │                                                                        │
  -- │ ★ 총량 상한도 같은 날 걷혔다(아래 p_max_lines). 담합 부담을 지는 건     │
  -- │   이제 **쿨다운 하나뿐**이다 — lib/server/lobby-lines.ts 의             │
  -- │   LOBBY_LINE_COOLDOWN_SEC. 그것까지 0 으로 내리면 대기방이 사실상       │
  -- │   자유 채팅이 되고, 문구를 여덟 개로 좁혀둔 의미(SPEC §15-3-결정)가     │
  -- │   통째로 사라진다.                                                      │
  -- └────────────────────────────────────────────────────────────────────────┘

  update players
     set lobby_line       = p_text,
         lobby_line_at    = now(),
         lobby_line_count = lobby_line_count + 1
   where id = p_player_id;
end;
$$;

------------------------------------------------------------------------------
-- 준비 완료 토글
------------------------------------------------------------------------------
-- ★ 발화가 아니라 상태다. 좌석 카드에 붙고 말풍선으로 뜨지 않는다 —
--   채팅으로 흘리면 누르고 푸는 순서가 그대로 신호가 된다.
--
-- 총량(p_max_lines)에 세지 않는다. 준비를 켜고 끄는 건 진행에 필요한 동작이라
-- 횟수로 막으면 게임이 안 굴러간다. 대신 값이 그대로면 아무 일도 하지 않아서
-- 연타해도 roster_seq 가 튀지 않는다.
create or replace function set_lobby_ready(
  p_room_id   uuid,
  p_player_id uuid,
  p_ready     boolean
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform 1 from rooms where id = p_room_id and phase = 'lobby' for update;
  if not found then
    raise exception '대기방에서만 바꿀 수 있다' using errcode = 'P0001';
  end if;

  update players
     set is_ready = p_ready
   where id = p_player_id
     and room_id = p_room_id
     and is_ready is distinct from p_ready;
end;
$$;

------------------------------------------------------------------------------
-- 대기방 이름 — SPEC §15-2-결정
------------------------------------------------------------------------------
-- 로그인하지 않은 사람도 대기방에서 부를 이름을 정할 수 있다. 계정이 있으면
-- 앉을 때 이미 베껴져 있고(create_room · join_room), 여기서 고칠 수도 있다.
--
-- ★ **대기방에서만 바꾼다.** 게임이 시작되면 이 값은 shuffle_seats 가 지웠고,
--   phase 검사가 되살리는 것도 막는다. 게임 중에 이름이 붙으면 그 자리가
--   사람으로 확정된다 (I1).
--
-- ★ 이름을 비우는 것(null)도 허용한다. '익명N' 으로 돌아가고 싶을 수 있다.
create or replace function set_lobby_name(
  p_room_id   uuid,
  p_player_id uuid,
  p_name      text
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
begin
  perform 1 from rooms where id = p_room_id and phase = 'lobby' for update;
  if not found then
    raise exception '대기방에서만 이름을 바꿀 수 있다' using errcode = 'P0001';
  end if;

  -- 다듬는 일은 app/api/lobby/name 의 normalizeDisplayName 이 이미 했다.
  -- 여기 있는 건 그 경로를 타지 않은 호출을 위한 두 번째 겹이다.
  v_name := nullif(btrim(coalesce(p_name, '')), '');
  if v_name is not null and char_length(v_name) > 20 then
    raise exception '이름은 20자까지다' using errcode = 'P0001';
  end if;

  -- ★ 유니크 인덱스가 어차피 막지만, 23505 는 사용자에게 보여줄 문장이 안 된다.
  --   방을 잠근 채로 먼저 물어보고 P0001 로 바꿔 던진다 (create_room 의 정원과 같은 방식).
  if v_name is not null and exists (
    select 1 from players
     where room_id = p_room_id
       and id <> p_player_id
       and lower(lobby_name) = lower(v_name)
  ) then
    raise exception '이 방에 이미 그 이름을 쓰는 사람이 있다' using errcode = 'P0001';
  end if;

  update players
     set lobby_name = v_name
   where id = p_player_id
     and room_id = p_room_id
     and lobby_name is distinct from v_name;
end;
$$;

------------------------------------------------------------------------------
-- 권한 — I9
------------------------------------------------------------------------------
-- Supabase는 새 함수에 anon execute를 자동으로 깔아준다. security definer라
-- 그대로 두면 anon이 남의 대기방에 말풍선을 띄운다. 명시해서 회수한다.
revoke all on function say_lobby_line(uuid, uuid, text, int, int) from public, anon, authenticated;
revoke all on function set_lobby_ready(uuid, uuid, boolean)       from public, anon, authenticated;
revoke all on function set_lobby_name(uuid, uuid, text)           from public, anon, authenticated;

grant execute on function say_lobby_line(uuid, uuid, text, int, int) to service_role;
grant execute on function set_lobby_ready(uuid, uuid, boolean)       to service_role;
grant execute on function set_lobby_name(uuid, uuid, text)           to service_role;
