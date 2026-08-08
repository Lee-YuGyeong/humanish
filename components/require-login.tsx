'use client';

/**
 * 로그인하지 않았으면 /login 으로 보낸다. 소유: A (SPEC §15-2-결정)
 *
 * ┌─ 무엇을 감싸고 무엇을 안 감싸는가 ─────────────────────────────────────────┐
 * │ 감싼다   /main · /room/[code] · /world — 게임 그 자체다.                   │
 * │          (2026-08-08에 /world 를 넣었다 — app/world/layout.tsx 에 이유)    │
 * │ 안 감싼다 /intro — 첫 화면이라 로그인 전에 읽혀야 한다.                    │
 * │          /lab · /admin — 개발용 점검 화면이라 게임 계정과 무관하게 돈다.   │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 보낼 때 **주소를 통째로 들고 간다** (쿼리 포함). 로그인이 끝나면 그 주소로
 *   되돌려 보낸다: /login → 구글 → /api/auth/callback → 여기 적힌 next.
 *   중간에 이름이 없으면 /account/nickname 을 한 번 거치는데, 그 화면도 next 를
 *   그대로 이어받는다.
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
    /*
     * 돌아올 곳을 들고 간다. 방 주소로 직접 들어온 사람이 로그인 뒤에
     * 로비가 아니라 그 방으로 가야 한다 — 친구가 보낸 링크를 눌렀을 때다.
     *
     * ★ **쿼리까지 들고 간다** (2026-08-08). usePathname() 만 쓰면 `?` 뒤가
     *   통째로 날아가서, 실제로 사람들이 복사해 보내는 `/world?code=ABCD` 가
     *   로그인 뒤에 코드 없는 `/world` 로 돌아왔다 — 그러면 그 화면이 로비로
     *   다시 튕겨서, 링크를 받은 사람은 자기가 초대받은 방에 못 들어간다.
     *   useSearchParams() 대신 location.search 를 읽는 이유는 그 훅이 이 게이트를
     *   쓰는 **모든 페이지**에 Suspense 경계를 요구하기 때문이다. 이 효과는
     *   브라우저에서만 돌아서 window 를 그냥 봐도 된다.
     */
    const here = window.location.pathname + window.location.search;
    router.replace(`/login?next=${encodeURIComponent(here)}`);
  }, [needsLogin, router, pathname]);

  /*
   * 판정이 끝나기 전이나 보내는 중에는 로비 대신 **어두운 덮개**를 그린다.
   *
   * ★ null 이면 안 된다 — 그 한 박자 동안 화면에 남는 것이 layout.tsx 의 창고
   *   배경(황토색 텅스텐, globals.css 의 .room)이라, 새로고침·이동 때마다
   *   창고가 번쩍 비쳐 보였다 (사용자 보고 2026-08-07). 이 게이트가 감싸는
   *   화면(/main · /room)은 전부 어두운 취조실 팔레트라, 같은 계열의 빈 판으로
   *   덮으면 그 틈이 사라진다. 색은 room-lobby.module.css 의 --bg2 와 같다
   *   (모듈을 import 하면 번들이 늘어서 값만 맞춘다 — app/room 의 loading.tsx 와
   *   같은 방식이다).
   * ★ 로비를 한 번 번쩍 보여줬다가 걷어내는 것은 여전히 안 한다 — 덮개가
   *   로그인 판정 동안 그 자리를 지킨다.
   */
  if (isLoading || needsLogin) {
    return <div aria-hidden style={{ position: "fixed", inset: 0, zIndex: 1, background: "#08080a" }} />;
  }

  return <>{children}</>;
}
