/**
 * 이름 짓기 진입점. 소유: A (SPEC §15-2-결정)
 *
 * 이 파일은 **서버 컴포넌트**로 남긴다. 폰트(next/font)를 여기서 불러 CSS 변수만
 * 내려주고, 화면과 상태는 ./nickname-form.tsx("use client")가 맡는다.
 * /login · /main 과 같은 구조다.
 *
 * ★ 예전에는 "작업 보드(app/workspaces.ts)에 넣지 않는다" 는 단서가 붙어 있었다.
 *   그 보드는 2026-08-08에 없앴다 — 이 화면은 원래부터 개발용 목록이 아니라
 *   사용자 흐름의 일부였고, 이제 그 목록 자체가 없다.
 */
import { Space_Grotesk } from 'next/font/google';
import { Suspense } from 'react';

import { NicknameForm } from './nickname-form';

/**
 * 로그인·로비와 같은 서체다. 라틴만 쓰고 한글은 layout.tsx 의 IBM Plex Sans KR 로
 * 떨어진다 — 로그인에서 로비로 넘어가는 중간에 글자가 바뀌면 안 된다.
 */
const space = Space_Grotesk({
  variable: '--font-space',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

export default function NicknamePage() {
  // useSearchParams 는 Suspense 경계를 요구한다 (Next 15).
  return (
    <div className={space.variable}>
      <Suspense fallback={null}>
        <NicknameForm />
      </Suspense>
    </div>
  );
}
