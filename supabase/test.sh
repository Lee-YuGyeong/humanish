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
for f in schema.sql policies.sql seed.sql functions/advance_phase.sql functions/room.sql functions/chat.sql functions/lobby.sql; do
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

# ★ apply.sh(배포 DB)와 **같은 스키마 검사**를 먼저 돌린다.
#   여기서만 통과하고 배포에서 깨지는(또는 그 반대인) 사고를 두 번 냈다.
#   이유와 목록은 supabase/checks.sh에 있다. 새 검사는 그쪽에 넣는다.
# shellcheck source=./checks.sh
. "$ROOT/supabase/checks.sh"
schema_checks

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

# ★ 사람이 혼자면 시작할 수 없다 (SPEC §8, §17.6).
#   혼자 시작하면 assignRoles가 스파이를 배정하지 않고 남은 자리가 전부 봇이라
#   **아무나 찍어도 정답**이다. 정원 하한 3의 근거를 실제로 강제하는 자리다 —
#   여지만 만들고 강제하지 않으면 아무 의미가 없다.
SOLO=55555555-5555-5555-5555-555555555555
SOLO_P1=55555555-0000-0000-0000-000000000001
psql -q -c "
insert into rooms (id, code, capacity, host_id) values ('$SOLO','SOLO',5,'$SOLO_P1');
insert into players (id, room_id, nickname, mask_id, seat, is_bot) values
  ('$SOLO_P1','$SOLO','익명1','m1',1,false);
insert into player_roles (player_id, room_id, role) values ('$SOLO_P1','$SOLO','citizen');"
check "사람 혼자면 시작 못 한다"       "denied" \
  "$(denied_if "select advance_phase('$SOLO',0,'$SOLO_P1');" '2명 이상')"
psql -q -c "insert into players (id, room_id, nickname, mask_id, seat, is_bot) values
  ('55555555-0000-0000-0000-000000000002','$SOLO','익명2','m2',2,false);"
check "둘이 되면 시작된다"             "t" "$(q "select advance_phase('$SOLO',0,'$SOLO_P1');")"

echo ""
echo "── question 진입 훅 (SPEC §5.3, §17.2) ──"
check "질문 1개 생성"                 "1" "$(q "select count(*) from questions where room_id='$R';")"
check "봇 3명 답변 생성"              "3" "$(q "select count(*) from answers where room_id='$R';")"
check "봇 답변은 페이즈 종료 시각에 공개" "t" \
  "$(q "select coalesce(bool_and(a.visible_at = r.phase_ends_at),false) from answers a join rooms r on r.id=a.room_id where r.id='$R';")"

# ★ 봇끼리 같은 말을 하면 그것만으로 둘 다 봇이다 (I1). 옛 코드는 봇마다 따로 뽑아서
#   봇 6명이면 약 68% 확률로 겹쳤다. 지금은 번호를 매겨 1:1로 붙인다.
check "봇 답변이 서로 겹치지 않는다 (I1)" "t" \
  "$(q "select count(distinct text) = count(*) from answers where room_id='$R';")"

# ★ 그리고 질문에 맞아야 한다. 전부 일반 문구(question_text is null)로만 채워지면
#   "질문에 안 맞는 답 = 봇"이라는 옛 증상이 그대로 돌아온다.
check "봇 답변이 그 질문 전용 문구에서 나온다" "t" \
  "$(q "select bool_or(exists (
          select 1 from bot_line_pool bl join questions qq on qq.id = a.question_id
           where bl.phase='question' and bl.question_text = qq.text and bl.text = a.text))
        from answers a where a.room_id='$R';")"

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
echo "── target: 대상이 누구든 조기 종료하지 않는다 (I1, SPEC §5.3) ──"
# ★ 여기가 이 저장소에서 제일 미끄러운 자리다.
#   'all-humans'면 봇이 대상일 때 0초에 끝나 대상이 봇임이 드러난다.
#   'human-target-only'(대상이 사람일 때만 조기 종료)도 답이 아니다 — 방향만 뒤집혀서
#   "빨리 넘어갔다 = 대상은 사람"이 확정된다. 한때 실제로 그 상태였다.
#   그래서 **양쪽 다 시간을 채운다.** 두 검사가 같이 f여야 대칭이 지켜진 것이다.
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
check "대상=사람이어도 조기종료 안 함"  "f" "$(q "select early_exit_met('$R','target',2);")"

