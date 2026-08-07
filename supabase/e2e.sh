#!/usr/bin/env bash
#
# 사람인 척 (whois-human) — 라우트 e2e 검증
# SPEC §13-1 ~ §13-4, §13-7, §14.2. 소유: A
#
#   npm run dev &            # 먼저 개발 서버를 띄운다
#   ./supabase/e2e.sh        # .env.local의 Supabase에 대고 돈다
#
# 쿠키 항아리 2개로 브라우저 두 대를 흉내 내서 방 만들기 → 입장 → 시작 →
# 답변 → 조기 종료 → 페이즈 완주 → anon 침투 → /admin 진단(I1)까지 한 번에 확인한다.
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
# 등호 앞뒤 공백을 허용한다 (apply.sh 와 같은 이유 — 그 파일 주석 참고)
DBURL="${DBURL:-$(grep -E '^[[:space:]]*SUPABASE_DB_URL_DIRECT[[:space:]]*=' "$ROOT/.env.local" | head -1 | cut -d= -f2- | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')}"
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
echo "── 대기방 프리셋 발화 (SPEC §15-3-결정) ──"
# 자유 채팅을 열지 않는 대신 정해진 문구만 누른다. 목록은 lib/server/lobby-lines.ts.
# 여기서 보는 건 목록이 아니라 **조합**이다 — 문구를 좁혀도 연타할 수 있으면
# "ㅋㅋㅋ 두 번 = 나랑 짜자" 같은 약속이 성립한다.
#
# ★ 쿨다운·총량은 시간을 기다리지 않고 psql 로 시계를 되돌려 확인한다.
#   sleep 으로 재면 이 스크립트만 30초 넘게 길어진다.
BAD_LINE="{\"room_id\":\"$ROOM\",\"line_id\":\"우리 다 짧게 답하자\"}"
HI_LINE="{\"room_id\":\"$ROOM\",\"line_id\":\"hi\"}"
LOL_LINE="{\"room_id\":\"$ROOM\",\"line_id\":\"lol\"}"
READY_ON="{\"room_id\":\"$ROOM\",\"ready\":true}"
READY_OFF="{\"room_id\":\"$ROOM\",\"ready\":false}"

C=$(code_of "$N_JAR" /api/lobby/line "$HI_LINE");  chk "쿠키 없으면 말 못 함 (401)" "401" "$C"
C=$(code_of "$A_JAR" /api/lobby/line "$BAD_LINE"); chk "목록에 없는 문구는 거절 (400)" "400" "$C"
C=$(code_of "$A_JAR" /api/lobby/line "$HI_LINE");  chk "정해진 문구는 통과" "200" "$C"
C=$(code_of "$A_JAR" /api/lobby/line "$HI_LINE");  chk "같은 말 연달아는 거절" "409" "$C"
C=$(code_of "$A_JAR" /api/lobby/line "$LOL_LINE"); chk "쿨다운 안에는 거절" "409" "$C"

psql "$DBURL" -q -c "update players set lobby_line_at = now() - interval '1 min' where room_id='$ROOM';"
C=$(code_of "$A_JAR" /api/lobby/line "$LOL_LINE"); chk "쿨다운이 지나면 통과" "200" "$C"

# 총량 상한. 1인당 10회를 다 쓴 상태로 만들어 놓고 한 번 더 눌러본다.
psql "$DBURL" -q -c "update players set lobby_line_count = 10, lobby_line_at = now() - interval '1 min' where room_id='$ROOM';"
C=$(code_of "$A_JAR" /api/lobby/line "$HI_LINE"); chk "총량을 다 쓰면 거절" "409" "$C"
grep -q "횟수" /tmp/last_body.txt && ok "총량 때문이라고 말해준다" || bad "총량 메시지" "$(cat /tmp/last_body.txt)"

