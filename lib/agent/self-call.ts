/**
 * /api/agent self-fetch 배관 — 주소와 인증 헤더. 소유: B
 *
 * LLM 호출은 /api/agent 경유만이다 (I4) — 이 파일은 키를 모른다.
 * 원래 prefill.ts(2D 게임 덮어쓰기 계층)에 있었는데, 그 계층을 지우면서
 * (2026-08-08 — 2D 게임 방이 흐름에서 빠졌다) 남은 소비자인
 * app/api/internal/world-agent 를 위해 여기로 옮겼다.
 */

/**
 * self-fetch 대상. 로컬 개발 기본값 — 배포에서 쓰게 되면 env로 넘긴다.
 *
 * ★ `||`다, `??`가 아니다. `.env.local`에 `AGENT_SELF_URL=`(이름만, 빈 값)로 두면
 *   process.env 값이 ''인데, ''는 nullish가 아니라 `??`를 통과한다. 그대로 쓰면
 *   self-fetch가 상대 URL(`/api/agent`)이 되어 서버 fetch가 "Failed to parse URL"로
 *   즉사하고, 봇 전원이 조용히 폴백으로 떨어진다 (실측 — 한 판 전체 LLM 0%).
 */
export const AGENT_SELF_URL = process.env.AGENT_SELF_URL || 'http://127.0.0.1:3000';

/**
 * self-fetch 헤더. 프로덕션 /api/agent는 내부 Bearer(AGENT_SHARED_SECRET)로만 열린다 —
 * world-room 규약과 같다. 비밀이 없으면(개발) 그냥 간다.
 * LLM API 키가 아니다 — 그건 여전히 라우트만 안다 (I4).
 */
export function agentHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const secret = process.env.AGENT_SHARED_SECRET;
  if (secret) headers.authorization = `Bearer ${secret}`;
  return headers;
}
