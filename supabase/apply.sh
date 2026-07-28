#!/usr/bin/env bash
#
# 사람인 척 (whois-human) — 실제 Supabase 프로젝트에 스키마를 올린다
# SPEC §4, §7, §12.1, §17. 소유: A
#
#   ./supabase/apply.sh          # 확인 후 적용
#   ./supabase/apply.sh --yes    # 확인 없이
#   ./supabase/apply.sh --check  # 적용하지 않고 현재 상태만 점검
#
# .env.local의 SUPABASE_DB_URL_DIRECT로 붙는다.
# 로컬에서 스키마를 시험만 해보려면 이게 아니라 ./supabase/test.sh를 쓴다.
#
# ★ 이건 진짜 DB를 고친다. 파일들은 여러 번 돌려도 되게 짜여 있지만,
#   이미 게임이 돌고 있는 DB에 돌리면 진행 중인 방이 영향을 받을 수 있다.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE=apply
case "${1:-}" in
  --yes)   MODE=yes ;;
  --check) MODE=check ;;
  "")      ;;
  *) echo "모르는 옵션: $1"; exit 1 ;;
esac

command -v psql >/dev/null || { echo "psql이 없다. brew install postgresql@16"; exit 1; }

# ── 접속 문자열 ──────────────────────────────────────────────────────────────
DB_URL="${SUPABASE_DB_URL_DIRECT:-}"
if [ -z "$DB_URL" ] && [ -f "$ROOT/.env.local" ]; then
  DB_URL="$(grep -E '^[[:space:]]*SUPABASE_DB_URL_DIRECT=' "$ROOT/.env.local" | head -1 | cut -d= -f2-)"
  DB_URL="${DB_URL%\"}"; DB_URL="${DB_URL#\"}"
  DB_URL="${DB_URL%\'}"; DB_URL="${DB_URL#\'}"
fi

if [ -z "$DB_URL" ] || [[ "$DB_URL" == *PASSWORD* ]] || [[ "$DB_URL" == *xxxxxx* ]]; then
  cat <<'EOF'
SUPABASE_DB_URL_DIRECT이 비어 있거나 예시값 그대로다.

  1) cp .env.local.example .env.local
  2) Supabase 대시보드 → Project Settings → Database → Connection string
     거기 있는 문자열을 .env.local의 SUPABASE_DB_URL_DIRECT에 붙여넣는다.

  ※ "Direct connection"이 안 붙으면(IPv6 전용이라 그럴 수 있다)
    같은 화면의 "Session pooler" 문자열을 쓴다. 포트는 5432 그대로다.
    Transaction pooler(6543)는 마이그레이션에 쓰지 않는다 — SPEC §12.2
EOF
  exit 1
fi

# 로그에 비밀번호를 남기지 않는다
SAFE_URL="$(printf '%s' "$DB_URL" | sed -E 's#(//[^:]+:)[^@]+@#\1****@#')"
echo "▸ 대상: $SAFE_URL"