# ★ A(방장)는 준비를 누르지 않는다 — 2026-08-07 부터 방장은 시작 조건에서 빠진다
#   (lib/game/rules.ts 의 startBlock). 아래 「시작」이 그대로 200 이면 그 예외가 산 것이다.
C=$(code_of "$B_JAR" /api/lobby/ready "$READY_ON");  chk "준비 완료" "200" "$C"
C=$(code_of "$B_JAR" /api/lobby/ready "$READY_ON");  chk "다시 눌러도 멀쩡하다" "200" "$C"
C=$(code_of "$B_JAR" /api/lobby/ready "$READY_OFF"); chk "준비 해제" "200" "$C"
code_of "$B_JAR" /api/lobby/ready "$READY_ON" > /dev/null

chk "대기방에서는 말풍선이 보인다" "1" \
  "$(psql "$DBURL" -tAqc "select count(*) from public_players where room_id='$ROOM' and lobby_line is not null;")"
chk "대기방에서는 준비 상태가 보인다" "1" \
  "$(psql "$DBURL" -tAqc "select count(*) from public_players where room_id='$ROOM' and is_ready;")"

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

# ★ 대기방 흔적이 게임까지 따라가면 안 된다 (I1). 대기방에는 사람만 있으므로
#   (봇은 방금 fill_with_bots 로 앉았다) 발화·준비 상태가 남으면
#   **값이 있는 자리 = 사람**이 되어 봇 명단이 통째로 드러난다.
#   자리를 아무리 잘 섞어도 소용없다. shuffle_seats 가 같이 지운다.
chk "시작하면 말풍선이 사라진다 (I1)" "0" \
  "$(psql "$DBURL" -tAqc "select count(*) from players where room_id='$ROOM' and lobby_line is not null;")"
chk "시작하면 준비 상태도 꺼진다 (I1)" "0" \
  "$(psql "$DBURL" -tAqc "select count(*) from players where room_id='$ROOM' and is_ready;")"
