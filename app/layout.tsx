import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans_KR } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

/**
 * ┌─ 왜 IBM Plex 인가 ──────────────────────────────────────────────────────┐
 * │ 원래 Geist(Next 기본값)를 subsets:["latin"]으로만 불러왔다. 그런데       │
 * │ **Geist에는 한글 글자가 없다.** 화면의 대부분이 한국어라 그 부분이 전부  │
 * │ 시스템 폰트로 떨어졌다 — 맥은 Apple SD Gothic Neo, 윈도우는 맑은 고딕.   │
 * │ 보는 기기마다 다른 서체로 보였고, 여기서 맞춘 자간·굵기가 내 화면에서만 │
 * │ 맞는 상태였다.                                                          │
 * │                                                                        │
 * │ IBM Plex는 산업·기술 문서용으로 설계된 서체다. 창고·장비·계기판이라는   │
 * │ 이 화면의 성격과 맞고, 한글(Sans KR)과 고정폭(Mono)이 같은 집안이라     │
 * │ 계기판 숫자와 본문이 따로 놀지 않는다.                                  │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * next/font/google 은 빌드 때 받아 **자체 호스팅**한다. 런타임에 외부 요청이 없다.
 */
/**
 * ★ preload: false 는 실수가 아니다.
 *
 * 한글 폰트는 Google이 유니코드 구간별로 수백 조각으로 쪼개서 준다. 기본값(preload:true)
 * 이면 그 조각이 전부 <link rel="preload">로 나가는데, 실제로 재보니 **한 페이지에 234개**
 * 였다. 브라우저 커넥션을 그걸로 다 쓰고 정작 화면에 필요한 것이 뒤로 밀린다.
 *
 * 끄면 unicode-range 를 보고 **그 페이지에 실제로 쓰인 글자가 든 조각만** 받아온다.
 * CJK에서는 이쪽이 정석이다. display:swap 이라 받아오는 동안 폴백으로 먼저 그린다.
 */
const plexSans = IBM_Plex_Sans_KR({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  // ★ 굵기를 늘리지 않는다. 한글 폰트는 굵기마다 유니코드 구간별 조각이 100개 가까이
  //   딸려오고, 그 @font-face 선언이 그대로 CSS 용량이 된다. 400/600/700로 화면의
  //   font-semibold·font-bold·font-black을 전부 덮는다 (900은 700으로 떨어진다).
  //   500(font-medium)은 쓰는 곳이 없어서 뺐다 — 그것만으로 폰트 CSS가 1/4 줄었다.
  weight: ["400", "600", "700"],
  display: "swap",
  preload: false,
  // 폰트가 늦게 와도 글자 크기가 크게 튀지 않도록 비슷한 한글 시스템 폰트를 먼저 세운다
  fallback: ["Apple SD Gothic Neo", "Malgun Gothic", "system-ui", "sans-serif"],
});

// Mono는 라틴만이라 조각이 몇 개 안 된다. 계기판 숫자와 스텐실에만 쓴다.
const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "사람인 척",
  description: "3~8명 중 누가 AI인지 찾는 게임",
};

/*
 * ★ viewport 를 **여기 두지 않는다.** 3D 월드는 노치 끝까지 화면을 쓰려고
 *   `viewport-fit=cover` 가 필요한데, 그건 앱 전체에 걸리면 아직 모바일 대응이 안 된
 *   다른 화면(로비·기록·계정)의 글자를 노치 밑으로 밀어 넣는다.
 *   그래서 그 설정은 `app/world/layout.tsx` 에만 있다 — 필요한 화면 하나에만 건다.
 *   여기에 아무것도 없으면 Next 가 기본값(width=device-width, initial-scale=1)을 넣는다.
 */

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className={`${plexSans.variable} ${plexMono.variable} antialiased`}>
        {/*
          창고 — 모든 화면 뒤에 깔리는 공간 (app/globals.css의 .room).

          벽은 rotateY, 바닥은 rotateX로 **실제 원근 변환**을 받는다. 그래서 골강판 골과
          슬래브 눈금이 소실점을 향해 저절로 좁아진다 — 평면에 그린 격자와 다른 점이다.
          JS는 한 줄도 쓰지 않는다.

          /world 의 진짜 Three.js 씬(app/world/warehouse.tsx)은 자기 캔버스로 이걸 덮는다.
        */}
        <div aria-hidden className="room">
          <div className="room-wall room-wall-l" />
          <div className="room-wall room-wall-r" />
          <div className="room-floor" />
          <div className="room-screen" />
        </div>
        {/*
          서버 값 캐시(react-query). 배경 div 바깥이 아니라 children 만 감싼다 —
          배경은 순수 CSS라 프로바이더가 필요 없고, 여기서 감싸면 layout이
          클라이언트 컴포넌트가 되어 서버 렌더의 이점을 잃는다.
        */}
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
