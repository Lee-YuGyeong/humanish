// @vitest-environment jsdom
/**
 * 로그인 게이트 — 원래 가려던 주소를 **쿼리까지** 들고 가는가.
 *
 * ┌─ 왜 이 검사가 있나 (2026-08-08) ───────────────────────────────────────────┐
 * │ 게이트가 usePathname() 만 읽던 시절, `/world?code=ABCD` 로 초대받은 사람은  │
 * │ 로그인을 마치고 코드 없는 `/world` 로 돌아왔다. 그 화면은 코드가 없으면     │
 * │ 로비로 튕기므로, 링크를 받은 사람은 **자기가 초대받은 방에 못 들어갔다.**   │
 * │ 타입도 통과하고 에러도 안 나는 종류라, 검사로 못 박아 둔다.                 │
 * └────────────────────────────────────────────────────────────────────────────┘
 */

import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 전역 setup(tests/setup.ts)의 라우터를 이 파일에서만 스파이로 바꾼다 */
const nav = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: nav.replace,
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

/** 계정 조회. 네트워크 경계라 여기서 세운다 (DB 를 흉내 내는 게 아니다) */
const auth = vi.hoisted(() => ({ useAuthUser: vi.fn() }));
vi.mock('@/lib/queries/auth', () => auth);

const { RequireLogin } = await import('@/components/require-login');

/** 주소창을 옮긴다. jsdom 은 location 을 직접 못 바꾸므로 history 로 민다 */
const goTo = (url: string) => window.history.replaceState({}, '', url);

const loggedOut = { data: null, isLoading: false };
const loggedIn = {
  data: { id: 'u1', isAnonymous: false, displayName: '누구', avatarUrl: null },
  isLoading: false,
};

beforeEach(() => {
  nav.replace.mockClear();
  auth.useAuthUser.mockReturnValue(loggedOut);
});
afterEach(cleanup);

describe('RequireLogin', () => {
  it('쿼리가 붙은 주소로 들어오면 그 쿼리까지 next 에 담는다', async () => {
    goTo('/world?code=ABCD');
    render(
      <RequireLogin>
        <p>방</p>
      </RequireLogin>,
    );

    await waitFor(() => expect(nav.replace).toHaveBeenCalled());
    const to = nav.replace.mock.calls[0][0] as string;

    // 로그인 화면으로 보내되, 돌아올 주소는 통째로 들고 간다
    expect(to.startsWith('/login?next=')).toBe(true);
    const next = new URLSearchParams(to.slice('/login?'.length)).get('next');
    expect(next).toBe('/world?code=ABCD');
  });

  it('쿼리가 없으면 경로만 담는다', async () => {
    goTo('/main');
    render(
      <RequireLogin>
        <p>로비</p>
      </RequireLogin>,
    );

    await waitFor(() => expect(nav.replace).toHaveBeenCalled());
    expect(nav.replace).toHaveBeenCalledWith(`/login?next=${encodeURIComponent('/main')}`);
  });

  it('로그인해 있으면 아무 데도 안 보내고 안쪽을 그린다', async () => {
    auth.useAuthUser.mockReturnValue(loggedIn);
    goTo('/world?code=ABCD');
    const { getByText } = render(
      <RequireLogin>
        <p>방</p>
      </RequireLogin>,
    );

    expect(getByText('방')).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  /**
   * 익명 계정은 로그인하지 않은 것으로 친다 (require-login.tsx 머리말).
   * 지금은 앱이 익명 계정을 만들지 않지만 예전 세션이 브라우저에 남아 있을 수 있다.
   */
  it('익명 계정도 로그인 화면으로 보낸다', async () => {
    auth.useAuthUser.mockReturnValue({
      data: { id: 'u2', isAnonymous: true, displayName: null, avatarUrl: null },
      isLoading: false,
    });
    goTo('/room/ABCD');
    render(
      <RequireLogin>
        <p>방</p>
      </RequireLogin>,
    );

    await waitFor(() => expect(nav.replace).toHaveBeenCalled());
    expect(nav.replace).toHaveBeenCalledWith(`/login?next=${encodeURIComponent('/room/ABCD')}`);
  });
});
