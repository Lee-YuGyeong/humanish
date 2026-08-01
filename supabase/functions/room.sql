-- 사람인 척 (whois-human) — 방 생성 · 입장 · 봇 채우기
-- SPEC §13-1, §16.4, §17.4, §17.6. 소유: A
--
--   psql "$SUPABASE_DB_URL_DIRECT" -f supabase/functions/room.sql
--
-- ┌─ 왜 SQL인가 ───────────────────────────────────────────────────────────┐
-- │ 좌석 배정에 경쟁 조건이 있다. "빈 자리를 읽고 → 거기 앉힌다"를 두 번의  │
-- │ 왕복으로 하면 두 사람이 같은 자리를 고른다. unique(room_id, seat)가     │
-- │ 걸러주긴 하지만 그때마다 재시도를 돌아야 한다.                          │
-- │ 한 함수 안에서 방을 잠그고 자리를 고르면 그 왕복이 사라진다.            │
-- │                                                                       │
-- │ supabase-js는 PostgREST라 raw SQL을 못 보낸다. RPC로 부른다.           │
-- └───────────────────────────────────────────────────────────────────────┘

-- 정원을 안 고르고 방을 만들 때 쓰는 기본값. lib/server/room.ts의 DEFAULT_ROOM_CAPACITY와
-- 같아야 한다. 하한 3 · 상한 8은 rooms.capacity 체크 제약이 진짜 기준이다.
create or replace function default_room_capacity() returns int
language sql immutable as $$ select 5 $$;

-- ★ 옛 room_capacity()(인자 없음)를 먼저 지운다. create or replace로는 인자 목록을
--   바꿀 수 없고, 남겨두면 이름이 겹쳐 아래 revoke 줄이 어느 쪽인지 모호해진다.
drop function if exists room_capacity();

-- 그 방의 정원. 정원은 이제 상수가 아니라 방마다 다르다 (SPEC §17.6, rooms.capacity 3~8).
-- rooms를 읽어야 하므로 security definer다. 값이 바뀔 수 있으니 immutable이 아니라 stable.
create or replace function room_capacity(p_room_id uuid) returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$ select capacity from rooms where id = p_room_id $$;

------------------------------------------------------------------------------
-- 빈 자리 하나를 무작위로 고른다 — SPEC §17.4
------------------------------------------------------------------------------
-- ★ 순서대로 채우지 않는다. 앞자리부터 채우면 나중에 들어온 봇이 늘 뒷자리·뒷번호에
--   몰려서, seat만 보고 봇을 골라낼 수 있다 (I1).
create or replace function pick_free_seat(p_room_id uuid)
returns int
language sql
security definer
set search_path = public, pg_temp
as $$
  select s
    from generate_series(1, room_capacity(p_room_id)) s
   where not exists (
     select 1 from players p where p.room_id = p_room_id and p.seat = s
   )
   order by random()
   limit 1;
$$;

------------------------------------------------------------------------------
-- 방 만들기 — 방장이 첫 자리에 앉는다
------------------------------------------------------------------------------
-- 코드 충돌은 unique 제약(23505)으로 튄다. 재시도는 호출자(lib/server/room.ts)가
-- 다른 코드로 최대 5회 한다 (SPEC §16.4).
--
-- ★ 인자가 늘 때마다 옛 시그니처를 지운다. create or replace로는 인자 목록을 바꿀 수
--   없고, 안 지우면 옛 것이 남아 새 호출과 이름이 겹친다(오버로드 모호성).
--   지운 목록은 supabase/checks.sh가 "옛 create_room이 남아 있지 않다"로 다시 확인한다.
drop function if exists create_room(text);
drop function if exists create_room(text, int);
drop function if exists create_room(text, int, text);

