/**
 * 게임 기록 진입점. 소유: A (SPEC §15-2-결정)
 *
 * 이 파일은 **서버 컴포넌트**로 남긴다. 폰트(next/font)를 여기서 불러 CSS 변수만
 * 내려주고, 화면과 상태는 ./history-view.tsx("use client")가 맡는다.
 * /main · /account/nickname 과 같은 구조다.
 *
 * ★ 작업 보드(app/workspaces.ts)에 넣지 않는다. 사용자 흐름의 일부다 —
 *   로비 왼쪽 기둥의 「전체 기록」에서 들어온다.
 */
import { Space_Grotesk } from 'next/font/google';

import { RequireLogin } from '@/components/require-login';
import { HistoryView } from './history-view';

/** 로비와 같은 서체. 라틴만 쓰고 한글은 layout.tsx 의 IBM Plex Sans KR 로 떨어진다. */
const space = Space_Grotesk({
  variable: '--font-space',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

export default function HistoryPage() {
  return (
    <div className={space.variable}>
      {/* 내 기록 화면이다 — 로그인해야 내가 누구인지 안다 (SPEC §15-2-결정) */}
      <RequireLogin>
        <HistoryView />
      </RequireLogin>
    </div>
  );
}
