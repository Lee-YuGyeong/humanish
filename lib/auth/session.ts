/**
 * 브라우저 쪽 계정 처리. 소유: A (SPEC §15-2-결정)
 *
 * ┌─ 두 단계다. 순서가 뒤집히면 되돌릴 수 없다 ────────────────────────────────┐
 * │ 1. 익명 인증  — 로그인 화면이 없다. 들어오면 조용히 계정이 하나 생긴다.    │
 * │ 2. 구글 연결  — 그 익명 계정에 구글을 **잇는다**(link). 새로 만들지 않는다.│
 * │                                                                            │
 * │ 이어붙이므로 user_id 가 안 바뀌고, 그때까지 쌓인 것이 그대로 따라온다.     │
 * │ 구글부터 시키면 첫 화면에 로그인 벽이 서고, 그건 되돌리기 어렵다.          │
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

/**
 * 세션이 없으면 익명으로 하나 만든다. 있으면 그대로 쓴다.
 *
 * 앱이 뜰 때 한 번 부른다. **사용자는 아무것도 누르지 않는다.**
 *
 * ★ 실패해도 던지지 않는다. 계정을 못 만들어도 게임은 돌아가야 한다 —
 *   players.user_id 가 null 이 될 뿐이고, 전적이 안 쌓이는 것으로 끝난다.
 *   여기서 던지면 익명 로그인 설정 하나 때문에 게임 전체가 멈춘다.
 *
 * ★ Supabase 대시보드에서 **익명 로그인(Anonymous sign-ins)** 을 켜야 동작한다.
 *   꺼져 있으면 422가 오고, 이 함수는 조용히 null 을 돌려준다.
 */
export async function ensureSession(): Promise<AuthUser | null> {
  const db = await getBrowserClient();

  const { data: existing } = await db.auth.getUser();
  if (existing.user) return toAuthUser(existing.user);

  const { data, error } = await db.auth.signInAnonymously();
  if (error || !data.user) {
    console.warn('[auth] 익명 로그인 실패 — 계정 없이 진행한다:', error?.message);
    return null;
  }
  return toAuthUser(data.user);
}

/** 지금 계정. 없으면 null. */
export async function getCurrentUser(): Promise<AuthUser | null> {
  const db = await getBrowserClient();
  const { data } = await db.auth.getUser();
  return data.user ? toAuthUser(data.user) : null;
}

/** 구글 연결 결과. 화면이 이걸 보고 문구를 고른다. */
export type LinkResult =
  | { ok: true }
  /**
   * 그 구글 계정이 **이미 다른 계정에 연결돼 있다.**
   * 화면은 여기서 "그 계정으로 들어가시겠습니까? 지금 판의 기록은 저장되지 않습니다"를
   * 묻고, 예를 고르면 signInWithGoogle()을 부른다. 조용히 넘어가면 사용자는
   * 전적이 사라졌다고 느낀다.
   */
  | { ok: false; reason: 'already-linked' }
  | { ok: false; reason: 'failed'; message: string };

/**
 * 지금 익명 계정에 구글을 **잇는다**. 게임이 끝난 화면의 "기록 저장하기"가 부른다.
 *
 * ★ signInWithOAuth 가 아니다. 그건 **새 세션으로 갈아타서** 익명 계정에 쌓인 것이
 *   끊긴다. linkIdentity 는 같은 user_id 에 구글을 덧붙인다.
 *
 * ★ Supabase 대시보드에서 **수동 연결(Manual linking)** 을 켜야 동작한다.
 *   꺼져 있으면 여기서 실패한다.
 *
 * @param next 연결이 끝난 뒤 돌아갈 앱 안의 경로. 반드시 '/'로 시작해야 한다.
 */
export async function linkGoogle(next: string = '/'): Promise<LinkResult> {
  const db = await getBrowserClient();
  const { error } = await db.auth.linkIdentity({
    provider: 'google',
    options: { redirectTo: callbackUrl(next) },
  });

  if (!error) return { ok: true };
  // 이미 쓰인 구글 계정이면 422다. 문구로 판정하지 않는다 — 문구는 바뀐다.
  if (error.status === 422) return { ok: false, reason: 'already-linked' };
  return { ok: false, reason: 'failed', message: error.message };
}

/**
 * 구글 계정으로 **갈아탄다**. linkGoogle 이 already-linked 를 돌려줬을 때만 쓴다.
 *
 * ★ 지금 익명 계정에 쌓인 것은 따라오지 않는다. 부르기 전에 반드시 사용자에게
 *   물을 것 — 이 함수는 확인 없이 실행한다.
 */
export async function signInWithGoogle(next: string = '/'): Promise<void> {
  const db = await getBrowserClient();
  const { error } = await db.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: callbackUrl(next) },
  });
  if (error) throw new Error(`구글 로그인 실패: ${error.message}`);
}

/** 로그아웃. 다음 ensureSession()이 **새 익명 계정**을 만든다 — 옛 전적과는 끊긴다. */
export async function signOut(): Promise<void> {
  const db = await getBrowserClient();
  await db.auth.signOut();
}

/**
 * 돌아올 주소를 만든다.
 *
 * ★ next 를 그대로 붙이지 않는다. '//evil.com' 같은 값이 오면 그게 열린 리다이렉트가
 *   된다 — 우리 도메인 링크를 눌렀는데 남의 사이트로 간다. 콜백 라우트에도 같은
 *   검사가 있다(두 겹). 여기서 막는 게 아니라 **거기서** 막는 게 본체다 —
 *   이 값은 브라우저에서 오므로 언제든 고쳐질 수 있다.
 */
function callbackUrl(next: string): string {
  const safe = next.startsWith('/') && !next.startsWith('//') ? next : '/';
  return `${window.location.origin}${CALLBACK_PATH}?next=${encodeURIComponent(safe)}`;
}
