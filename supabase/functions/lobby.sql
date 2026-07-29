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
  p_cooldown_sec int default 3,
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

  if v_count >= p_max_lines then
    raise exception '대기방에서 말할 수 있는 횟수를 다 썼다' using errcode = 'P0001';
  end if;

  -- 쿨다운. 시각은 전부 서버 now() 다 (I2).
  if v_prev_at is not null
     and v_prev_at > now() - make_interval(secs => p_cooldown_sec) then
    raise exception '너무 빠르다' using errcode = 'P0001';
  end if;

  -- 같은 문구 연속 금지. 연타가 곧 뜻이 되는 걸 막는 자리다.
  -- is not distinct from 을 쓰는 이유 — 첫 발화는 v_prev 가 null 이라 = 로는 안 걸린다.
  if v_prev is not distinct from p_text then
    raise exception '같은 말을 연달아 보낼 수 없다' using errcode = 'P0001';
  end if;

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
-- 권한 — I9
------------------------------------------------------------------------------
-- Supabase는 새 함수에 anon execute를 자동으로 깔아준다. security definer라
-- 그대로 두면 anon이 남의 대기방에 말풍선을 띄운다. 명시해서 회수한다.
revoke all on function say_lobby_line(uuid, uuid, text, int, int) from public, anon, authenticated;
revoke all on function set_lobby_ready(uuid, uuid, boolean)       from public, anon, authenticated;

grant execute on function say_lobby_line(uuid, uuid, text, int, int) to service_role;
grant execute on function set_lobby_ready(uuid, uuid, boolean)       to service_role;
