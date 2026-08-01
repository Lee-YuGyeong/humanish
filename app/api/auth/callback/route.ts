/**
 * 구글에서 돌아오는 자리. 소유: A (SPEC §15-2-결정)
 *
 * GET /api/auth/callback?code=...&next=/room/ABCD
 *
 * ┌─ 왜 app/auth/ 가 아니라 app/api/auth/ 인가 ────────────────────────────────┐
 * │ 폴더 소유권이다. app/(api 제외)는 C 소유고 여기는 A 소유다 (CLAUDE.md).    │
 * │ 기능상 어느 쪽에 둬도 되지만, 경계를 넘지 않는 쪽을 고른다.                │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * 하는 일은 셋이다.
 *   1. 인증 코드를 세션으로 바꾼다 (쿠키가 갱신된다)
 *   2. 이름이 없으면 이름 짓는 화면으로, 있으면 원래 화면으로
 *   3. 이름을 실제로 만드는 것은 여기가 아니라 app/api/profile 이다
 */

import { apiError } from '@/lib/server/auth';
import { getServerAuthClient, getServiceClient } from '@/lib/server/supabase';

export const dynamic = 'force-dynamic';

/**
 * 돌아갈 경로를 고른다.
 *
 * ★ 열린 리다이렉트를 막는 자리다. next 는 브라우저가 준 값이라 무엇이든 올 수 있다.
 *   '//evil.com' 은 브라우저가 **다른 호스트**로 읽는다 — 우리 도메인 링크를 눌렀는데
 *   남의 사이트로 가고, 주소창에는 그럴듯한 로그인 화면이 뜬다.
 *   '/'로 시작하고 '//'로 시작하지 않는 것만 통과시킨다.
 */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const next = safeNext(url.searchParams.get('next'));
  const origin = url.origin;

  try {
    // 사용자가 구글 화면에서 취소하면 code 없이 error 만 붙어 돌아온다.
    // 에러 페이지를 띄우지 않는다 — 취소는 실패가 아니다. 원래 화면으로 돌려보낸다.
    const authError = url.searchParams.get('error');
    if (authError) {
      return Response.redirect(`${origin}${next}?auth=cancelled`, 303);
    }

    const code = url.searchParams.get('code');
    if (!code) {
      return Response.redirect(`${origin}${next}?auth=failed`, 303);
    }

    /*
     * ★ 이 클라이언트가 쿠키를 갱신한다. PKCE 검증값도 쿠키에 있어서
     *   여기(서버)에서 교환이 된다 — 세션을 localStorage 에 뒀다면 못 하는 일이다.
     *   lib/server/supabase.ts 의 getBrowserClient 주석 참고.
     */
    const db = await getServerAuthClient();
    const { data, error } = await db.auth.exchangeCodeForSession(code);

    if (error || !data.user) {
      console.error('[auth] 코드 교환 실패:', error?.message);
      return Response.redirect(`${origin}${next}?auth=failed`, 303);
    }

    /*
     * ★ 이름을 **여기서 짓지 않는다** (SPEC §15-2-결정).
     *
     *   구글이 준 이름을 그대로 박아 넣으면 본명이 대기방에 뜬다. 익명으로 노는
     *   게임에서 그건 사용자가 고른 적 없는 노출이다. 그래서 프로필이 없으면
     *   **이름 짓는 화면으로 보낸다.** 거기서 구글 이름을 제안으로만 보여준다
     *   (app/api/profile 의 suggested).
     *
     *   이미 이름이 있으면 아무것도 묻지 않고 원래 보던 화면으로 돌려보낸다.
     */
    const { data: profile, error: profileError } = await getServiceClient()
      .from('profiles')
      .select('user_id')
      .eq('user_id', data.user.id)
      .maybeSingle();

    if (profileError) {
      // 조회가 실패해도 로그인은 성공이다. 세션은 이미 쿠키에 들어갔다.
      // 이름 짓는 화면이 다시 물어보므로 그쪽으로 보낸다.
      console.error('[auth] 프로필 조회 실패:', profileError.message);
    }

    if (!profile) {
      const q = new URLSearchParams({ next });
      return Response.redirect(`${origin}/account/nickname?${q}`, 303);
    }

    return Response.redirect(`${origin}${next}?auth=linked`, 303);
  } catch (e) {
    return apiError(e);
  }
}
