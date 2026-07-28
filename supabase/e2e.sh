#!/usr/bin/env bash
#
# 사람인 척 (whois-human) — 라우트 e2e 검증
# SPEC §13-1 ~ §13-4, §13-7, §14.2. 소유: A
#
#   npm run dev &            # 먼저 개발 서버를 띄운다
#   ./supabase/e2e.sh        # .env.local의 Supabase에 대고 돈다
#
# 쿠키 항아리 2개로 브라우저 두 대를 흉내 내서 방 만들기 → 입장 → 시작 →
# 답변 → 조기 종료 → 페이즈 완주 → anon 침투까지 한 번에 확인한다.
#
# ★ 실제 Supabase에 방을 만든다. 만든 방은 24시간 뒤 cleanup_stale_rooms가 지운다.
#
# ★ curl 본문은 반드시 변수에 담아서 넘긴다. $( ) 안에 JSON을 직접 쓰면 따옴표가
#   풀리면서 bash가 {a,b}를 중괄호 확장으로 처리해 본문이 쪼개진다. 그러면 서버가
#   400을 내는데 원인이 라우트인 줄 알고 한참 헤매게 된다 (실제로 그랬다).

B="${WHOIS_BASE_URL:-http://localhost:3000}"
A_JAR=$(mktemp); B_JAR=$(mktemp); N_JAR=$(mktemp)
FAIL=0

# .env.local에서 접속 정보를 읽는다
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DBURL="${DBURL:-$(grep -E '^[[:space:]]*SUPABASE_DB_URL_DIRECT=' "$ROOT/.env.local" | head -1 | cut -d= -f2-)}"
[ -n "$DBURL" ] || { echo ".env.local의 SUPABASE_DB_URL_DIRECT가 비었다"; exit 1; }
curl -sf "$B/api/time" >/dev/null || { echo "개발 서버가 안 떠 있다. npm run dev 를 먼저 실행할 것"; exit 1; }

ok()  { printf '  ✓ %s\n' "$1"; }
bad() { printf '  ✗ %s — %s\n' "$1" "$2"; printf '      body: %s\n' "$(cat /tmp/last_body.txt 2>/dev/null)"; FAIL=1; }
chk() { [ "$2" = "$3" ] && ok "$1" || bad "$1" "기대 $2 / 실제 $3"; }

post() { # jar path body
  curl -s -b "$1" -c "$1" -X POST "$B$2" -H 'content-type: application/json' -d "$3"
}
code_of() { # jar path body
  curl -s -o /tmp/last_body.txt -w '%{http_code}' -b "$1" -c "$1" -X POST "$B$2" -H 'content-type: application/json' -d "$3"
}

echo "── 방 만들기 ──"
R=$(curl -s -c "$A_JAR" -X POST "$B/api/room")
ROOM=$(echo "$R" | python3 -c 'import sys,json; print(json.load(sys.stdin)["room"]["id"])' 2>/dev/null)
CODE=$(echo "$R" | python3 -c 'import sys,json; print(json.load(sys.stdin)["room"]["code"])' 2>/dev/null)
A_SEAT=$(echo "$R" | python3 -c 'import sys,json; print(json.load(sys.stdin)["player"]["seat"])' 2>/dev/null)
[ -n "$ROOM" ] && ok "방 생성 (코드 $CODE, 방장 seat=$A_SEAT)" || { bad "방 생성" "$R"; exit 1; }
chk "코드는 대문자 4자" "yes" "$([[ "$CODE" =~ ^[A-Z]{4}$ ]] && echo yes || echo no)"

echo ""
echo "── 두 번째 사람 입장 ──"
JOIN_BODY="{\"code\":\"$CODE\"}"
R2=$(post "$B_JAR" /api/room/join "$JOIN_BODY")
B_SEAT=$(echo "$R2" | python3 -c 'import sys,json; print(json.load(sys.stdin)["player"]["seat"])' 2>/dev/null)
[ -n "$B_SEAT" ] && ok "입장 (seat=$B_SEAT)" || bad "입장" "$R2"
chk "서로 다른 자리" "yes" "$([ "$A_SEAT" != "$B_SEAT" ] && echo yes || echo no)"

echo "  같은 사람이 새로고침(재입장)해도 자리가 안 늘어야 한다"
post "$B_JAR" /api/room/join "$JOIN_BODY" > /dev/null
chk "재입장 후에도 2명" "2" "$(curl -s "$B/api/time" >/dev/null; psql "$DBURL" -tAqc "select count(*) from players where room_id='$ROOM';")"

