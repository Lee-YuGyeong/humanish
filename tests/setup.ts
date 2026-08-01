/**
 * 테스트 공통 준비. 소유: A
 *
 * @testing-library/jest-dom의 matcher(toBeInTheDocument 등)를 붙인다.
 * node 환경 파일에서도 import되지만 matcher를 등록만 할 뿐이라 문제되지 않는다.
 */
import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

/**
 * next/navigation 의 라우터를 세워둔다.
 *
 * ┌─ 왜 파일마다 두지 않고 여기 한 곳에 두나 ──────────────────────────────────┐
 * │ useRouter() 는 앱 라우터가 실제로 마운트돼 있어야 동작한다. 화면 조각만     │
 * │ 떼어 렌더하는 이 테스트에는 그게 없어서, 라우터를 쓰는 컴포넌트가 하나 늘   │
 * │ 때마다 "invariant expected app router to be mounted" 로 **그 파일의 검사가  │
 * │ 통째로** 죽는다. 실패 문구만 봐서는 원인이 라우터라는 게 안 보인다.         │
 * │ (대기실에 나가기 버튼을 붙이면서 실제로 그렇게 9개가 한꺼번에 깨졌다.)      │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 이건 **DB 를 목으로 흉내 내는 것과 다르다** (CLAUDE.md). 여기서 가리는 건
 *   브라우저의 주소 이동이지 게임 규칙이 아니다. "정말 이동했나"를 봐야 하는
 *   검사는 그 파일에서 useRouter 를 다시 목으로 바꿔 push 를 직접 확인한다.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
