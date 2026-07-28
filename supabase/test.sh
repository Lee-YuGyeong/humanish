#!/usr/bin/env bash
#
# 사람인 척 (whois-human) — 스키마 · 상태머신 · RLS 검증
# SPEC §14. 소유: A
#
#   ./supabase/test.sh
#
# 일회용 로컬 Postgres를 띄워서 supabase/의 SQL을 전부 올리고 SPEC §14.2 · §14.3 · §14.4를
# 검사한다. Supabase 프로젝트도 인터넷도 필요 없다. 끝나면 클러스터를 지운다.
#
# pg_cron은 로컬에 없으므로 워치독 "등록"은 건너뛴다. 대신 워치독 "함수"는 직접 불러서
# 검사한다 — 실제로 확인해야 하는 건 skip locked · 예외 격리 쪽이다 (SPEC §16.2).
#
# 배포 DB에 적용하는 것은 README 참고. 이 스크립트는 배포 DB를 건드리지 않는다.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${WHOIS_TEST_PORT:-55432}"
PGDIR="$(mktemp -d "${TMPDIR:-/tmp}/whois-pg.XXXXXX")"

command -v initdb >/dev/null || { echo "initdb가 없다. postgresql을 설치할 것 (brew install postgresql@16)"; exit 1; }

cleanup() {
  pg_ctl -D "$PGDIR/data" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$PGDIR"
}
trap cleanup EXIT

export PGHOST=127.0.0.1 PGPORT="$PORT" PGUSER=postgres PGDATABASE=whois_test

echo "▸ 일회용 Postgres 기동 (포트 $PORT)"
initdb -D "$PGDIR/data" -U postgres --auth=trust >/dev/null 2>&1
pg_ctl -D "$PGDIR/data" -o "-p $PORT -c listen_addresses=127.0.0.1" -l "$PGDIR/pg.log" start >/dev/null 2>&1
for _ in $(seq 1 20); do psql -d postgres -c 'select 1' >/dev/null 2>&1 && break; sleep 0.5; done

psql -q -d postgres \
  -c "create database whois_test;" \
  -c "create role anon nologin; create role authenticated nologin; create role service_role nologin;"

# ★ Supabase의 기본 권한을 흉내 낸다. 이걸 안 하면 로컬이 실제보다 안전해 보인다.
#   Supabase는 public 스키마의 새 테이블·함수에 anon·authenticated 권한을 자동으로 깔아준다.
#   그 상태에서 우리가 제대로 revoke하는지가 검사 대상이다.
#   (실제로 이 줄이 없어서 "anon이 advance_phase를 부를 수 있다"를 로컬이 놓쳤다)
psql -q -d whois_test \
  -c "grant usage on schema public to anon, authenticated, service_role;" \
  -c "alter default privileges in schema public grant all on tables to anon, authenticated, service_role;" \
  -c "alter default privileges in schema public grant all on functions to anon, authenticated, service_role;" \
  -c "alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;"

echo "▸ SQL 적용"
for f in schema.sql policies.sql seed.sql functions/advance_phase.sql functions/room.sql functions/chat.sql; do
  psql -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/$f" >/dev/null 2>&1 \
    || { echo "  ✗ $f 적용 실패"; psql -v ON_ERROR_STOP=1 -f "$ROOT/supabase/$f" 2>&1 | tail -20; exit 1; }
  echo "  ✓ $f"
done

FAIL=0
q()     { psql -tAq -c "$1"; }
check() { if [ "$2" = "$3" ]; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s  (기대 %s / 실제 %s)\n' "$1" "$2" "$3"; FAIL=1; fi; }
# anon으로 실행해서 "에러 또는 0행"이면 통과.
# psql은 에러 시 non-zero로 끝나고 pipefail이 켜져 있으므로 || true로 받아야 한다.
blocked() {
  local out; out="$(psql -tAq -c "set role anon; $2" 2>&1 | head -1 || true)"
  case "$out" in ERROR*|0) printf '  ✓ %s\n' "$1";; *) printf '  ✗ %s → %s\n' "$1" "$out"; FAIL=1;; esac
}
# 에러 메시지에 특정 문구가 있으면 denied. 마찬가지로 pipefail을 피해 먼저 받아둔다.
denied_if() {
  local out; out="$(psql -tAq -c "$1" 2>&1 || true)"
  case "$out" in *"$2"*) echo denied;; *) echo allowed;; esac
}

