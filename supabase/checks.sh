#!/usr/bin/env bash
#
# 사람인 척 (whois-human) — 스키마가 제대로 올라갔는지 보는 검사 묶음. 소유: A
#
# ┌─ 왜 파일을 따로 뺐나 ────────────────────────────────────────────────────┐
# │ apply.sh(배포 DB)와 test.sh(일회용 로컬 PG)가 각자 검사를 들고 있었고,   │
# │ 그래서 **한쪽만 아는 사실**이 생겼다. 두 번 데였다.                      │
# │                                                                         │
# │  · apply.sh만 보던 것 — create_room 시그니처. 그런데 그 검사가 애초에    │
# │    통과할 수 없는 모양이었다(pg_get_function_identity_arguments는 인자   │
# │    이름까지 준다). test.sh는 시그니처를 안 봐서 로컬은 계속 초록불.      │
# │  · test.sh만 보던 것 — SQL 여섯 개 전부. apply.sh가 room.sql·chat.sql을  │
# │    안 올리고 있어서 배포 DB에서만 방 만들기가 죽었다 (커밋 152f825).     │
# │                                                                         │
# │ 목록이 하나면 한쪽에서 고친 것이 반대쪽에도 그대로 걸린다.               │
# │ **검사를 새로 추가할 때는 여기에 넣는다.** 어느 한쪽에만 넣지 않는다.    │
# └─────────────────────────────────────────────────────────────────────────┘
#
# 호출 규약 — source 하기 전에 아래 둘을 정의해 둔다.
#   q "<sql>"                       한 줄짜리 결과를 표준출력으로
#   check "<이름>" "<기대>" "<실제>"  다르면 FAIL=1
#
# pg_cron 워치독 등록은 여기 없다. 로컬 Postgres에는 확장이 없어서 배포 DB에서만
# 의미가 있고, apply.sh가 따로 본다.

# 함수가 없으면 has_function_privilege는 **에러**다. set -o pipefail 아래서는 그 자리에서
# 스크립트가 죽는다. oid로 바꿔 물으면 없을 때 0행(빈 문자열)이 되어, check가
# "기대 f / 실제 (빈칸)"으로 잡아준다 — 죽지 않고 원인이 보인다.
anon_can() {
  q "select has_function_privilege('anon', oid, 'execute') from pg_proc where oid = to_regprocedure('$1');"
}

