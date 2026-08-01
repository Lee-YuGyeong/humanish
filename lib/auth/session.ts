/**
 * 브라우저 쪽 계정 처리. 소유: A (SPEC §15-2-결정)
 *
 * ┌─ 게임에 들어가려면 로그인부터 한다 ────────────────────────────────────────┐
 * │ 한때는 익명 인증을 자동으로 걸어두고 게임이 끝난 뒤에 구글을 **잇는**      │
 * │ (linkIdentity) 흐름이었다. 그 결정이 뒤집혀서 지금은 /login 이 입구다.     │
 * │ 그래서 여기 남은 것은 signInWithGoogle 하나다 — 익명 계정도, 잇는 일도     │
 * │ 없다. 근거는 SPEC §15-2-결정에 적어 두었다.                                │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 이 파일은 브라우저에서만 돈다. 서버에서 요청자를 알아내는 것은
 *   lib/server/auth.ts 의 currentUser() 다.
 */

import { getBrowserClient } from '@/lib/server/supabase';

/** 구글에서 돌아올 곳. app/ 아래가 아니라 app/api/ 아래인 이유는 폴더 소유권이다(A). */
const CALLBACK_PATH = '/api/auth/callback';

export interface AuthUser {
  id: string;
  /** 익명 계정이면 true. 구글을 연결하면 false 가 된다 */
  isAnonymous: boolean;
  /** 연결된 계정의 표시 이름. 익명이면 null */
  displayName: string | null;
  avatarUrl: string | null;
}

function toAuthUser(user: {
  id: string;
  is_anonymous?: boolean;
  user_metadata?: Record<string, unknown>;
}): AuthUser {
  const meta = user.user_metadata ?? {};
  const name = meta.full_name ?? meta.name;
  const avatar = meta.avatar_url ?? meta.picture;
  return {
    id: user.id,
    isAnonymous: user.is_anonymous ?? false,
    displayName: typeof name === 'string' ? name : null,
    avatarUrl: typeof avatar === 'string' ? avatar : null,
  };
}

/** 지금 계정. 없으면 null. */
export async function getCurrentUser(): Promise<AuthUser | null> {
  const db = await getBrowserClient();
  const { data } = await db.auth.getUser();
  return data.user ? toAuthUser(data.user) : null;
}

/**
 * 구글로 로그인한다. /login 의 버튼이 부르는 유일한 함수다.
 *
 * ★ 처음 오는 사람은 콜백이 /account/nickname 으로 보낸다 — 이름은 거기서 짓는다
 *   (app/api/auth/callback).
 */
export async function signInWithGoogle(next: string = '/'): Promise<void> {
  const db = await getBrowserClient();

  // 돌아갈 곳은 쿠키에 맡긴다 (아래 rememberNext 주석). redirectTo 에는 쿼리를 안 붙인다.
  rememberNext(next);

  const { error } = await db.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${window.location.origin}${CALLBACK_PATH}` },
  });
  if (error) throw new Error(`구글 로그인 실패: ${error.message}`);
}

/** 로그아웃. RequireLogin 이 다음 화면에서 /login 으로 돌려보낸다. */
export async function signOut(): Promise<void> {
  const db = await getBrowserClient();
  await db.auth.signOut();
}

/**
 * 돌아갈 곳을 쿠키에 적어 둔다.
 *
 * ┌─ 왜 ?next= 로 안 넘기는가 ─────────────────────────────────────────────────┐
 * │ Supabase 는 구글에서 돌아온 뒤 redirect_to 가 **허용 목록과 맞는지** 본다.  │
 * │ 안 맞으면 에러 없이 **Site URL 로 떨어뜨린다.** Site URL 은 배포 주소라,    │
 * │ 로컬에서 로그인했는데 배포 사이트로 튕기는 증상이 된다. 실제로 그랬다.      │
 * │                                                                            │
 * │ 쿼리가 붙으면 목록에 적은 경로와 글자가 달라진다. 그래서 redirect_to 는     │
 * │ **경로만** 보내고(대시보드에 적은 그 문자열 그대로), 돌아갈 곳은 여기 둔다. │
 * │                                                                            │
 * │ 로컬은 로컬로, 배포는 배포로 가는 것도 이걸로 지켜진다 — 쿠키는 오리진마다  │
 * │ 따로이고 redirect_to 는 window.location.origin 에서 만든다.                 │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ★ httpOnly 가 아니다. 브라우저가 써야 하는 값이라 그럴 수 없다. 비밀이 아니고,
 *   서버가 읽을 때 다시 검사한다 (app/api/auth/callback 의 safeNext).
 *
 * ★ 10분이면 충분하다. 구글 화면에서 그보다 오래 머물면 그냥 기본값으로 간다 —
 *   남은 쿠키가 다음 로그인의 목적지를 엉뚱하게 바꾸는 것보다 낫다.
 */
const NEXT_COOKIE = 'hp_next';
const NEXT_MAX_AGE_SEC = 600;

function rememberNext(next: string): void {
  // '//evil.com' 은 브라우저가 다른 호스트로 읽는다. 서버에서 한 번 더 막지만(두 겹)
  // 애초에 심지 않는다.
  const safe = next.startsWith('/') && !next.startsWith('//') ? next : '/';
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie =
    `${NEXT_COOKIE}=${encodeURIComponent(safe)}; path=/; max-age=${NEXT_MAX_AGE_SEC}; SameSite=Lax${secure}`;
}
