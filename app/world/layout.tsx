import type { Viewport } from 'next';

/**
 * /world 에만 거는 viewport. 소유: 원상
 *
 * ┌─ 왜 루트(app/layout.tsx)가 아닌가 ──────────────────────────────────────┐
 * │ `viewport-fit=cover` 는 노치·홈 인디케이터 영역까지 화면을 쓰겠다는       │
 * │ 뜻이다. 3D 월드는 그게 맞다 — 세계는 가장자리까지 채우고, 그 위의 버튼만  │
 * │ `env(safe-area-inset-*)` 만큼 안으로 들인다 (touch-controls.tsx).        │
 * │                                                                        │
 * │ 그런데 루트에 걸면 **아직 모바일 대응이 안 된 다른 화면**(로비·기록·계정) │
 * │ 의 글자까지 노치 밑으로 들어간다. 거기는 safe-area 를 읽는 코드가 없어서  │
 * │ 잘린 채로 그려진다. 필요한 화면 하나에만 건다.                           │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ★ **확대를 막지 않는다.** `userScalable: false` 면 조이스틱을 두 번 두드릴 때
 *   확대되는 걸 막을 수 있지만, 같은 설정이 글자를 키워 읽는 길도 같이 막는다.
 *   대신 확대가 곤란한 자리에만 CSS 로 끊는다:
 *     · <main>        → touch-manipulation (두 번 두드리기만 막는다)
 *     · 조이스틱·버튼 → touch-none (밀 때 스크롤·확대가 아예 안 걸린다)
 *   핀치 확대는 여기서도 살아 있다.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // 주소창 색. 창고의 어둠과 이어져 화면 위쪽에 밝은 띠가 생기지 않는다
  themeColor: '#07050a',
};

export default function WorldLayout({ children }: { children: React.ReactNode }) {
  return children;
}
