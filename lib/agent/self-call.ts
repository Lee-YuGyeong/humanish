/**
 * /api/agent self-fetch 배관 — 주소와 인증 헤더. 소유: B
 *
 * LLM 호출은 /api/agent 경유만이다 (I4) — 이 파일은 키를 모른다.
 * 원래 prefill.ts(2D 게임 덮어쓰기 계층)에 있었는데, 그 계층을 지우면서
 * (2026-08-08 — 2D 게임 방이 흐름에서 빠졌다) 남은 소비자인
 * app/api/internal/world-agent 를 위해 여기로 옮겼다.
 */

/**
 * self-fetch 대상 오리진 — **들어온 요청에서 딴다.**
 *
 * ┌─ ★ 계정 주소를 설정 파일에 못 박지 않는다 (2026-08-09) ────────────────────┐
 * │ 예전엔 wrangler.jsonc 의 vars 에 `https://humanish.<계정>.workers.dev` 를   │
 * │ 적어 뒀다. 두 가지가 나빴다.                                               │
 * │                                                                            │
 * │  1. 배포 계정을 옮기면 커밋이 필요했고, 옛 주소가 남아도 **아무 에러가      │
 * │     안 난다** — 페이즈 전환은 성공하고 봇 답변만 조용히 폴백으로 떨어진다.  │
 * │  2. 그렇다고 평문 var 를 대시보드에 손으로 넣어 두면 **다음 배포에 날아간다**│
 * │     — `wrangler deploy` 는 vars 를 설정 파일 기준으로 통째 덮어쓴다.        │
 * │     (비밀은 안 그렇다. 그래서 비밀만 대시보드에 두는 게 안전하다.)          │
 * │                                                                            │
 * │ 이 self-fetch 는 **항상 요청을 처리하는 중에** 일어난다(world-agent). 그러니 │
 * │ 그 요청이 들어온 오리진이 곧 자기 공개 주소다 — 로컬이면 127.0.0.1:3000,    │
 * │ 배포면 그 계정의 workers.dev 로 저절로 맞는다. 설정할 게 없다.              │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * `host` 헤더를 먼저 본다. `req.url` 은 어댑터에 따라 내부 주소로 바뀌어 있을 수 있다.
 *
 * ★ env 로 못 박고 싶으면 `AGENT_SELF_URL` 이 여전히 이긴다. 이때 `||`다, `??`가
 *   아니다 — `.env.local`에 `AGENT_SELF_URL=`(이름만, 빈 값)로 두면 process.env 값이
 *   ''인데, ''는 nullish가 아니라 `??`를 통과한다. 그대로 쓰면 self-fetch가 상대
 *   URL(`/api/agent`)이 되어 서버 fetch가 "Failed to parse URL"로 즉사하고, 봇 전원이
 *   조용히 폴백으로 떨어진다 (실측 — 한 판 전체 LLM 0%).
 */
export function agentSelfUrl(req?: Request): string {
  const pinned = process.env.AGENT_SELF_URL;
  if (pinned) return pinned;

  const host = req?.headers.get('host');
  if (host) {
    const local = host.startsWith('127.0.0.1') || host.startsWith('localhost');
    const proto = req?.headers.get('x-forwarded-proto') ?? (local ? 'http' : 'https');
    return `${proto}://${host}`;
  }

  if (req) {
    try {
      return new URL(req.url).origin;
    } catch {
      /* 아래 로컬 기본값으로 */
    }
  }

  return 'http://127.0.0.1:3000';
}

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
