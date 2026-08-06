/**
 * 프로필 요청. 소유: A (SPEC §15-2-결정)
 *
 * 라우트는 app/api/profile 하나다. 쓰기는 전부 거기를 지난다 (I9).
 */

import type { MatchHistoryPage, Profile, ProfileStats } from '@/lib/game/types';

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

/** 한 판도 없는 계정(그리고 로그인 전)의 전적. 화면이 null 검사를 안 하게 모양을 맞춰준다. */
const EMPTY_STATS: ProfileStats = {
  games: 0,
  wins: 0,
  win_rate: null,
  exp: 0,
  level: 1,
  level_into: 0,
  level_need: 10,
  level_ratio: 0,
  recent: [],
};

/**
 * 내 전적 — 레벨 · EXP · 승률 · 판수 · 최근 게임 (SPEC §15-2-결정).
 *
 * ★ 남의 전적을 받는 방법은 없다. 라우트가 쿠키 세션의 계정 하나만 본다 (I1, I9).
 */
export async function fetchProfileStats(): Promise<ProfileStats> {
  const res = await fetch('/api/profile/stats', { cache: 'no-store' });
  // 로그인 전이면 401 이다. fetchProfile 과 같이 "아직 없음" 으로 접는다 —
  // 전적이 없다는 이유로 로비가 에러 화면이 되면 안 된다.
  if (res.status === 401) return EMPTY_STATS;
  return unwrap<ProfileStats>(res);
}

/**
 * 내 전체 기록, 한 쪽 (기록 화면 /account/history).
 *
 * ★ 남의 기록을 받는 방법은 없다 — 라우트가 쿠키 세션의 계정 하나만 본다 (I1, I9).
 * ★ 401 을 빈 쪽으로 접지 않는다 — 기록 화면은 RequireLogin 뒤에 있어서
 *   로그인 전에 불릴 일이 없고, 접으면 진짜 오류가 "기록 없음"으로 위장한다.
 */
export async function fetchMatchHistory(before: string | null): Promise<MatchHistoryPage> {
  const query = before ? `?before=${encodeURIComponent(before)}` : '';
  const res = await fetch(`/api/profile/matches${query}`, { cache: 'no-store' });
  return unwrap<MatchHistoryPage>(res);
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