R=11111111-1111-1111-1111-111111111111
RB=11111111-1111-1111-1111-111111111112
P1=22222222-0000-0000-0000-000000000001   # 사람 · 방장
P2=22222222-0000-0000-0000-000000000002   # 사람
B3=22222222-0000-0000-0000-000000000003   # 봇

echo "▸ 픽스처: 사람 2 + 봇 3"
psql -q -c "
insert into rooms (id, code, host_id) values ('$R','TSTA','$P1');
insert into players (id, room_id, nickname, mask_id, seat, is_bot) values
  ('$P1','$R','익명1','m1',1,false), ('$P2','$R','익명2','m2',2,false),
  ('$B3','$R','익명3','m3',3,true),
  ('22222222-0000-0000-0000-000000000004','$R','익명4','m4',4,true),
  ('22222222-0000-0000-0000-000000000005','$R','익명5','m5',5,true);
insert into player_roles (player_id, room_id, role) values
  ('$P1','$R','citizen'), ('$P2','$R','spy'), ('$B3','$R','ai'),
  ('22222222-0000-0000-0000-000000000004','$R','ai'),
  ('22222222-0000-0000-0000-000000000005','$R','ai');"

echo ""
echo "── 게임 시작 권한 (SPEC §5.1, §17.4) ──"
check "방장이 아니면 시작 못 한다"    "denied" "$(denied_if "select advance_phase('$R',0,'$P2');" '방장만')"
check "actor 없이 시작 못 한다"       "denied" "$(denied_if "select advance_phase('$R',0);"       'actor')"

# 역할 배정은 TS(assignRoles)라 DB가 못 한다. /api/room/start를 안 거치면 막혀야 한다.
psql -q -c "delete from player_roles where room_id='$R';"
ROLE_GUARD="$(denied_if "select advance_phase('$R',0,'$P1');" '역할')"
psql -q -c "insert into player_roles (player_id, room_id, role)
            select id, '$R', case when is_bot then 'ai' else 'citizen' end
              from players where room_id='$R';"
check "역할 미배정이면 시작 못 한다"   "denied" "$ROLE_GUARD"
check "방장은 시작한다"               "t"      "$(q "select advance_phase('$R',0,'$P1');")"

echo ""
echo "── question 진입 훅 (SPEC §5.3, §17.2) ──"
check "질문 1개 생성"                 "1" "$(q "select count(*) from questions where room_id='$R';")"
check "봇 3명 답변 생성"              "3" "$(q "select count(*) from answers where room_id='$R';")"
check "봇 답변은 페이즈 종료 시각에 공개" "t" \
  "$(q "select coalesce(bool_and(a.visible_at = r.phase_ends_at),false) from answers a join rooms r on r.id=a.room_id where r.id='$R';")"

echo ""
echo "── 조기 종료는 사람만 센다 (I5) ──"
QID="$(q "select id from questions where room_id='$R' and round=1;")"
psql -q -c "insert into answers (question_id,room_id,player_id,text,visible_at)
            select '$QID','$R','$P1','답1',phase_ends_at from rooms where id='$R';"
check "사람 1/2 제출 → 아직 아님"     "f" "$(q "select early_exit_met('$R','question',1);")"
psql -q -c "insert into answers (question_id,room_id,player_id,text,visible_at)
            select '$QID','$R','$P2','답2',phase_ends_at from rooms where id='$R';"
check "사람 2/2 제출 → 조기 종료"     "t" "$(q "select early_exit_met('$R','question',1);")"

echo ""
echo "── §14.3 동시성: 5개 세션이 같은 expected_seq로 동시 호출 ──"
SEQ="$(q "select phase_seq from rooms where id='$R';")"
OUT="$PGDIR/adv"; mkdir -p "$OUT"
for i in 1 2 3 4 5; do (q "select advance_phase('$R',$SEQ);" > "$OUT/$i" 2>&1) & done
wait
check "성공한 호출은 정확히 1개"      "1" "$(cat "$OUT"/* | grep -c '^t$' || true)"
check "phase_seq 증가폭은 정확히 1"   "1" "$(( $(q "select phase_seq from rooms where id='$R';") - SEQ ))"
check "질문이 중복 생성되지 않았다"    "2" "$(q "select count(*) from questions where room_id='$R';")"

