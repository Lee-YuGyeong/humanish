'use client';

/**
 * 로그인하지 않았으면 /login 으로 보낸다. 소유: A (SPEC §15-2-결정)
 *
 * ┌─ 무엇을 감싸고 무엇을 안 감싸는가 ─────────────────────────────────────────┐
 * │ 감싼다   /main · /room/[code]  — 게임에 들어가는 길                        │
 * │ 안 감싼다 /intro · /world · /lab · /admin — 남의 작업 공간이다.            │
 * │           게임 계정과 상관없이 돌아가야 한다 (CLAUDE.md 작업 보드).        │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 이 게이트는 **화면용**이다. 진짜 방어가 아니다 — 주소를 직접 치면 잠깐
 *   지나갈 수 있다. 서버 쪽 보증은 그대로다: 쓰기는 전부 쿠키의 player_token 으로
 *   본인을 확인하고(I9, §17.4), 계정이 필요한 라우트는 requireUser 가 401 로 끊는다.
 *   여기서 하는 일은 "로그인 안 한 사람이 빈 로비를 보는 것"을 막는 것뿐이다.
 *
 * ★ 익명 계정(is_anonymous)도 로그인하지 않은 것으로 친다. 지금은 앱이 익명
 *   계정을 자동으로 만들지 않지만(app/providers.tsx), 예전에 만들어진 세션이
 *   브라우저에 남아 있을 수 있다. 그 상태로 들어오면 이름이 없어 대기방이
 *   반쪽이 된다.
 */

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { useAuthUser } from '@/lib/queries/auth';

export function RequireLogin({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: user, isLoading } = useAuthUser();

  const needsLogin = !isLoading && (!user || user.isAnonymous);

  useEffect(() => {
    if (!needsLogin) return;
    // 돌아올 곳을 들고 간다. 방 주소로 직접 들어온 사람이 로그인 뒤에
    // 로비가 아니라 그 방으로 가야 한다 — 친구가 보낸 링크를 눌렀을 때다.
    router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [needsLogin, router, pathname]);

  // 판정이 끝나기 전이나 보내는 중에는 아무것도 그리지 않는다.
  // 로비를 한 번 번쩍 보여줬다가 걷어내면 그게 더 나쁘다.
  if (isLoading || needsLogin) return null;

  return <>{children}</>;
}