schema_checks() {
  echo ""
  echo "── 스키마 · 뷰 (SPEC §4, §7.2) ──"

  # ★ 뷰가 아예 없으면 "그 컬럼이 없다"도 참이 된다. 먼저 뷰의 존재부터 확인한다.
  #   안 그러면 스키마를 안 올린 DB에서 I1 검사가 통째로 가짜 통과한다.
  check "public_players 뷰가 있다" "1" \
    "$(q "select count(*) from information_schema.views where table_name='public_players';")"

  # ★ 컬럼 목록을 통째로 비교한다. "is_bot이 없다"만 보면 다음에 추가된 컬럼은 못 잡는다.
  #   created_at은 봇이 한꺼번에 만들어져서, token은 본인 확인용이라 빠져야 한다 (§7.2).
  check "public_players 컬럼이 정확히 6개다" "id,room_id,nickname,mask_id,seat,connected" \
    "$(q "select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_name='public_players';")"

  # 같은 이유로 채팅 뷰도 본다. created_at이 있으면 봇의 타이핑 지연이 드러난다 (I1).
  check "public_messages 컬럼이 정확히 5개다" "id,room_id,player_id,text,visible_at" \
    "$(q "select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_name='public_messages';")"

  check "rooms에 capacity 컬럼이 있다 (§17.6)" "1" \
    "$(q "select count(*) from information_schema.columns where table_name='rooms' and column_name='capacity';")"

  # publication에 갓 추가한 직후에는 Realtime이 몇 분간 이벤트를 안 보낼 수 있다.
  # 구독은 SUBSCRIBED로 뜨는데 이벤트만 안 오므로 코드를 의심하게 된다. 실제로 그랬다.
  # 화면이 안 갱신되면 이 표시를 먼저 떠올릴 것 — 조금 기다렸다 다시 해본다.
  check "rooms가 Realtime publication에 있다 (§6)" "1" \
    "$(q "select count(*) from pg_publication_tables where pubname='supabase_realtime' and tablename='rooms';")"

  echo ""
  echo "── 문구 풀 (seed.sql) ──"
  check "질문 풀이 차 있다" "t" "$(q "select count(*) > 0 from question_pool;")"
  check "봇 문구 풀이 차 있다" "t" "$(q "select count(*) > 0 from bot_line_pool;")"

  echo ""
  echo "── 함수 시그니처 (SPEC §17.6) ──"
  # ★ 이름이 아니라 **시그니처**로 본다. 이름만 세면 옛 create_room(text)가 남아 있어도
  #   통과한다. 정원이 방마다 달라지면서 create_room(text) → create_room(text,int)로
  #   바뀌었고, 옛 함수만 있는 DB에서는 방 만들기가 PGRST202로 죽는데 화면에는 그냥
  #   "방 생성 실패"만 뜬다.
  #
  # ★ 판정은 to_regprocedure로 한다. 없으면 에러가 아니라 null이라 그대로 비교된다.
  #   원래는 pg_get_function_identity_arguments(oid)='text, integer'로 셌는데,
  #   **그 함수는 인자 이름까지 돌려준다** — 실제 값은 'p_code text, p_capacity integer'라
  #   스키마가 멀쩡해도 영원히 ✗가 떴다. 이 방식은 인자 이름을 바꿔도 안 깨진다.
  for sig in \
    "advance_phase(uuid,int,uuid)" \
    "advance_expired_rooms(int)" \
    "create_room(text,int)" \
    "join_room(text)" \
    "fill_with_bots(uuid)" \
    "send_message(uuid,uuid,text,int)" \
    "room_capacity(uuid)" \
    "default_room_capacity()" \
    "server_now()"; do
    check "${sig} 가 있다" "t" "$(q "select (to_regprocedure('$sig') is not null);")"
  done
  check "옛 create_room(text)이 남아 있지 않다" "f" \
    "$(q "select (to_regprocedure('create_room(text)') is not null);")"

  echo ""
  echo "── anon 권한 (I1, I9) ──"
  check "anon은 players를 못 읽는다 (I1)" "f" \
    "$(q "select has_table_privilege('anon','players','select');")"
  check "anon은 public_players를 읽는다" "t" \
    "$(q "select has_table_privilege('anon','public_players','select');")"
  check "anon은 messages 테이블을 못 읽는다 (I1)" "f" \
    "$(q "select has_table_privilege('anon','messages','select');")"

  # 쓰기는 전부 service role 서버를 거친다 (I9). anon에 쓰기 권한이 남아 있으면 안 된다.
  for t in rooms questions answers messages votes players; do
    check "anon은 $t 에 쓰기 권한이 없다" "f" \
      "$(q "select has_table_privilege('anon','$t','insert') or has_table_privilege('anon','$t','update') or has_table_privilege('anon','$t','delete');")"
  done

  # 이 함수들은 전부 security definer다. anon이 부를 수 있으면 RLS가 통째로 무의미해진다.
  for fn in \
    "advance_phase(uuid,int,uuid)" \
    "advance_expired_rooms(int)" \
    "on_enter_phase(uuid,text,int,timestamptz)" \
    "pick_bot_line(text)" \
    "cleanup_stale_rooms(interval)" \
    "bot_reply(uuid,int)" \
    "send_message(uuid,uuid,text,int)" \
    "create_room(text,int)" \
    "join_room(text)" \
    "fill_with_bots(uuid)" \
    "server_now()" \
    "default_room_capacity()" \
    "room_capacity(uuid)" \
    "pick_free_seat(uuid)"; do
    check "anon은 ${fn%%(*} 를 못 부른다" "f" "$(anon_can "$fn")"
  done
}