echo ""
echo "── target: 대상이 봇이면 조기 종료하지 않는다 (I1, SPEC §5.3) ──"
psql -q -c "update rooms set phase_ends_at = now() - interval '1s' where id='$R';"
q "select advance_expired_rooms();" >/dev/null
check "target 페이즈 진입"            "target" "$(q "select phase from rooms where id='$R';")"
TQ="$(q "select id from questions where room_id='$R' and kind='target';")"
psql -q -c "update questions set target_id='$B3' where id='$TQ';
            delete from answers where question_id='$TQ';
            insert into answers (question_id,room_id,player_id,text,visible_at)
            values ('$TQ','$R','$B3','봇답', now()+interval '60s');"
check "대상=봇, 답변 있어도 조기종료 안 함" "f" "$(q "select early_exit_met('$R','target',2);")"
psql -q -c "update questions set target_id='$P2' where id='$TQ';
            delete from answers where question_id='$TQ';
            insert into answers (question_id,room_id,player_id,text,visible_at)
            values ('$TQ','$R','$P2','사람답', now()+interval '60s');"
check "대상=사람, 답변 있으면 조기종료" "t" "$(q "select early_exit_met('$R','target',2);")"

echo ""
echo "── 나머지 페이즈 진행 ──"
for want in chat vote reveal; do
  psql -q -c "update rooms set phase_ends_at = now() - interval '1s' where id='$R';"
  q "select advance_expired_rooms();" >/dev/null
  check "→ $want" "$want" "$(q "select phase from rooms where id='$R';")"
done
check "봇 투표 3건 생성"              "3" "$(q "select count(*) from votes v join players p on p.id=v.voter_id where v.room_id='$R' and p.is_bot;")"
check "replay에서는 더 안 간다"        "f" "$(q "select advance_phase('$R',(select phase_seq from rooms where id='$R'),'$P1');" >/dev/null; q "select advance_phase('$R',(select phase_seq from rooms where id='$R'),'$P1');")"

echo ""
echo "── §17.3 명단 신호 ──"
BEFORE="$(q "select roster_seq from rooms where id='$R';")"
psql -q -c "update players set connected=false where id='$P2';"
check "players 변경 시 roster_seq 증가" "1" "$(( $(q "select roster_seq from rooms where id='$R';") - BEFORE ))"

echo ""
echo "── §14.4 워치독 격리: 잠긴 방이 다른 방을 막지 않는다 (§16.2) ──"
psql -q -c "
insert into rooms (id,code,phase,round,phase_seq,host_id) values ('$RB','TSTB','chat',2,4,'33333333-0000-0000-0000-000000000001');
insert into players (id,room_id,nickname,mask_id,seat,is_bot) values
 ('33333333-0000-0000-0000-000000000001','$RB','익명1','m1',1,false),
 ('33333333-0000-0000-0000-000000000002','$RB','익명2','m2',2,true);
update rooms set phase='chat', round=2, phase_ends_at = now() - interval '1s' where id in ('$R','$RB');"
ASEQ="$(q "select phase_seq from rooms where id='$R';")"
psql -q -c "begin; select 1 from rooms where id='$R' for update; select pg_sleep(6); commit;" >/dev/null 2>&1 &
LOCKER=$!
sleep 1
START=$(date +%s)
q "select advance_expired_rooms();" >/dev/null
ELAPSED=$(( $(date +%s) - START ))
check "잠긴 방을 기다리지 않는다 (${ELAPSED}초)" "fast" "$([ "$ELAPSED" -lt 3 ] && echo fast || echo slow)"
check "잠긴 A방은 그대로"              "$ASEQ"  "$(q "select phase_seq from rooms where id='$R';")"
check "안 잠긴 B방은 전환됐다"          "vote"   "$(q "select phase from rooms where id='$RB';")"
wait $LOCKER 2>/dev/null || true

echo ""
echo "── 자유 채팅: 봇 쿨다운과 지연 (SPEC §5.4, §13-6) ──"
psql -q -c "update rooms set phase='chat', phase_ends_at = now() + interval '120s' where id='$R';"
for i in 1 2 3 4 5; do
  q "select send_message('$R','$P1','도배 $i', 8);" >/dev/null