if ! ERR="$(PGCONNECT_TIMEOUT=10 psql "$DB_URL" -tAqc 'select 1' 2>&1)"; then
  echo "  ✗ 접속 실패"
  echo ""
  # 흔한 실수부터 짚는다
  if [[ "${DB_URL#postgresql://}" == *"://"* ]]; then
    cat <<'EOF'
  주소 안에 http:// 나 https:// 가 들어 있다.
  Project URL(https://xxxx.supabase.co)을 접속 문자열 자리에 붙여넣은 경우다.
  이 둘은 다른 값이다. Database → Connection string 쪽 문자열을 통째로 써야 한다.
EOF
  elif [[ "$ERR" == *"could not translate host name"* ]]; then
    cat <<'EOF'
  호스트 이름이 풀리지 않는다. Supabase 직결 주소(db.<ref>.supabase.co)는 IPv6 전용이라
  IPv6가 없는 네트워크에서는 이름조차 못 푼다. 비밀번호 문제가 아니다.

  → 대시보드 Database → Connection string에서 "Session pooler"를 고른다.
     postgresql://postgres.<ref>:<비번>@aws-0-<region>.pooler.supabase.com:5432/postgres
     아이디에 점이 붙고 주소가 pooler.supabase.com이면 제대로 고른 것이다.
     Transaction pooler(6543)는 마이그레이션에 쓰지 않는다 (SPEC §12.2).
EOF
  elif [[ "$ERR" == *"password authentication failed"* ]]; then
    cat <<'EOF'
  비밀번호가 틀렸다. 접속 문자열을 복사하면 비밀번호 자리가 [YOUR-PASSWORD] 같은
  껍데기로 들어 있다. 프로젝트 만들 때 정한 DB 비밀번호로 바꿔야 한다.
  기억나지 않으면 Database → Database password에서 재설정한다.
  비밀번호에 @ : / ? # 가 있으면 URL 인코딩이 필요하다 (@ → %40).
EOF
  elif [[ "$ERR" == *"timeout"* || "$ERR" == *"Connection refused"* ]]; then
    echo "  주소까지는 풀렸는데 응답이 없다. 포트가 5432인지, 방화벽에 막히지 않는지 확인할 것."
  fi
  echo ""
  echo "  psql 원문: $(printf '%s' "$ERR" | sed -E 's#(//[^:]+:)[^@]+@#\1****@#' | head -2)"
  exit 1
fi
echo "  ✓ 접속됨 (Postgres $(psql "$DB_URL" -tAqc 'show server_version'))"

# ── 적용 ────────────────────────────────────────────────────────────────────
if [ "$MODE" != check ]; then
  if [ "$MODE" = apply ]; then
    echo ""
    read -r -p "이 DB에 schema · policies · seed · functions 전부를 적용한다. 계속? [y/N] " ans
    [ "$ans" = y ] || [ "$ans" = Y ] || { echo "취소했다."; exit 1; }
  fi

  # ★ functions/ 아래를 하나라도 빠뜨리면 화면은 멀쩡한데 기능만 죽는다.
  #   room.sql · chat.sql이 원래 이 목록에 없었고, 그래서 방 만들기 · 입장 · 채팅이
  #   배포 DB에서만 500으로 죽는 상태였다. test.sh는 여섯 개를 전부 올리므로
  #   로컬 검증만 초록색이었다. 새 SQL 파일을 만들면 여기에도 반드시 더한다.
  echo ""
  for f in schema.sql policies.sql seed.sql \
           functions/advance_phase.sql functions/room.sql functions/chat.sql; do
    printf '  %-32s' "$f"
    if out="$(psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/$f" 2>&1)"; then
      echo "✓"
      printf '%s\n' "$out" | grep -i 'WARNING' | sed 's/^/       ⚠ /' || true
    else
      echo "✗"; printf '%s\n' "$out" | tail -20; exit 1
    fi
  done
fi

# ── 점검 ────────────────────────────────────────────────────────────────────
FAIL=0
q()     { psql "$DB_URL" -tAqc "$1" 2>&1 | head -1; }
check() { if [ "$2" = "$3" ]; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s  (기대 %s / 실제 %s)\n' "$1" "$2" "$3"; FAIL=1; fi; }

echo ""
echo "── 점검 ──"

# ★ 목록은 supabase/checks.sh 하나다. test.sh도 같은 것을 돌린다.
#   **여기에 검사를 직접 적지 않는다** — 한쪽에만 있는 검사가 사고를 두 번 냈다.
#   이유는 그 파일 머리말에 있다.
# shellcheck source=./checks.sh
. "$ROOT/supabase/checks.sh"
schema_checks

echo ""
echo "── 배포 DB에만 있는 것 ──"
# ★ 워치독. 이게 없으면 데모 중에 방이 멈춘다 (SPEC §12.1) — 선택이 아니다.
#   로컬 Postgres에는 pg_cron이 없으므로 이 검사만 checks.sh 밖에 남긴다.
CRON="$(q "select count(*) from cron.job where jobname='phase-watchdog';")"
if [ "$CRON" = "1" ]; then
  echo "  ✓ pg_cron 워치독이 등록돼 있다"
  RUNS="$(q "select count(*) from cron.job_run_details d join cron.job j on j.jobid=d.jobid where j.jobname='phase-watchdog';")"
  echo "     지금까지 실행 횟수: $RUNS  (0이면 15초쯤 뒤에 --check로 다시 볼 것)"
else
  echo "  ✗ pg_cron 워치독이 없다 — 대시보드 Database → Extensions에서 pg_cron을 켜고"
  echo "    이 스크립트를 다시 돌릴 것. 없으면 방이 멈춘다 (SPEC §12.1)"
  FAIL=1
fi

echo ""
[ "$FAIL" -eq 0 ] && echo "전부 정상" || echo "위의 ✗를 볼 것"
exit "$FAIL"
