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

const nextConfig: NextConfig = {
  allowedDevOrigins: devOrigins(),
  images: {
    // public/roles/*.svg 자리표시자를 next/image 로 쓰기 위함.
    // 원격 이미지는 허용하지 않고(remotePatterns 없음), 아래 CSP 로 스크립트 실행을 막는다.
    // 실제 아트(png/jpg)로 교체한 뒤에는 이 블록을 지워도 된다.
    dangerouslyAllowSVG: true,
    contentDispositionType: "attachment",
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",

    // Next 의 이미지 최적화 라우트를 끄고 /public 의 원본을 그대로 내보낸다.
    //
    // 왜: Workers 에는 Next 의 최적화 서버가 없어서 @opennextjs/cloudflare 가 그 자리를
    // Cloudflare Images 바인딩으로 대신한다. 그런데 Cloudflare Images 는 **SVG 를
    // 변환하지 못한다** — 지금 next/image 로 그리는 건 public/roles/*.svg 하나뿐이라
    // (components/ui/animated-testimonials.tsx) 바인딩을 붙여봤자 실패할 자리만 는다.
    // 원본을 그대로 주면 결과가 같고, wrangler.jsonc 에 images 바인딩이 필요 없어진다.
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