done
HUMAN_MSGS="$(q "select count(*) from messages m join players p on p.id=m.player_id where m.room_id='$R' and not p.is_bot;")"
BOT_MSGS="$(q "select count(*) from messages m join players p on p.id=m.player_id where m.room_id='$R' and p.is_bot;")"
check "사람 메시지 5건 들어감" "5" "$HUMAN_MSGS"
# 봇은 3명이고 각자 쿨다운 8초다. 몇 초 안에 5번을 보내면 봇당 한 번씩 3건이 나오고
# 나머지 2건은 전원 쿨다운이라 조용하다. 5건이 나오면 쿨다운이 안 걸린 것이다.
check "5번 도배해도 봇 응답은 3건 (봇당 쿨다운 8초)" "3" "$BOT_MSGS"
check "한 메시지에 반응하는 봇은 최대 1명" "t" \
  "$(q "select coalesce(bool_and(c <= 1),true) from (select date_trunc('milliseconds', m.created_at) t, count(*) c from messages m join players p on p.id=m.player_id where m.room_id='$R' and p.is_bot group by 1) x;")"
check "사람 메시지는 지연이 없다" "t" \
  "$(q "select coalesce(bool_and(m.visible_at = m.created_at),false) from messages m join players p on p.id=m.player_id where m.room_id='$R' and not p.is_bot;")"
check "봇 메시지는 지연이 있다" "t" \
  "$(q "select coalesce(bool_and(m.visible_at > m.created_at),false) from messages m join players p on p.id=m.player_id where m.room_id='$R' and p.is_bot;")"
check "public_messages에 created_at이 없다 (I1)" "id,room_id,player_id,text,visible_at" \
  "$(q "select string_agg(column_name,',' order by ordinal_position) from information_schema.columns where table_name='public_messages';")"
check "아직 시간이 안 된 봇 메시지는 뷰에 안 나온다" "t" \
  "$(q "select (select count(*) from messages where room_id='$R') > (select count(*) from public_messages where room_id='$R');")"

echo ""
echo "── §14.2 RLS 침투 (anon). 전부 에러 또는 0행이어야 한다 ──"
psql -q -c "update rooms set phase='chat' where id='$R';
            insert into answers (question_id,room_id,player_id,text,visible_at)
            select '$QID','$R','22222222-0000-0000-0000-000000000004','미래답', now()+interval '1h'
            on conflict do nothing;"
blocked "select * from player_roles"        "select count(*) from player_roles;"
blocked "select is_bot from players"        "select count(*) from players where is_bot;"
blocked "select * from players"             "select count(*) from players;"
blocked "messages 테이블 직접 조회"          "select count(*) from messages;"
blocked "미공개 답변"                        "select count(*) from answers where visible_at > now();"
blocked "reveal 이전 votes"                  "select count(*) from votes;"
blocked "select * from agent_logs"          "select count(*) from agent_logs;"
blocked "봇 문구 풀 (I1)"                    "select count(*) from bot_line_pool;"
blocked "질문 풀"                            "select count(*) from question_pool;"
blocked "public_players.created_at (I1)"    "select created_at from public_players limit 1;"
blocked "public_players.token"              "select token from public_players limit 1;"
blocked "advance_phase 직접 호출"            "select advance_phase('$R',99);"
blocked "advance_expired_rooms 직접 호출"    "select advance_expired_rooms();"
blocked "rooms 쓰기"                         "update rooms set phase='reveal' where id='$R';"
blocked "answers 쓰기 (위조)"                "insert into answers (question_id,room_id,player_id,text,visible_at) values ('$QID','$R','$P1','위조',now());"
blocked "players 삭제"                       "delete from players;"
blocked "votes 쓰기 (위조)"                  "insert into votes values ('$R','$P1','$B3','위조');"
blocked "questions 쓰기"                     "insert into questions (room_id,round,kind,text) values ('$R',1,'common','위조');"

echo ""
echo "── 권한 자체가 없어야 한다 (Supabase 기본 grant를 제대로 걷어냈나) ──"
for t in rooms questions answers messages votes; do
  check "anon은 $t 에 쓰기 권한이 없다" "f" \
    "$(q "select has_table_privilege('anon','$t','insert') or has_table_privilege('anon','$t','update') or has_table_privilege('anon','$t','delete');")"
done
for fn in "advance_phase(uuid,int,uuid)" "advance_expired_rooms(int)" "on_enter_phase(uuid,text,int,timestamptz)" "pick_bot_line(text)" "cleanup_stale_rooms(interval)" "bot_reply(uuid,int)" "send_message(uuid,uuid,text,int)" "create_room(text,int)" "join_room(text)" "fill_with_bots(uuid)" "server_now()" "default_room_capacity()" "room_capacity(uuid)" "pick_free_seat(uuid)"; do
  check "anon은 ${fn%%(*} 를 못 부른다" "f" "$(q "select has_function_privilege('anon','$fn','execute');")"
