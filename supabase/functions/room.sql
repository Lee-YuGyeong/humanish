-- 사람인 척 (whois-human) — 방 생성 · 입장 · 봇 채우기
-- SPEC §13-1, §16.4, §17.4. 소유: A
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

-- 방 정원. lib/server/room.ts의 ROOM_CAPACITY, players.seat 제약과 같아야 한다.
create or replace function room_capacity() returns int
language sql immutable as $$ select 5 $$;

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
    from generate_series(1, room_capacity()) s
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
create or replace function create_room(p_code text)
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
begin
  insert into rooms (code) values (upper(p_code)) returning id into v_room;

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
-- 권한 — I9
------------------------------------------------------------------------------
-- Supabase는 새 함수에 anon execute를 자동으로 깔아준다. security definer라
-- 그대로 두면 anon이 남의 방에 마음대로 사람을 앉힐 수 있다. anon·authenticated를
-- 명시해서 회수한다 (PUBLIC만 회수하면 안 없어진다).
revoke all on function room_capacity()          from public, anon, authenticated;
revoke all on function pick_free_seat(uuid)     from public, anon, authenticated;
revoke all on function create_room(text)        from public, anon, authenticated;
revoke all on function join_room(text)          from public, anon, authenticated;
revoke all on function fill_with_bots(uuid)     from public, anon, authenticated;

grant execute on function create_room(text)     to service_role;
grant execute on function join_room(text)       to service_role;
grant execute on function fill_with_bots(uuid)  to service_role;
