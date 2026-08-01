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
 *   2. 구글이 준 이름·사진으로 profiles 한 행을 만든다
 *   3. 원래 보던 화면으로 돌려보낸다
 */

import { apiError } from '@/lib/server/auth';
import { getServerAuthClient, getServiceClient } from '@/lib/server/supabase';

export const dynamic = 'force-dynamic';

/** profiles.display_name 의 제약과 같은 값이어야 한다 (supabase/schema.sql). */
const MAX_DISPLAY_NAME = 20;

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

/** 구글이 주는 이름은 길이가 제각각이다. 제약(1~20자)에 맞춰 자른다. */
function pickDisplayName(meta: Record<string, unknown>, fallback: string): string {
  const raw = meta.full_name ?? meta.name ?? meta.email;
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return fallback;
  return text.slice(0, MAX_DISPLAY_NAME);
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
     * 프로필을 남긴다. 익명 계정에는 행이 없다가 여기서 처음 생긴다.
     *
     * ★ service role 로 쓴다. profiles 는 authenticated 에게 읽기만 열려 있다 (I9) —
     *   쓰기를 열면 남이 자기 display_name 을 마음대로 바꿔 랭킹을 어지럽힌다.
     *
     * ★ 실패해도 로그인은 성공으로 친다. 세션은 이미 쿠키에 들어갔고, 프로필은
     *   다음 로그인 때 다시 시도된다. 여기서 막으면 로그인은 됐는데 화면은
     *   실패라고 말하는 상태가 된다.
     */
    const meta = (data.user.user_metadata ?? {}) as Record<string, unknown>;
    const avatar = meta.avatar_url ?? meta.picture;

    const { error: profileError } = await getServiceClient().from('profiles').upsert(
      {
        user_id: data.user.id,
        display_name: pickDisplayName(meta, '이름없음'),
        avatar_url: typeof avatar === 'string' ? avatar : null,
      },
      { onConflict: 'user_id' },
    );

    if (profileError) {
      console.error('[auth] 프로필 저장 실패:', profileError.message);
    }

    return Response.redirect(`${origin}${next}?auth=linked`, 303);
  } catch (e) {
    return apiError(e);
  }
}
