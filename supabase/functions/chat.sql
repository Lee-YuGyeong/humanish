-- 사람인 척 (whois-human) — 자유 채팅에서의 봇 반응
-- SPEC §5.4, §13-6, §17.2. 소유: A
--
--   psql "$SUPABASE_DB_URL_DIRECT" -f supabase/functions/chat.sql
--
-- ┌─ SPEC §5.4의 세 규칙 ──────────────────────────────────────────────────┐
-- │  1. 봇당 쿨다운 최소 8초                                                │
-- │  2. 한 사람 메시지에 반응하는 봇은 최대 1명                             │
-- │  3. 이 구간이 API 호출이 가장 몰리는 지점                               │
-- │                                                                       │
-- │ 지금은 LLM을 쓰지 않으므로 3번은 비용이 아니라 그냥 문구 뽑기다.        │
-- │ LLM을 붙이면 이 함수는 폴백으로 남는다 (§12.3, §17.5).                  │
-- └───────────────────────────────────────────────────────────────────────┘

------------------------------------------------------------------------------
-- 타이핑 지연 — SPEC §5.3, lib/agent/disguise.ts의 typingDelayMs와 같은 역할
------------------------------------------------------------------------------
-- ★ 지연은 기다려서 만드는 게 아니라 visible_at에 시각으로 박는다.
--   서버 함수가 6초를 붙잡고 있을 수 없기 때문이다.
--   글자 수에 비례하되 흔들림을 준다 — 매번 정확히 같은 간격이면 그게 신호가 된다.
create or replace function typing_delay(p_text text)
returns interval
language sql
as $$
  select make_interval(secs =>
    least(1.5 + char_length(p_text) * 0.12, 8.0) * (0.7 + random() * 0.6)
  );
$$;

------------------------------------------------------------------------------
-- 봇 한 명이 반응한다 — SPEC §5.4
------------------------------------------------------------------------------
-- 반환: 넣은 메시지 id. 반응할 봇이 없으면 null.
--
-- ★ 방 행을 잠그고 고른다. 두 사람이 같은 순간에 말하면 잠금 없이는 같은 봇이
--   두 번 뽑혀 쿨다운이 깨진다.
--
-- ★ 쿨다운은 created_at으로 잰다. visible_at으로 재면 아직 안 뜬 메시지가
--   쿨다운에 안 잡혀서 봇이 연달아 말한다.
create or replace function bot_reply(
  p_room_id uuid,
  p_cooldown_sec int default 8
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bot  uuid;
  v_text text;
  v_id   uuid;
begin
  perform 1 from rooms where id = p_room_id and phase = 'chat' for update;
  if not found then
    return null;   -- chat 페이즈가 아니면 아무것도 안 한다
  end if;

  -- 쿨다운이 지난 봇 중 하나. 최근에 말한 봇일수록 안 뽑히게 무작위로 고른다.
  select p.id into v_bot
    from players p
   where p.room_id = p_room_id
     and p.is_bot
     and not exists (
       select 1 from messages m
        where m.player_id = p.id
          and m.created_at > now() - make_interval(secs => p_cooldown_sec)
     )
   order by random()
   limit 1;

  if v_bot is null then
    return null;   -- 전부 쿨다운 중이다. 조용히 넘어간다
  end if;

  v_text := pick_bot_line('chat');

  insert into messages (room_id, player_id, text, visible_at)
  values (p_room_id, v_bot, v_text, now() + typing_delay(v_text))
  returning id into v_id;

  return v_id;
end;
$$;

------------------------------------------------------------------------------
-- 사람 메시지 넣기 + 봇 반응까지 한 번에
------------------------------------------------------------------------------
-- ★ visible_at을 Route Handler에서 new Date()로 만들지 않는다 (I2, SPEC §12.5).
--   앱 서버 시계와 DB 시계는 어긋난다 — 개발 기계에서 2.26초 차이가 났다.
--   그러면 사람 메시지의 visible_at이 created_at보다 과거가 되거나(바로 보임),
--   반대로 미래가 되어(몇 초간 안 보임) 원인을 찾기 어려운 증상이 된다.
--   시각을 만드는 일은 전부 DB에서 한다.
create or replace function send_message(
  p_room_id      uuid,
  p_player_id    uuid,
  p_text         text,
  p_cooldown_sec int default 8
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  if not exists (select 1 from rooms where id = p_room_id and phase = 'chat') then
    raise exception '지금은 채팅할 때가 아니다' using errcode = 'P0001';
  end if;
  if not exists (select 1 from players where id = p_player_id and room_id = p_room_id) then
    raise exception '이 방의 플레이어가 아니다' using errcode = 'P0001';
  end if;

  -- 사람 메시지는 지연 없이 바로 보인다
  insert into messages (room_id, player_id, text, visible_at)
  values (p_room_id, p_player_id, p_text, now())
  returning id into v_id;

  -- 봇 반응. 전부 쿨다운 중이면 아무 일도 없다 (SPEC §5.4)
  perform bot_reply(p_room_id, p_cooldown_sec);

  return v_id;
end;
$$;

------------------------------------------------------------------------------
-- 권한 — I9
------------------------------------------------------------------------------
-- Supabase가 새 함수에 anon execute를 자동으로 깔아준다. security definer라
-- 그대로 두면 anon이 봇을 마음대로 떠들게 하거나 남의 이름으로 말할 수 있다.
revoke all on function typing_delay(text)                      from public, anon, authenticated;
revoke all on function bot_reply(uuid, int)                    from public, anon, authenticated;
revoke all on function send_message(uuid, uuid, text, int)     from public, anon, authenticated;
grant execute on function bot_reply(uuid, int)                 to service_role;
grant execute on function send_message(uuid, uuid, text, int)  to service_role;