echo ""
echo "── 나머지 페이즈 진행 ──"
for want in chat vote reveal; do
  psql -q -c "update rooms set phase_ends_at = now() - interval '1s' where id='$R';"
  q "select advance_expired_rooms();" >/dev/null
  check "→ $want" "$want" "$(q "select phase from rooms where id='$R';")"
done
check "봇 투표 3건 생성"              "3" "$(q "select count(*) from votes v join players p on p.id=v.voter_id where v.room_id='$R' and p.is_bot;")"
# 이유가 겹치면 reveal 화면에 똑같은 문장이 나란히 뜬다. 옛 코드는 풀이 8개라
# 봇 6명이면 약 92% 확률로 겹쳤다 (I1).
check "봇 투표 이유가 서로 겹치지 않는다" "t" \
  "$(q "select count(distinct v.reason) = count(*) from votes v join players p on p.id=v.voter_id where v.room_id='$R' and p.is_bot;")"
check "replay에서는 더 안 간다"        "f" "$(q "select advance_phase('$R',(select phase_seq from rooms where id='$R'),'$P1');" >/dev/null; q "select advance_phase('$R',(select phase_seq from rooms where id='$R'),'$P1');")"

echo ""
echo "── 시작 때 자리를 다시 섞는다 (SPEC §15-3-결정) ──"
# 대기실에서 본 정체가 게임으로 이어지지 않아야 한다. 자리·닉네임·가면이 한 순열로 움직인다.
SHUF_R=44444444-4444-4444-4444-444444444444
psql -q -c "
insert into rooms (id, code, capacity) values ('$SHUF_R','SHUF',8);
insert into players (room_id, nickname, mask_id, seat, is_bot)
select '$SHUF_R', '익명'||s, 'mask-'||lpad(s::text,2,'0'), s, s > 3
  from generate_series(1,8) s;"
BEFORE_SET="$(q "select string_agg(id::text, ',' order by id) from players where room_id='$SHUF_R';")"
BEFORE_MAP="$(q "select string_agg(id::text||':'||seat, ',' order by id) from players where room_id='$SHUF_R';")"
BEFORE_RS="$(q "select roster_seq from rooms where id='$SHUF_R';")"

check "8명을 다시 배정한다"          "8" "$(q "select shuffle_seats('$SHUF_R');")"
check "사람은 그대로 8명"            "8" "$(q "select count(*) from players where room_id='$SHUF_R';")"
check "자리는 1~8이 정확히 한 번씩"   "t" \
  "$(q "select array_agg(seat order by seat) = array(select generate_series(1,8)) from players where room_id='$SHUF_R';")"
check "닉네임이 새 자리를 따라간다"    "t" \
  "$(q "select coalesce(bool_and(nickname = '익명'||seat and mask_id = 'mask-'||lpad(seat::text,2,'0')),false) from players where room_id='$SHUF_R';")"
check "플레이어 자체는 안 바뀐다"      "$BEFORE_SET" \
  "$(q "select string_agg(id::text, ',' order by id) from players where room_id='$SHUF_R';")"
# ★ 핵심: 자리 배치가 실제로 달라졌나. 8!이라 우연히 같을 확률은 1/40320이다.
check "배치가 바뀌었다"              "changed" \
  "$([ "$BEFORE_MAP" = "$(q "select string_agg(id::text||':'||seat, ',' order by id) from players where room_id='$SHUF_R';")" ] && echo same || echo changed)"
# 얼마나 오르는지는 트리거 구현 나름이다(행마다 1). 클라이언트는 "변했나"만 본다.
check "명단 신호가 올라간다 (§17.3)"  "up" \
  "$([ "$(q "select roster_seq from rooms where id='$SHUF_R';")" -gt "$BEFORE_RS" ] && echo up || echo same)"
# 봇 수는 섞어도 보존된다 — 공개하는 값이므로 흔들리면 안 된다 (§15-3-결정)
check "봇 수는 그대로 5"             "5" "$(q "select count(*) from players where room_id='$SHUF_R' and is_bot;")"

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
# public_messages의 컬럼 목록(created_at이 없는지)은 schema_checks가 본다.
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

# 「권한 자체가 없어야 한다」(anon의 테이블 쓰기 · 함수 실행)는 위의 schema_checks가
# 이미 돌렸다. supabase/checks.sh로 옮겨서 apply.sh와 목록을 공유한다.

echo ""
echo "── 반대로 이건 보여야 정상 ──"
# 공개 시각이 지난 답변을 하나 만들어둔다. 위에서 만든 답변은 전부 visible_at이 미래라
# 그대로 두면 "안 보이는 게 정상"인 상태다.
psql -q -c "update answers set visible_at = now() - interval '1s'
             where room_id='$R' and player_id='$P1';"
