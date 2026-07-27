#!/usr/bin/env bash
# PreToolUse 훅 진입점. 실제 판정은 deny-secrets.mjs 가 한다.
# (settings.json 의 hooks 경로 변경은 세션 재시작이 필요하므로 이 래퍼를 고정 진입점으로 둔다)
#
# Bash 우회(`cat .env.local`, base64, cp 반출 …) 차단은 permissions.deny 로는 못 막아서
# 이 훅이 유일한 방어선이다. 그래서 node 를 못 찾으면 통과가 아니라 **차단**한다.
set -uo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "차단됨: 비밀 파일 차단 훅을 실행할 node 를 찾지 못했습니다." >&2
  echo "- Node.js 를 설치하면 해제됩니다 (이 저장소는 Next.js 프로젝트라 어차피 필요합니다)." >&2
  exit 2
fi

exec node "$(dirname "${BASH_SOURCE[0]}")/deny-secrets.mjs"
