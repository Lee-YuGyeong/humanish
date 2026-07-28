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
-- ★ 인자가 하나 늘었다. create or replace로는 인자 목록을 바꿀 수 없으므로 먼저 지운다.
--   안 지우면 옛 create_room(text)가 남아 새 호출과 이름이 겹친다.
drop function if exists create_room(text);

create or replace function create_room(p_code text, p_capacity int default null)
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
begin
  v_cap := coalesce(p_capacity, default_room_capacity());

  -- rooms.capacity 체크 제약이 이미 막지만, 제약 위반은 23514로 튀어서 사용자에게
  -- 보여줄 문장이 안 된다. lib/server/room.ts가 P0001만 400으로 바꾼다.
  if v_cap < 3 or v_cap > 8 then
    raise exception '정원은 3~8명이다' using errcode = 'P0001';
  end if;

  insert into rooms (code, capacity) values (upper(p_code), v_cap) returning id into v_room;

  v_seat := pick_free_seat(v_room);
  v_nick := '익명' || v_seat;

  insert into players (room_id, nickname, mask_id, seat, is_bot)
  values (v_room, v_nick, 'mask-' || lpad(v_seat::text, 2, '0'), v_seat, false)
  returning id, token into v_player, v_token;

  update rooms set host_id = v_player where id = v_room;

  return query select v_room, v_player, v_token, v_seat, v_nick;
end;
$$;

------------------------------------------------------------------------------
-- 입장
------------------------------------------------------------------------------
create or replace function join_room(p_code text)
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

  insert into players (room_id, nickname, mask_id, seat, is_bot)
  values (v_room.id, v_nick, 'mask-' || lpad(v_seat::text, 2, '0'), v_seat, false)
  returning id, token into v_player, v_token;

  return query select v_room.id, v_player, v_token, v_seat, v_nick;
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
  update players p
     set seat     = s.new_seat,
         nickname = '익명' || s.new_seat,
         mask_id  = 'mask-' || lpad(s.new_seat::text, 2, '0')
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
-- 시그니처가 바뀐 함수는 여기도 같이 고친다. 빠뜨리면 새 함수에 Supabase가 자동으로
-- 깔아준 anon execute가 그대로 남는다. 옛 room_capacity() · create_room(text)는
-- 위에서 drop 했으므로 줄 자체를 지운다 — 없는 함수에 revoke를 걸면 에러다.
revoke all on function default_room_capacity()    from public, anon, authenticated;
revoke all on function room_capacity(uuid)        from public, anon, authenticated;
revoke all on function pick_free_seat(uuid)       from public, anon, authenticated;
revoke all on function create_room(text, int)     from public, anon, authenticated;
revoke all on function join_room(text)            from public, anon, authenticated;
revoke all on function fill_with_bots(uuid)       from public, anon, authenticated;
revoke all on function shuffle_seats(uuid)        from public, anon, authenticated;

grant execute on function create_room(text, int)  to service_role;
grant execute on function join_room(text)         to service_role;
grant execute on function fill_with_bots(uuid)    to service_role;
grant execute on function shuffle_seats(uuid)     to service_role;