echo ""
echo "── 권한 ──"
START_BODY="{\"room_id\":\"$ROOM\"}"
ANSWER_BODY="{\"room_id\":\"$ROOM\",\"text\":\"위조\"}"
C=$(code_of "$N_JAR" /api/room/start "$START_BODY");  chk "쿠키 없으면 시작 못 함 (401)" "401" "$C"
C=$(code_of "$B_JAR" /api/room/start "$START_BODY");  chk "방장 아니면 시작 못 함 (403)" "403" "$C"
C=$(code_of "$N_JAR" /api/answer     "$ANSWER_BODY"); chk "쿠키 없으면 답변 못 함 (401)" "401" "$C"

echo ""
echo "── 시작 ──"
S=$(post "$A_JAR" /api/room/start "$START_BODY")
PHASE=$(echo "$S" | python3 -c 'import sys,json; print(json.load(sys.stdin)["room"]["phase"])' 2>/dev/null)
chk "phase가 question" "question" "$PHASE"
chk "5명이 됐다" "5" "$(psql "$DBURL" -tAqc "select count(*) from players where room_id='$ROOM';")"
chk "봇 3명" "3" "$(psql "$DBURL" -tAqc "select count(*) from players where room_id='$ROOM' and is_bot;")"
chk "역할 5개 배정" "5" "$(psql "$DBURL" -tAqc "select count(*) from player_roles where room_id='$ROOM';")"
chk "스파이 1명" "1" "$(psql "$DBURL" -tAqc "select count(*) from player_roles where room_id='$ROOM' and role='spy';")"
chk "봇 답변 3개" "3" "$(psql "$DBURL" -tAqc "select count(*) from answers where room_id='$ROOM';")"
echo "  자리 배치: $(psql "$DBURL" -tAqc "select string_agg(case when is_bot then '봇' else '사람' end, ' ' order by seat) from players where room_id='$ROOM';")"

echo ""
echo "── 답변 제출 → 조기 종료 ──"
A1_BODY="{\"room_id\":\"$ROOM\",\"text\":\"어제 김치찌개 먹었어\"}"
A1=$(post "$A_JAR" /api/answer "$A1_BODY")
chk "1명 제출로는 안 넘어감" "false" "$(echo "$A1" | python3 -c 'import sys,json; print(str(json.load(sys.stdin)["advanced"]).lower())' 2>/dev/null)"
A2_BODY="{\"room_id\":\"$ROOM\",\"text\":\"기억이 안 나네\"}"
A2=$(post "$B_JAR" /api/answer "$A2_BODY")
chk "2명 다 내면 넘어감" "true" "$(echo "$A2" | python3 -c 'import sys,json; print(str(json.load(sys.stdin)["advanced"]).lower())' 2>/dev/null)"
chk "question round 2" "question|2" "$(psql "$DBURL" -tAqc "select phase||'|'||round from rooms where id='$ROOM';")"

echo ""
echo "── 나머지는 만료로 진행 ──"
for want in target chat vote reveal; do
  psql "$DBURL" -tAqc "update rooms set phase_ends_at = now() - interval '1s' where id='$ROOM';" >/dev/null
  psql "$DBURL" -tAqc "select advance_expired_rooms();" >/dev/null
  GOT=$(psql "$DBURL" -tAqc "select phase from rooms where id='$ROOM';")
  [ "$GOT" = "$want" ] && ok "→ $want" || { bad "→ $want" "실제 $GOT"; break; }
done
chk "봇 투표 3건" "3" "$(psql "$DBURL" -tAqc "select count(*) from votes v join players p on p.id=v.voter_id where v.room_id='$ROOM' and p.is_bot;")"

echo ""
echo "── anon으로 훔쳐보기 ──"
ANON=$(grep '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' "$ROOT/.env.local" | cut -d= -f2-)
URL=$(grep '^NEXT_PUBLIC_SUPABASE_URL=' "$ROOT/.env.local" | cut -d= -f2-)
rest() { curl -s "$URL/rest/v1/$1" -H "apikey: $ANON" -H "authorization: Bearer $ANON"; }
chk "players 테이블 직접 조회 막힘" "yes" "$(rest "players?select=is_bot" | grep -q 'message' && echo yes || echo no)"
chk "public_players는 보임" "5" "$(rest "public_players?room_id=eq.$ROOM&select=id" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))' 2>/dev/null)"
chk "public_players에 is_bot 없음" "yes" "$(rest "public_players?room_id=eq.$ROOM&select=*" | grep -q is_bot && echo no || echo yes)"
chk "player_roles 막힘" "yes" "$(rest "player_roles?select=*" | grep -q 'message' && echo yes || echo no)"
chk "bot_line_pool 막힘" "yes" "$(rest "bot_line_pool?select=*" | grep -q 'message' && echo yes || echo no)"

echo ""
[ "$FAIL" -eq 0 ] && echo "전부 통과" || echo "실패 있음"
exit "$FAIL"
