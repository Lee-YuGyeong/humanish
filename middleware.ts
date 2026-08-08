import { NextResponse } from 'next/server';

/**
 * 화면 HTML 은 브라우저가 **매번 다시 물어보게** 한다.
 *
 * ┌─ 왜 이게 있어야 하나 (2026-08-08) ─────────────────────────────────────────┐
 * │ 카카오톡으로 방 주소를 보내면 상대가 **옛날 디자인 그대로인 게임**에         │
 * │ 들어오던 문제. 배포는 최신인데 화면만 낡아 있었다.                          │
 * │                                                                            │
 * │ Next 는 미리 그려둔 화면(/ · /intro · /main · /world)에                     │
 * │ `Cache-Control: s-maxage=31536000` 만 붙여 내보낸다. `s-maxage` 는 **CDN 만  │
 * │ 보는 값이다** — 브라우저 몫인 `max-age` 가 없으니 웹뷰 입장에선 "언제까지    │
 * │ 신선한지" 아무 정보가 없고, 그러면 제 나름의 어림짐작으로 오래 붙들고 있다.  │
 * │ 카톡 인앱 브라우저(WKWebView)가 특히 그렇다.                                │
 * │                                                                            │
 * │ 그리고 여기가 고약한 대목이다: /_next/static/* 은 파일 이름에 해시가 박혀    │
 * │ 있고 `immutable` 이라 **옛날 청크가 서버에 그대로 살아 있다.** 그래서 낡은   │
 * │ HTML 이 낡은 JS 를 정확히 찾아 불러온다 — 깨지지 않고 **멀쩡히 동작하는      │
 * │ 옛날 게임**이 된다. 깨졌으면 금방 알아챘을 텐데 그러지 않아서 오래 갔다.     │
 * │                                                                            │
 * │ /room/[code] 만 멀쩡했던 이유도 같다. 그 화면은 동적이라 Next 가 이미        │
 * │ no-store 를 붙여 내보내고 있었다. 그래서 **그 화면이 이미 쓰던 값을 그대로** │
 * │ 나머지 화면에도 준다 — 새 값을 발명하지 않는다.                             │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * next.config.ts 의 headers() 로는 안 된다. Next 가 화면 응답의 Cache-Control 을
 * 나중에 자기 값으로 덮어써서, 적어두면 조용히 무시된다. 미들웨어는 그 뒤에 붙는다.
 *
 * 잃는 것은 없다. 이 앱은 ISR 을 쓰지 않아서(wrangler.jsonc 의
 * WORKER_SELF_REFERENCE 주석) `x-nextjs-cache` 가 언제나 MISS 다 — 원래 CDN 에
 * 얹히지 않던 값이라 s-maxage 를 놓아도 달라지는 게 없다.
 */
export function middleware() {
  const res = NextResponse.next();
  res.headers.set(
    'Cache-Control',
    'private, no-cache, no-store, max-age=0, must-revalidate',
  );
  return res;
}

export const config = {
  /*
   * 화면(HTML)만 고른다. 빼는 것들과 이유:
   *
   *   api/           JSON 응답은 라우트마다 자기 캐시 규칙이 있다. 건드리지 않는다.
   *   room/          이미 no-store 다 (위 상자). 덮어써서 약하게 만들 여지만 남는다.
   *   _next/static   해시 이름 + immutable. **여기 캐시가 살아 있어야 빠르다** —
   *   _next/image    끄면 배포마다 전부 다시 받는다. public/_headers 가 맡는 몫이다.
   *   .확장자로 끝나는 것  favicon.ico · textures/*.png · *.glb 같은 실제 파일.
   *                  위와 같은 이유로 그대로 둔다.
   */
  matcher: ['/((?!api/|room/|_next/static|_next/image|.*\\.[\\w]+$).*)'],
};