create or replace function create_room(
  p_code text,
  p_capacity int default null,
  p_name text default null,
  -- 방을 만든 사람의 계정 (SPEC §15-2-결정). 없어도 방은 만들어진다 —
  -- 계정은 전적을 위한 것이지 입장 조건이 아니다.
  -- ★ 호출자가 준 값을 그대로 믿지 않는다. 이 자리에 오는 값은 라우트가
  --   쿠키 세션에서 되찾은 것이다 (app/api/room/route.ts). I9와 같은 규칙이다.
  p_user_id uuid default null
)
returns table (room_id uuid, player_id uuid, player_token text, seat int, nickname text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room   uuid;
  v_player uuid;
  v_seat   int;
  v_token  text;
  v_nick   text;
  v_cap    int;
  v_name   text;
begin
  v_cap := coalesce(p_capacity, default_room_capacity());

  -- rooms.capacity 체크 제약이 이미 막지만, 제약 위반은 23514로 튀어서 사용자에게
  -- 보여줄 문장이 안 된다. lib/server/room.ts가 P0001만 400으로 바꾼다.
  if v_cap < 3 or v_cap > 8 then
    raise exception '정원은 3~8명이다' using errcode = 'P0001';
  end if;

  /*
   * 방 제목. 다듬는 일은 lib/server/room.ts 의 normalizeRoomName 이 이미 했다 —
   * 여기 있는 건 그 경로를 타지 않은 호출(psql·다른 서비스)을 위한 두 번째 겹이다.
   *
   * ★ 공백만 들어오면 null 로 접는다. '' 를 넣으면 체크 제약(1자 이상)에 걸려
   *   23514로 죽는데, 그건 사용자에게 보여줄 문장이 아니다.
   */
  v_name := nullif(btrim(coalesce(p_name, '')), '');
  if v_name is not null and char_length(v_name) > 20 then
    raise exception '방 제목은 20자까지다' using errcode = 'P0001';
  end if;

  insert into rooms (code, capacity, name)
  values (upper(p_code), v_cap, v_name)
  returning id into v_room;

  v_seat := pick_free_seat(v_room);
  v_nick := '익명' || v_seat;

  insert into players (room_id, nickname, mask_id, seat, is_bot, user_id)
  values (v_room, v_nick, 'mask-' || lpad(v_seat::text, 2, '0'), v_seat, false, p_user_id)
  returning id, token into v_player, v_token;

  update rooms set host_id = v_player where id = v_room;

  return query select v_room, v_player, v_token, v_seat, v_nick;
end;
$$;

------------------------------------------------------------------------------
-- 입장
------------------------------------------------------------------------------
-- 인자가 늘었으므로 옛 시그니처를 지운다. 남겨두면 오버로드가 공존해서
-- PostgREST가 어느 쪽을 부를지 정하지 못하고 PGRST203으로 죽는다 (위 create_room 참고).
drop function if exists join_room(text);

create or replace function join_room(
  p_code text,
  -- 들어온 사람의 계정 (SPEC §15-2-결정). create_room의 p_user_id와 같은 규칙 —
  -- 라우트가 쿠키 세션에서 되찾아 넘긴다. 없으면 null이고 게임은 그대로 된다.
  p_user_id uuid default null
)
returns table (room_id uuid, player_id uuid, player_token text, seat int, nickname text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room   rooms%rowtype;
  v_player uuid;
  v_seat   int;
  v_token  text;
  v_nick   text;
begin
  -- 방을 잠근 채로 자리를 고른다. 두 사람이 같은 자리를 잡는 일이 없다.
  select * into v_room from rooms where code = upper(p_code) for update;
  if not found then
    raise exception '그런 방이 없다: %', upper(p_code) using errcode = 'P0002';
  end if;

  -- 시작한 방에는 못 들어간다. 역할이 이미 배정됐고 질문도 지나갔기 때문이다.
  if v_room.phase <> 'lobby' then
    raise exception '이미 시작된 방이다' using errcode = 'P0001';
  end if;

  -- pick_free_seat이 방의 capacity를 읽으므로 정원이 3이든 8이든 자동으로 맞는다.
  v_seat := pick_free_seat(v_room.id);
  if v_seat is null then
    raise exception '방이 꽉 찼다' using errcode = 'P0001';
  end if;
  v_nick := '익명' || v_seat;

  insert into players (room_id, nickname, mask_id, seat, is_bot, user_id)
  values (v_room.id, v_nick, 'mask-' || lpad(v_seat::text, 2, '0'), v_seat, false, p_user_id)
  returning id, token into v_player, v_token;

  return query select v_room.id, v_player, v_token, v_seat, v_nick;
end;
$$;

------------------------------------------------------------------------------
-- 나가기 — 마지막 사람이 나가면 방을 지운다
------------------------------------------------------------------------------
-- ┌─ 왜 나가는 김에 방까지 보나 ────────────────────────────────────────────┐
-- │ 아무도 없는 대기방은 목록에 계속 뜨고, 들어가 보면 혼자다. 방 코드도     │
-- │ 24시간(cleanup_stale_rooms) 동안 점유한다. "마지막 한 명이 나갔다"를     │
-- │ 알 수 있는 자리가 여기뿐이라, 자리를 빼는 것과 같은 트랜잭션에서 센다.   │
-- │                                                                        │
-- │ 방을 잠근 채로 센다. 안 잠그면 두 사람이 동시에 나갈 때 서로 상대를 세서 │
-- │ **둘 다 "아직 남아 있다"로 보고 빈 방이 남는다.**                       │
-- └────────────────────────────────────────────────────────────────────────┘
--
-- ★ 세는 것은 is_bot = false 뿐이다 (I5 와 같은 이유). 봇까지 세면 fill_with_bots 가
--   이미 돈 방은 사람이 다 나가도 "다섯 명 남았다"가 되어 영영 안 지워진다.
--
-- ★ lobby 에서만 자리를 뺀다. 게임 중 이탈 처리는 SPEC §15-4 미결정이다 —
--   행을 지우면 answers·votes 가 cascade 로 같이 사라져서 그 판의 집계가 어긋나고,
--   빈자리를 봇이 이어받을지 비워둘지도 아직 정하지 않았다. 정해지기 전까지 거절한다.
--
-- 방장이 나가면 남은 사람 중 가장 앞자리에게 넘긴다. 안 넘기면 host_id 가
-- 없는 사람을 가리켜 **그 방은 아무도 시작 버튼을 못 누른다**(advance_phase 가
-- actor = host_id 를 본다). host_id 가 봇을 가리키는 일은 생기지 않는다 —
-- 사람이 0이면 그 앞 분기에서 방이 통째로 사라진다.
create or replace function leave_room(p_room_id uuid, p_player_id uuid)
returns table (room_deleted boolean, new_host_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room   rooms%rowtype;
  v_humans int;
  v_host   uuid;
begin
  select * into v_room from rooms where id = p_room_id for update;

  -- 방이 이미 없다. 나가려던 사람 입장에서는 성공이다 (두 번 눌렀거나 정리가 먼저 돌았거나).
  if not found then
    return query select true, null::uuid;
    return;
  end if;

  if v_room.phase <> 'lobby' then
    raise exception '시작한 방에서는 자리를 뺄 수 없다' using errcode = 'P0001';
  end if;

  -- room_id 를 조건에 같이 건다. player_id 만 믿으면 남의 방 사람을 뺄 수 있다 (I9).
  delete from players where id = p_player_id and room_id = p_room_id;

  select count(*) into v_humans
    from players where room_id = p_room_id and is_bot = false;

  if v_humans = 0 then
    -- players·questions·answers·votes 는 전부 on delete cascade 다 (schema.sql).
    -- 봇만 남은 방도 여기서 같이 사라진다.
    delete from rooms where id = p_room_id;
    return query select true, null::uuid;
    return;
  end if;

  v_host := v_room.host_id;
  if v_host = p_player_id or v_host is null then
    select id into v_host
      from players
     where room_id = p_room_id and is_bot = false
     order by seat
     limit 1;
    update rooms set host_id = v_host where id = p_room_id;
  end if;

  -- 명단이 바뀐 신호(roster_seq)는 players 트리거가 이미 올렸다 (schema.sql).
  -- 여기서 또 올리지 않는다 — shuffle_seats 주석과 같은 이유다.
  return query select false, v_host;
end;
$$;

------------------------------------------------------------------------------
-- 빈 자리를 봇으로 채운다 — SPEC §17.4
------------------------------------------------------------------------------
-- 몇 명을 채웠는지는 클라이언트에 알리지 않는다. 반환값은 서버만 본다.
-- 자리는 pick_free_seat이 무작위로 고르므로 봇이 뒷자리에 몰리지 않는다.
-- pick_free_seat이 null을 줄 때까지 도는 구조라, 정원을 방에서 읽게 된 뒤에도 그대로 맞는다.
create or replace function fill_with_bots(p_room_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_seat  int;
  v_count int := 0;
begin
  perform 1 from rooms where id = p_room_id for update;

  loop
    v_seat := pick_free_seat(p_room_id);
    exit when v_seat is null;

    insert into players (room_id, nickname, mask_id, seat, is_bot)
    values (p_room_id, '익명' || v_seat, 'mask-' || lpad(v_seat::text, 2, '0'), v_seat, true);

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

------------------------------------------------------------------------------
-- 좌석 재배치 — SPEC §15-3-결정
------------------------------------------------------------------------------
-- ★ 대기실에서 본 정체가 게임까지 이어지는 것을 끊는다.
--
--   자리는 이미 무작위로 준다(pick_free_seat). 그런데 그것만으로는 부족하다 —
--   로비에 앉아 있던 사람은 **누가 언제 들어왔는지를 눈으로 봤다.** 익명4 → 익명1이
--   차례로 들어오는 걸 봤다면, 시작 후 남은 자리가 곧 봇이다. 자리를 무작위로 준 것과
--   무관하게 답이 통째로 새어나간다.
--
--   그래서 시작하는 순간 **전원(사람+봇)에게 자리·닉네임·가면을 한 번의 무작위 순열로
--   다시 배정한다.** 그러면 로비에서 기억한 이름이 게임 속 누구인지 붙일 수 없다.
--   봇 수를 공개하기로 한 것(§15-3)이 의미를 가지려면 이게 있어야 한다 —
--   수는 제약이어야지 답이면 안 된다.
--
--   닉네임은 '익명' || seat 이라 자리와 한 몸이다. 순열 하나로 셋이 같이 움직인다.
--
-- ☐ 남는 구멍: players.id 는 그대로다. public_players 가 id를 내려주므로(투표 대상
--   지정에 필요하다) 로비에서 devtools로 id를 적어둔 사람은 여전히 따라갈 수 있다.
--   막으려면 시작 시점에 행을 새로 발급해야 하는데, 토큰이 httpOnly 쿠키라 그 순간
--   접속해 있지 않은 사람에게 새 쿠키를 줄 수 없다. 지금 구조로는 불가능하다.
--
-- 반환값은 바꾼 인원 수. 서버만 본다.
create or replace function shuffle_seats(p_room_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  perform 1 from rooms where id = p_room_id for update;

  -- ★ (room_id, seat) 유니크를 이 트랜잭션 동안만 미룬다. 순열 도중에는 두 사람이
  --   잠깐 같은 자리를 갖는 순간이 반드시 생긴다. 커밋 시점에만 검사하면 된다.
  --   범위 밖 값으로 피신시키는 방법은 못 쓴다 — players_seat_check 에 걸린다.
  --   nickname 은 '익명' || seat 이라 자리와 한 몸이다. 둘을 같이 미룬다.
  set constraints players_room_seat_key, players_room_nickname_key deferred;

  with shuffled as (
    select
      p.id,
      row_number() over (order by random()) as new_seat
    from players p
    where p.room_id = p_room_id
  )
  -- ★ 대기방 흔적(발화·준비 상태)을 여기서 같이 지운다. 자리를 섞는 것과 같은 일이다 —
  --   둘 다 "대기실에서 본 정체가 게임까지 이어지는 것"을 끊는다.
  --
  --   지우지 않으면 봇만 lobby_line 이 null 이라 **값이 있는 자리 = 사람**이 되어
  --   봇 명단이 통째로 드러난다 (I1). 자리를 아무리 잘 섞어도 소용없다.
  --   public_players 도 lobby 일 때만 내려주지만(policies.sql) 두 겹으로 둔다.
  update players p
     set seat             = s.new_seat,
         nickname         = '익명' || s.new_seat,
         mask_id          = 'mask-' || lpad(s.new_seat::text, 2, '0'),
         is_ready         = false,
         lobby_line       = null,
         lobby_line_at    = null,
         lobby_line_count = 0
    from shuffled s
   where p.id = s.id;

  get diagnostics v_n = row_count;

  -- 명단 신호(roster_seq)는 **직접 올리지 않는다.** players 트리거가 행마다 이미 올린다
  -- (schema.sql). 여기서 또 올리면 한 번 섞을 때 인원 수 + 1 만큼 뛴다 — 값이 틀린 건
  -- 아니지만 "무엇이 몇 번 바뀌었나"를 읽을 수 없게 된다. 클라이언트는 값이 변했는지만
  -- 보므로(§17.3) 트리거 하나로 충분하다.

  return v_n;
end;
$$;

------------------------------------------------------------------------------
-- 권한 — I9
------------------------------------------------------------------------------
-- Supabase는 새 함수에 anon execute를 자동으로 깔아준다. security definer라
-- 그대로 두면 anon이 남의 방에 마음대로 사람을 앉힐 수 있다. anon·authenticated를
-- 명시해서 회수한다 (PUBLIC만 회수하면 안 없어진다).
--
-- ★ 위에서 인자를 늘렸으면 **여기 이름도 같이 늘린다.** 이 블록은 create_room 의
--   인자가 늘 때마다 두 번 다 빠뜨린 자리다. 증상이 조용하지 않다:
--     · 없는 시그니처에 revoke 를 걸면 그냥 에러가 아니라 **파일이 거기서 멈춘다.**
--       (`ERROR: function create_room(text, integer) does not exist`) 그 아래 grant 는
--       한 줄도 돌지 않아 새 함수가 service_role 권한을 못 받는다.
--     · 그래서 새 함수에는 Supabase 가 자동으로 깔아준 anon execute 가 남는다 — I9 구멍.
--   default 가 붙은 인자도 **선언된 대로 전부** 적어야 한다. create_room(text,int) 로는
--   create_room(text,int,text) 를 가리키지 못한다.
-- 옛 room_capacity() 처럼 아예 사라진 함수는 줄 자체를 지운다 (같은 이유로 에러다).
revoke all on function default_room_capacity()    from public, anon, authenticated;
revoke all on function room_capacity(uuid)        from public, anon, authenticated;
revoke all on function pick_free_seat(uuid)       from public, anon, authenticated;
revoke all on function create_room(text,int,text,uuid) from public, anon, authenticated;
revoke all on function join_room(text,uuid)       from public, anon, authenticated;
revoke all on function leave_room(uuid,uuid)      from public, anon, authenticated;
revoke all on function fill_with_bots(uuid)       from public, anon, authenticated;
revoke all on function shuffle_seats(uuid)        from public, anon, authenticated;

grant execute on function create_room(text,int,text,uuid) to service_role;
grant execute on function join_room(text,uuid)    to service_role;
grant execute on function leave_room(uuid,uuid)   to service_role;
grant execute on function fill_with_bots(uuid)    to service_role;
grant execute on function shuffle_seats(uuid)     to service_role;
