#!/usr/bin/env bash
# PreToolUse 훅 진입점. 실제 판정은 deny-secrets.mjs 가 한다.
# (settings.json 의 hooks 경로 변경은 세션 재시작이 필요하므로 이 래퍼를 고정 진입점으로 둔다)
set -uo pipefail
exec node "$(dirname "${BASH_SOURCE[0]}")/deny-secrets.mjs"