done

echo ""
echo "── 반대로 이건 보여야 정상 ──"
# 공개 시각이 지난 답변을 하나 만들어둔다. 위에서 만든 답변은 전부 visible_at이 미래라
# 그대로 두면 "안 보이는 게 정상"인 상태다.
psql -q -c "update answers set visible_at = now() - interval '1s'
             where room_id='$R' and player_id='$P1';"
check "public_players (A방 5명)"       "5" "$(psql -tAq -c "set role anon; select count(*) from public_players where room_id='$R';")"
check "rooms 조회 (코드로 방 찾기)"     "2" "$(psql -tAq -c "set role anon; select count(*) from rooms;")"
check "공개된 답변은 보인다"            "t" "$(psql -tAq -c "set role anon; select count(*) > 0 from answers where room_id='$R';")"
check "미공개 답변은 여전히 안 보인다"   "t" "$(psql -tAq -c "set role anon; select count(*) = 0 from answers where visible_at > now();")"
psql -q -c "update rooms set phase='reveal' where id='$R';"
check "reveal 이후 votes가 보인다"      "t" "$(psql -tAq -c "set role anon; select count(*) > 0 from votes;")"

echo ""
echo "── 정원 3~8 (SPEC §17.6) ──"
# ★ 이 블록은 방을 새로 만든다. 위의 "rooms 조회 (코드로 방 찾기)"가 방 개수를 세므로
#   반드시 그 뒤에 둔다. 코드는 4자 대문자이고 TSTA·TSTB와 겹치지 않아야 한다.
check "default_room_capacity()는 5"     "5" "$(q "select default_room_capacity();")"

CAPD="$(q "select room_id from create_room('CAPD');")"
check "정원을 안 주면 5"                "5" "$(q "select capacity from rooms where id='$CAPD';")"

CAPH="$(q "select room_id from create_room('CAPH', 8);")"
check "정원 8로 만들면 capacity=8"      "8" "$(q "select capacity from rooms where id='$CAPH';")"
check "room_capacity(방)는 그 방 정원"   "8" "$(q "select room_capacity('$CAPH');")"
q "select fill_with_bots('$CAPH');" >/dev/null
check "정원 8인 방은 8명까지 찬다"       "8" "$(q "select count(*) from players where room_id='$CAPH';")"
check "정원 8인 방의 최대 seat은 8"      "8" "$(q "select max(seat) from players where room_id='$CAPH';")"

CAPL="$(q "select room_id from create_room('CAPL', 3);")"
q "select fill_with_bots('$CAPL');" >/dev/null
check "정원 3인 방은 3명에서 멈춘다"     "3" "$(q "select count(*) from players where room_id='$CAPL';")"
check "정원 3인 방에는 더 못 들어간다"   "denied" "$(denied_if "select * from join_room('CAPL');" '꽉 찼다')"

# 체크 제약(23514)이 아니라 P0001로 튀어야 한다. 그래야 사용자에게 보여줄 문장이 된다.
check "정원 2는 거절된다"               "denied" "$(denied_if "select * from create_room('CAPN', 2);" '정원은 3~8명이다')"
check "정원 9는 거절된다"               "denied" "$(denied_if "select * from create_room('CAPX', 9);" '정원은 3~8명이다')"
check "거절된 방은 남지 않는다"          "0" "$(q "select count(*) from rooms where code in ('CAPN','CAPX');")"

# seat 상한은 정원의 최댓값인 8이다. 방별 상한은 pick_free_seat이 지킨다.
check "seat 9는 제약에 걸린다"          "denied" \
  "$(denied_if "insert into players (room_id,nickname,mask_id,seat) values ('$CAPL','익명9','m9',9);" 'players_seat_check')"
check "capacity 9인 방은 만들 수 없다"   "denied" \
  "$(denied_if "insert into rooms (code,capacity) values ('CAPZ',9);" 'rooms_capacity_check')"

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "전부 통과 (SPEC §14.2 · §14.3 · §14.4)"
else
  echo "실패한 항목이 있다. 위의 ✗를 볼 것"
fi
exit "$FAIL"