C=$(code_of "$A_JAR" /api/lobby/line  "$HI_LINE");   chk "시작한 뒤에는 말 못 함" "409" "$C"
C=$(code_of "$B_JAR" /api/lobby/ready "$READY_OFF"); chk "시작한 뒤에는 준비 못 바꿈" "409" "$C"

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
echo "── /admin 진단이 정체를 흘리지 않는다 (I1) ──"
# ★ 이 라우트는 service role로 읽으므로 RLS가 막아주지 않는다. 무엇을 담느냐가 곧 방어다.
#
#   봇 답변과 봇 투표는 **페이즈 진입 순간 한꺼번에** 들어간다 (on_enter_phase, §5.3).
#   그래서 진행 중인 방의 answers·votes 개수는 그 자체로 "이 방의 봇 수"다.
#   is_bot을 안 보내는 것만으로는 부족하고 **세어서 보내는 것도 같은 위반**이다.
#
#   그래서 "금지 키가 없다"가 아니라 **키 목록을 통째로** 비교한다. 필드를 하나
#   더할 때마다 이 줄이 깨지고, 그때 "이걸로 봇을 골라낼 수 있나"를 반드시 묻게 된다
#   (SPEC §7.2 — public_players 뷰에 컬럼을 더할 때와 같은 규율).
curl -s "$B/api/admin/rooms" -o /tmp/admin_rooms.json
ADMIN_KEYS=$(python3 -c '
import json
ks=set()
for r in json.load(open("/tmp/admin_rooms.json"))["rooms"]: ks |= set(r)
print(",".join(sorted(ks)))
' 2>/dev/null)
chk "진단 응답의 키가 정확히 이 목록이다" \
  "capacity,code,created_at,id,phase,phase_ends_at,phase_seq,remaining_ms,roles_assigned,roster_seq,round,seated" \
  "$ADMIN_KEYS"

# 막기만 하고 정작 쓸모가 없으면 안 된다. 이 방이 제대로 보이는지도 같이 본다.
ADMIN_ROW=$(python3 -c "
import json
r = next((x for x in json.load(open('/tmp/admin_rooms.json'))['rooms'] if x['code'] == '$CODE'), None)
print('방이 안 보임' if r is None else f\"{r['seated']}/{r['capacity']}|{str(r['roles_assigned']).lower()}\")
" 2>/dev/null)
chk "이 방이 좌석·역할과 함께 보인다" "5/5|true" "$ADMIN_ROW"

# §12.5 — 만료 판정의 기준 시계는 DB 하나다. 두 시계 차이를 못 재면 어긋나도 모른다.
chk "DB·앱 서버 시계 차이를 숫자로 보고한다 (§12.5)" "yes" \
  "$(python3 -c 'import json; d=json.load(open("/tmp/admin_rooms.json")); print("yes" if isinstance(d.get("drift_ms"),(int,float)) else "no")' 2>/dev/null)"

echo ""
echo "── 나가기: 마지막 사람이 나가면 방이 사라진다 ──"
# 위의 방($ROOM)은 이미 reveal 이다. 게임 중 이탈은 SPEC §15-4 미결정이라 거절한다 —
# 행을 지우면 answers·votes 가 cascade 로 같이 사라져 그 판의 집계가 어긋난다.
LEAVE_BODY="{\"room_id\":\"$ROOM\"}"
C=$(code_of "$A_JAR" /api/room/leave "$LEAVE_BODY"); chk "시작한 방에서는 못 나간다 (409)" "409" "$C"

# 대기실은 새 방으로 본다. 쿠키 항아리도 새로 판다 — 쿠키는 방마다 따로라
# (hp_<room_id>) 앞 방 것을 재활용하면 어느 방의 토큰인지 헷갈린다.
C_JAR=$(mktemp); D_JAR=$(mktemp)
R3=$(curl -s -c "$C_JAR" -X POST "$B/api/room")
ROOM2=$(echo "$R3" | python3 -c 'import sys,json; print(json.load(sys.stdin)["room"]["id"])' 2>/dev/null)
CODE2=$(echo "$R3" | python3 -c 'import sys,json; print(json.load(sys.stdin)["room"]["code"])' 2>/dev/null)
[ -n "$ROOM2" ] || { bad "두 번째 방 생성" "$R3"; }
JOIN2_BODY="{\"code\":\"$CODE2\"}"
LEAVE2_BODY="{\"room_id\":\"$ROOM2\"}"
post "$D_JAR" /api/room/join "$JOIN2_BODY" > /dev/null
chk "새 방에 둘이 앉았다" "2" "$(psql "$DBURL" -tAqc "select count(*) from players where room_id='$ROOM2';")"

body_flag() { python3 -c "import json;print(str(json.load(open('/tmp/last_body.txt'))['$1']).lower())" 2>/dev/null; }

C=$(code_of "$C_JAR" /api/room/leave "$LEAVE2_BODY"); chk "방장이 나간다 (200)" "200" "$C"
chk "아직 방은 남아 있다" "false" "$(body_flag room_deleted)"
chk "나간 사람의 자리도 빠졌다" "1" "$(psql "$DBURL" -tAqc "select count(*) from players where room_id='$ROOM2';")"
# ★ 방장이 나갔는데 host_id 가 그대로면 남은 사람이 시작 버튼을 눌러도 403 이다.
#   그 방은 영영 시작되지 않는다 — 사람이 있는데 못 노는 방이 목록에 남는다.
chk "남은 사람이 방장이 된다" "1" \
  "$(psql "$DBURL" -tAqc "select count(*) from rooms r join players p on p.id = r.host_id where r.id='$ROOM2' and not p.is_bot;")"
# 나갈 때 쿠키를 지웠으므로 같은 브라우저가 또 눌러도 401 이 아니라 조용한 200 이다.
C=$(code_of "$C_JAR" /api/room/leave "$LEAVE2_BODY"); chk "또 눌러도 조용하다 (200)" "200" "$C"

C=$(code_of "$D_JAR" /api/room/leave "$LEAVE2_BODY"); chk "마지막 사람이 나간다 (200)" "200" "$C"
chk "방이 사라졌다고 알려준다" "true" "$(body_flag room_deleted)"
chk "방 행이 없다" "0" "$(psql "$DBURL" -tAqc "select count(*) from rooms where id='$ROOM2';")"
chk "자리도 같이 사라진다 (cascade)" "0" "$(psql "$DBURL" -tAqc "select count(*) from players where room_id='$ROOM2';")"

echo ""
[ "$FAIL" -eq 0 ] && echo "전부 통과" || echo "실패 있음"
exit "$FAIL"
