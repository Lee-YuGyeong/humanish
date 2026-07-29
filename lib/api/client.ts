/**
 * HTTP 전송 계층. 소유: A
 *
 * 이 파일은 **React 를 모른다.** 훅도, 캐시도, 상태도 없다 —
 * "요청을 보내고 JSON 을 돌려준다"만 한다. 캐시는 lib/queries 가, 화면 상태는
 * lib/store 가 맡는다. 계층을 가르는 이유는 이 한 줄이면 충분하다:
 * **여기까지는 노드에서도 그대로 돌아야 한다** (테스트·스크립트가 같은 함수를 쓴다).
 *
 * ┌─ 에러 모양을 여기서 한 번만 정규화한다 ────────────────────────────────────┐
 * │ 라우트는 실패할 때 { error: "..." } + 4xx/5xx 를 준다 (lib/server/auth.ts   │
 * │ 의 apiError). 그 형태를 화면마다 풀어 쓰면 어떤 화면은 error 를 읽고 어떤   │
 * │ 화면은 status 만 보게 된다. 여기서 전부 ApiRequestError 로 바꾼다.          │
 * └────────────────────────────────────────────────────────────────────────────┘
 */

/** 라우트가 준 message 를 그대로 들고 다니는 에러. 화면은 이 message 를 띄우면 된다. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/**
 * 응답을 JSON 으로 읽고 실패면 던진다.
 *
 * ★ 본문이 JSON 이 아닐 수 있다. 502·타임아웃이면 프록시가 HTML 을 준다.
 *   그걸 그대로 JSON.parse 하면 "Unexpected token <" 이 화면에 뜬다 —
 *   원인과 무관한 문구라 디버깅이 한참 돌아간다. 상태 코드를 먼저 말해준다.
 */
async function unwrap<T>(res: Response, path: string): Promise<T> {
  const text = await res.text();

  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiRequestError(res.status, `${path} 응답이 JSON이 아니다 (${res.status})`);
  }

  if (!res.ok) {
    const message =
      typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `${path} ${res.status}`;
    throw new ApiRequestError(res.status, message);
  }

  return body as T;
}

/**
 * GET. 쿠키는 같은 오리진이라 자동으로 실린다.
 *
 * cache: 'no-store' 는 습관이 아니라 필요다. 방 상태·내 정보는 전부 시시각각
 * 바뀌는데, Next 의 fetch 는 기본으로 캐시할 수 있다. 신선도는 react-query 가
 * 관리하므로 전송 계층은 항상 실물을 가져온다.
 */
export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { cache: 'no-store', signal });
  return unwrap<T>(res, path);
}

/** POST. 쓰기는 전부 이 경로를 지난다 (I9 — anon 키로 쓰지 않는다). */
export async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  return unwrap<T>(res, path);
}