check "public_players (A방 5명)"       "5" "$(psql -tAq -c "set role anon; select count(*) from public_players where room_id='$R';")"
# ★ 고정 숫자로 세지 않는다. 뒤에서 방을 하나라도 더 만들면 무관한 검사가 깨진다
#   (실제로 §15-3 테스트를 넣다가 걸렸다). 여기서 볼 것은 "anon이 rooms를 읽는가"이지
#   방이 몇 개인가가 아니다. service_role이 보는 수와 같으면 통과다.
check "rooms 조회 (코드로 방 찾기)"     "$(q "select count(*) from rooms;")" \
  "$(psql -tAq -c "set role anon; select count(*) from rooms;")"
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
echo "── 나가기: 마지막 사람이 나가면 방이 사라진다 ──"
# ★ 이 블록도 방을 만든다. 위의 "rooms 조회 (코드로 방 찾기)"가 방 개수를 세므로
#   반드시 그 뒤에 둔다. 코드는 앞의 것들과 겹치지 않아야 한다.
LV_R="$(q "select room_id from create_room('LEVA', 4);")"
LV_HOST="$(q "select id from players where room_id='$LV_R';")"
LV_P2="$(q "select player_id from join_room('LEVA');")"
check "둘이 앉아 있다"                  "2" "$(q "select count(*) from players where room_id='$LV_R';")"

check "한 명 나가도 방은 남는다"         "f" "$(q "select room_deleted from leave_room('$LV_R','$LV_HOST');")"
check "나간 사람의 자리도 빠진다"        "1" "$(q "select count(*) from players where room_id='$LV_R';")"
# ★ 방장이 나갔는데 host_id 가 그대로면 남은 사람은 시작 버튼을 눌러도 거절당한다
#   (advance_phase 가 actor = host_id 를 본다). 그 방은 영영 시작되지 않는다.
check "방장이 나가면 남은 사람이 방장"    "$LV_P2" "$(q "select host_id from rooms where id='$LV_R';")"

check "마지막 사람이 나가면 방이 사라진다" "t" "$(q "select room_deleted from leave_room('$LV_R','$LV_P2');")"
check "방 행이 없다"                    "0" "$(q "select count(*) from rooms where id='$LV_R';")"
check "자리도 같이 사라진다 (cascade)"    "0" "$(q "select count(*) from players where room_id='$LV_R';")"
# 두 번 눌러도 에러가 아니다 — 이미 없는 방은 나가려던 사람 입장에서 성공이다.
check "없는 방에 또 나가도 조용하다"      "t" "$(q "select room_deleted from leave_room('$LV_R','$LV_P2');")"

# ★ 봇까지 세면(I5 위반) fill_with_bots 가 돈 방은 사람이 다 나가도 영영 안 지워진다.
LV_B="$(q "select room_id from create_room('LEVB', 5);")"
LV_BH="$(q "select id from players where room_id='$LV_B';")"
q "select fill_with_bots('$LV_B');" >/dev/null
check "봇으로 5자리가 찼다"             "5" "$(q "select count(*) from players where room_id='$LV_B';")"
check "봇만 남아도 방은 사라진다 (I5)"   "t" "$(q "select room_deleted from leave_room('$LV_B','$LV_BH');")"
check "봇도 같이 사라진다"              "0" "$(q "select count(*) from players where room_id='$LV_B';")"

# 게임 중 이탈은 SPEC §15-4 미결정이다. 행을 지우면 answers·votes 가 cascade 로
# 같이 사라져 그 판의 집계가 어긋난다 — 정해지기 전까지는 거절하는 편이 맞다.
LV_C="$(q "select room_id from create_room('LEVC', 3);")"
LV_CH="$(q "select id from players where room_id='$LV_C';")"
psql -q -c "update rooms set phase='question' where id='$LV_C';"
check "시작한 방에서는 자리를 못 뺀다 (§15-4)" "denied" \
  "$(denied_if "select * from leave_room('$LV_C','$LV_CH');" '시작한 방')"
check "거절된 뒤에도 자리는 그대로"      "1" "$(q "select count(*) from players where room_id='$LV_C';")"

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "전부 통과 (SPEC §14.2 · §14.3 · §14.4)"
else
  echo "실패한 항목이 있다. 위의 ✗를 볼 것"
fi
exit "$FAIL"
