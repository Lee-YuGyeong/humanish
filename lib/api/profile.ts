/**
 * 프로필 요청. 소유: A (SPEC §15-2-결정)
 *
 * 라우트는 app/api/profile 하나다. 쓰기는 전부 거기를 지난다 (I9).
 */

import type { Profile } from '@/lib/game/types';

export interface ProfileResponse {
  profile: Profile | null;
  /** 아직 이름을 안 지었을 때 구글이 준 제안. 이미 지었으면 null */
  suggested: string | null;
}

/** 라우트는 실패할 때 { error } 를 준다 (lib/server/auth.ts apiError). 그 문구를 그대로 올린다. */
async function unwrap<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(body?.error ?? `요청 실패 (${res.status})`);
  return body as T;
}

export async function fetchProfile(): Promise<ProfileResponse> {
  const res = await fetch('/api/profile', { cache: 'no-store' });
  // 로그인 전이면 401 이다. 에러가 아니라 "아직 없음" 으로 접는다 —
  // 익명으로 노는 사람에게 프로필이 없는 것은 정상이다.
  if (res.status === 401) return { profile: null, suggested: null };
  return unwrap<ProfileResponse>(res);
}

/**
 * 이름을 짓는다. **계정당 한 번뿐이다** — 이미 지었으면 409 다 (SPEC §15-2-결정).
 * 이름이 겹쳐도 409 다. 둘 다 사용자에게 그대로 보여줄 문장이 함께 온다.
 */
export async function saveDisplayName(displayName: string): Promise<Profile> {
  const res = await fetch('/api/profile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ display_name: displayName }),
  });
  const { profile } = await unwrap<{ profile: Profile }>(res);
  return profile;
}
