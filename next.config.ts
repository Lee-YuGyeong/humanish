import type { NextConfig } from "next";

/**
 * 개발 서버를 다른 오리진(터널·다른 컴퓨터)에서 열 때 허용할 호스트.
 *
 * `next dev`는 자기 오리진이 아닌 곳에서 온 /_next/* 요청을 거른다. 막히면 화면은
 * 뜨는데 HMR·정적 자산만 조용히 실패해서 원인이 잘 안 보인다.
 *
 * ┌─ ★ 와일드카드를 쓰지 않는다 ───────────────────────────────────────────────┐
 * │ `*.trycloudflare.com` 처럼 열면 편하지만, 그 도메인은 **아무나 몇 초 만에**  │
 * │ 자기 터널을 붙일 수 있는 공용 도메인이다. 열어두면 남이 만든                │
 * │ https://<아무거나>.trycloudflare.com 페이지가 내가 `next dev` 를 띄워둔      │
 * │ 동안 내 개발 서버의 /_next/* 를 크로스 오리진으로 읽을 수 있다              │
 * │ (소스맵 = 소스 코드). allowedDevOrigins 가 막으라고 있는 게 정확히 그거다.   │
 * │                                                                            │
 * │ 그래서 .env.local 의 NEXT_ORIGIN 호스트 **하나만** 넣는다. 터널 주소가       │
 * │ 바뀌면 어차피 NEXT_ORIGIN 을 고치고 world:deploy 를 다시 해야 하므로         │
 * │ 손이 더 가지도 않는다.                                                      │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * 개발 전용 설정이라 프로덕션 빌드에는 영향이 없다.
 */
function devOrigins(): string[] {
  const raw = process.env.NEXT_ORIGIN;
  if (!raw) return [];
  try {
    const { hostname } = new URL(raw);
    return hostname ? [hostname] : [];
  } catch {
    // 주소로 못 읽으면 무시한다. 여기서 빌드를 세울 이유가 없다 —
    // 값이 틀렸다는 건 npm run world:deploy 가 훨씬 분명하게 알려준다.
    return [];
  }
}

/**
 * 모든 응답에 붙이는 보안 헤더.
 *
 * 미들웨어가 아니라 여기인 이유: middleware.ts 의 matcher 는 화면(HTML)만 고른다 —
 * api/ · room/ · 확장자로 끝나는 경로를 일부러 뺀다. 보안 헤더는 그 전부에 붙어야 한다.
 * 반대로 **Cache-Control 은 여기 적으면 안 된다** — Next 가 화면 응답의 값을 나중에
 * 자기 것으로 덮어써서 조용히 무시된다 (middleware.ts 머리말). 역할이 갈려 있다.
 *
 * CSP 는 **Report-Only 로만** 건다. three.js·@react-three 와 Next 의 인라인 부트스트랩이
 * 섞여 있어서 강제로 걸면 화면이 깨질 수 있다. 수집 엔드포인트가 없으므로 위반은
 * 브라우저 콘솔에만 남는다 — /world 에서 위반 목록을 확인한 뒤 강제로 바꾼다 (SECURITY.md §5).
 */
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  // Next 의 인라인 부트스트랩 스크립트 때문에 unsafe-inline 이 필요하다.
  // wasm-unsafe-eval 은 three.js 계열이 wasm 디코더를 쓸 때를 위한 자리다.
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  // blob: 은 three.js 가 텍스처·GLB 를 만들 때 쓴다.
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  // Supabase(REST · Realtime)와 월드 워커(WebSocket).
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co wss://*.workers.dev",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  // 저장소에 iframe 사용처가 없다. 클릭재킹을 통째로 막는다.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  // 구글 로그인은 signInWithOAuth 의 전체 페이지 리다이렉트라 window.open 이 없다.
  // 팝업을 쓰기 시작하면 이 줄이 그 팝업을 끊으므로 그때 함께 고친다.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Content-Security-Policy-Report-Only", value: CSP_REPORT_ONLY },
];

const nextConfig: NextConfig = {
  allowedDevOrigins: devOrigins(),
  async headers() {
    return [
      { source: "/(.*)", headers: SECURITY_HEADERS },
      // 점검 화면은 색인하지 않는다. /api/admin 은 어디에도 링크되지 않아 제외.
      { source: "/admin", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] },
    ];
  },
  images: {
    // dangerouslyAllowSVG 는 뺐다 (2026-08-08). 그 옵션이 있던 이유는 public/roles/*.svg
    // 자리표시자를 next/image 로 그리기 위함이었는데, 그 SVG 들과 유일한 사용처
    // (components/ui/animated-testimonials.tsx) 를 함께 지웠다. 근거가 사라진 위험 옵션은
    // 남기지 않는다 — SVG 를 next/image 로 다시 그릴 일이 생기면 그때 근거와 함께 되살린다.

    // Next 의 이미지 최적화 라우트를 끄고 /public 의 원본을 그대로 내보낸다.
    //
    // 왜: Workers 에는 Next 의 최적화 서버가 없어서 @opennextjs/cloudflare 가 그 자리를
    // Cloudflare Images 바인딩으로 대신한다. 지금 화면이 쓰는 이미지는 전부 미리 구운
    // webp(public/intro/*)라 최적화 라우트를 거칠 이유가 없다. 원본을 그대로 주면 결과가
    // 같고, wrangler.jsonc 에 images 바인딩이 필요 없어진다.
    //
    // 실제 아트(png/jpg)로 교체할 때 되살린다: 이 줄을 지우고 wrangler.jsonc 에
    // "images": { "binding": "IMAGES" } 를 넣는다.
    // https://opennext.js.org/cloudflare/howtos/image
    unoptimized: true,
  },
};

// @opennextjs/cloudflare 의 initOpenNextCloudflareForDev() 는 일부러 부르지 않는다.
// 그건 `next dev` 안에서 Cloudflare 바인딩(D1·KV·R2)을 흉내 내려고 miniflare 를 띄우는
// 물건인데, 이 앱은 getCloudflareContext() 를 한 번도 부르지 않는다 — 데이터는 전부
// Supabase 다. 부르면 dev 서버 기동만 느려진다. 바인딩을 쓰기 시작하면 그때 되살린다.
export default nextConfig;
