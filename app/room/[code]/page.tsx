/**
 * 게임 화면. 소유: C (SPEC §2)
 *
 * 껍데기만 서버 컴포넌트다 — 실시간 구독과 타이머가 필요해서 본체는 클라이언트다.
 * 페이즈 분기·구독·카운트다운은 components/room-view.tsx에 있다.
 *
 * 폰트는 여기서 세운다. 대기실 화면(components/room-lobby.module.css)이
 * --font-space 를 쓰고, /main 로비와 같은 서체여야 이어져 보인다.
 * 폰트 로더는 빌드 때 평가되므로 서버 컴포넌트에 두는 편이 안전하다.
 */
import { Space_Grotesk } from 'next/font/google';

import { RoomView } from '@/components/room-view';

const space = Space_Grotesk({
  variable: '--font-space',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

export default async function RoomPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return (
    <div className={space.variable}>
      <RoomView code={code} />
    </div>
  );
}
