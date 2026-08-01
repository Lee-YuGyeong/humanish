/**
 * 메인 로비 진입점. 소유: C (SPEC §2, §13-1)
 *
 * 이 파일은 **서버 컴포넌트**로 남긴다. 폰트(next/font)를 여기서 불러 CSS 변수만
 * 내려주고, 화면과 상태는 전부 ./lobby.tsx("use client")가 맡는다.
 * 폰트 로더는 빌드 때 평가되므로 서버 쪽에 두는 편이 안전하고, 클라이언트 번들에도
 * 들어가지 않는다.
 *
 * 서버와 주고받는 규칙(GET/POST /api/room, /api/room/join, I1·I9·§17.6)은
 * ./lobby.tsx 머리말에 있다.
 */

import { Space_Grotesk } from "next/font/google";

import { RequireLogin } from "@/components/require-login";
import { Lobby } from "./lobby";

/**
 * 라틴 전용이다. 한글은 layout.tsx 의 IBM Plex Sans KR 로 떨어진다
 * (lobby.module.css 의 .root font-family 순서). /intro 와 같은 서체를 쓴다 —
 * 두 화면이 이어져 보여야 한다.
 */
const space = Space_Grotesk({
  variable: "--font-space",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export default function MainPage() {
  return (
    <div className={space.variable}>
      {/* 로그인해야 들어온다 (SPEC §15-2-결정) */}
      <RequireLogin>
        <Lobby />
      </RequireLogin>
    </div>
  );
}
