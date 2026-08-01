/**
 * 로그인 라우트. 소유: A (SPEC §15-2-결정)
 *
 * /login?next=/room/ABCD — RequireLogin 이 원래 가려던 주소를 담아 보낸다.
 * 화면 본체는 components/login-screen.tsx 다 (`/` 와 같은 화면을 그린다).
 */
import { Space_Grotesk } from 'next/font/google';
import { Suspense } from 'react';

import { LoginScreen } from '@/components/login-screen';

/**
 * 로비(/main)·인트로와 같은 서체다. 라틴만 쓰고 한글은 layout.tsx 의
 * IBM Plex Sans KR 로 떨어진다 — 로그인에서 로비로 넘어갈 때 글자가 바뀌면 안 된다.
 */
const space = Space_Grotesk({
  variable: '--font-space',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

export default function LoginPage() {
  // useSearchParams 는 Suspense 경계를 요구한다 (Next 15).
  return (
    <div className={space.variable}>
      <Suspense fallback={null}>
        <LoginScreen />
      </Suspense>
    </div>
  );
}
