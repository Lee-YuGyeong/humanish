'use client';

/**
 * 계정을 읽는 쿼리 훅. 소유: A (SPEC §15-2-결정)
 *
 * ★ **방 스코프 밖이다** (keys.ts 의 authUserKey 주석 참고). 계정은 방보다 오래 살고
 *   여러 방에 걸쳐 같다. 방 무효화가 계정을 지우지 않아야 한다.
 *
 * ★ 여기서 나온 값을 **방 화면의 자리와 나란히 놓지 않는다** (I1).
 *   표시 이름은 랭킹·친구 화면의 것이고, 방 안에서는 끝까지 '익명N' 이다.
 *   둘이 한 화면에서 만나는 순간 익명성이 끝난다.
 */

import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type UseInfiniteQueryResult,
  type InfiniteData,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useCallback } from 'react';

import { getCurrentUser, type AuthUser } from '@/lib/auth';
import {
  fetchMatchHistory,
  fetchProfile,
  fetchProfileStats,
  type ProfileResponse,
} from '@/lib/api/profile';
import type { MatchHistoryPage, ProfileStats } from '@/lib/game/types';
import { authUserKey, matchHistoryKey, profileKey, profileStatsKey } from './keys';

/**
 * 지금 계정. 로그인 전이면 null.
 *
 * ★ 폴링하지 않는다. 계정은 사용자가 버튼을 눌러야만 바뀌고, 구글에서 돌아올 때는
 *   페이지가 통째로 다시 뜬다. 주기 폴링은 매번 Auth 서버 왕복이라 값이 비싸다.
 */
export function useAuthUser(): UseQueryResult<AuthUser | null> {
  return useQuery({
    queryKey: authUserKey,
    queryFn: getCurrentUser,
    staleTime: 60_000,
    // 실패해도 조용히 "계정 없음"으로 둔다. 게임은 계정 없이도 돌아가야 한다.
    retry: 0,
  });
}

/**
 * 내가 지은 이름 (SPEC §15-2-결정). 아직 안 지었으면 profile 이 null 이고
 * suggested 에 구글이 준 제안이 들어 있다.
 *
 * ★ 이 값을 **게임 화면에 쓰지 않는다** (I1). 대기방 좌석의 이름은 이 훅이 아니라
 *   public_players 의 lobby_name 에서 온다 — 그쪽은 게임이 시작되면 뷰가 null 로
 *   가려주지만, 이 훅은 내 계정을 그대로 돌려주므로 가려지지 않는다.
 */
export function useProfile(): UseQueryResult<ProfileResponse> {
  return useQuery({
    queryKey: profileKey,
    queryFn: fetchProfile,
    staleTime: 60_000,
    retry: 0,
  });
}

/**
 * 내 전적 (SPEC §15-2-결정). 레벨 · EXP · 승률 · 판수 · 최근 게임.
 *
 * ★ 폴링하지 않는다. 전적은 **한 판이 끝날 때만** 바뀌는데, 그건 게임 화면에서
 *   일어나고 그 뒤 로비로 돌아올 때 화면이 새로 뜬다. 로비에 앉아 있는 동안
 *   내 전적이 바뀔 일은 없다.
 *
 * ★ 로그인 전에도 부른다 — 401 을 "아직 없음(0판)" 으로 접는다 (lib/api/profile.ts).
 *   그래야 훅을 조건부로 부르지 않아도 된다.
 */
export function useProfileStats(): UseQueryResult<ProfileStats> {
  return useQuery({
    queryKey: profileStatsKey,
    queryFn: fetchProfileStats,
    staleTime: 60_000,
    retry: 0,
  });
}

/**
 * 내 전체 게임 기록, 쪽 단위 (로비의 「기록」 탭 — app/main/history-panel.tsx).
 *
 * ★ useProfileStats 와 같은 이유로 폴링하지 않는다 — 기록은 판이 끝날 때만 늘고,
 *   그때 사용자는 이 화면에 없다. 화면을 열 때마다 첫 쪽부터 새로 읽는다.
 */
export function useMatchHistory(): UseInfiniteQueryResult<InfiniteData<MatchHistoryPage>> {
  return useInfiniteQuery({
    queryKey: matchHistoryKey,
    queryFn: ({ pageParam }) => fetchMatchHistory(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    staleTime: 60_000,
    retry: 0,
  });
}

/** 계정이 바뀐 뒤 다시 읽게 한다 (연결 · 로그아웃 · 이름 변경 직후). */
export function useInvalidateAuthUser(): () => void {
  const qc = useQueryClient();
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: authUserKey });
    void qc.invalidateQueries({ queryKey: profileKey });
    // 로그아웃하면 남의 전적이 남아 있으면 안 된다. 계정이 바뀌는 자리에 같이 건다.
    void qc.invalidateQueries({ queryKey: profileStatsKey });
    void qc.invalidateQueries({ queryKey: matchHistoryKey });
  }, [qc]);
}
