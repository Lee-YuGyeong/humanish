'use client';

/**
 * 방 화면이 읽는 서버 값 — 쿼리 훅. 소유: A
 *
 * ┌─ 이 계층이 없앤 것 ────────────────────────────────────────────────────────┐
 * │ 예전에는 refresh() 하나가 쿼리 5개 + fetch 1개를 **매번 전부** 다시 읽고    │
 * │ setState 6번을 했다. 답변만 바뀌어도 좌석·질문·투표가 같이 새로 그려졌고,   │
 * │ 요청이 겹치면 늦게 온 응답이 먼저 온 응답을 덮어썼다(경합).                │
 * │ 이제 쿼리마다 캐시가 따로 있고, 겹친 요청은 react-query 가 합친다.         │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 무효화는 반드시 useInvalidateRoom() 으로 한다. 키를 직접 적으면
 *   읽는 쪽과 지우는 쪽이 조용히 갈린다 (keys.ts 머리말).
 */

import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback } from 'react';

import { fetchMe, fetchReveal, fetchServerTime, type MeResponse, type RevealResponse } from '@/lib/api/room';
import {
  fetchAnswers,
  fetchMessages,
  fetchQuestions,
  fetchRoomByCode,
  fetchRoster,
  fetchVotes,
  type AnswerRow,
  type MessageRow,
  type VoteRow,
} from '@/lib/api/db';
import type { PublicPlayer, Question, Room } from '@/lib/game/types';
import { roomKeys, serverTimeKey } from './keys';

/**
 * 방 상태는 realtime 이 알려준다 (useRoomRealtime). 그래서 주기 폴링을 걸지 않는다.
 * staleTime 0 은 "무효화되면 즉시 다시 읽는다"는 뜻이고, 그게 이 화면이 원하는 것이다.
 */
const LIVE = { staleTime: 0, refetchOnWindowFocus: true } as const;

/** 채팅 폴링 주기. Broadcast 를 안 쓰는 이유는 lib/api/db.ts fetchMessages 참고. */
const CHAT_POLL_MS = 1_500;

/* ─────────────────────────────── 읽기 ─────────────────────────────── */

/** 코드 → 방 행. 없으면 data 가 null 이다 (오타는 에러가 아니라 화면 문구다). */
export function useRoomByCode(code: string): UseQueryResult<Room | null> {
  return useQuery({
    queryKey: roomKeys.byCode(code),
    queryFn: () => fetchRoomByCode(code),
    ...LIVE,
  });
}

export function useRoster(roomId: string | undefined): UseQueryResult<PublicPlayer[]> {
  return useQuery({
    queryKey: roomKeys.roster(roomId ?? ''),
    queryFn: () => fetchRoster(roomId!),
    enabled: Boolean(roomId),
    ...LIVE,
  });
}

export function useMe(roomId: string | undefined): UseQueryResult<MeResponse> {
  return useQuery({
    queryKey: roomKeys.me(roomId ?? ''),
    queryFn: ({ signal }) => fetchMe(roomId!, signal),
    enabled: Boolean(roomId),
    ...LIVE,
  });
}

export function useQuestions(roomId: string | undefined): UseQueryResult<Question[]> {
  return useQuery({
    queryKey: roomKeys.questions(roomId ?? ''),
    queryFn: () => fetchQuestions(roomId!),
    enabled: Boolean(roomId),
    ...LIVE,
  });
}

export function useAnswers(roomId: string | undefined): UseQueryResult<AnswerRow[]> {
  return useQuery({
    queryKey: roomKeys.answers(roomId ?? ''),
    queryFn: () => fetchAnswers(roomId!),
    enabled: Boolean(roomId),
    ...LIVE,
  });
}

export function useVotes(roomId: string | undefined): UseQueryResult<VoteRow[]> {
  return useQuery({
    queryKey: roomKeys.votes(roomId ?? ''),
    queryFn: () => fetchVotes(roomId!),
    enabled: Boolean(roomId),
    ...LIVE,
  });
}

/**
 * 자유 채팅. **chat 페이즈에서만 켠다** — 끄면 폴링도 같이 멈춘다.
 * 예전에는 ChatPanel 이 언마운트될 때 clearInterval 로 껐는데, 그건 컴포넌트
 * 수명과 폴링 수명을 묶는 것이라 조건이 늘어날수록 새기 쉽다.
 */
export function useMessages(
  roomId: string | undefined,
  enabled: boolean,
): UseQueryResult<MessageRow[]> {
  return useQuery({
    queryKey: roomKeys.messages(roomId ?? ''),
    queryFn: () => fetchMessages(roomId!),
    enabled: Boolean(roomId) && enabled,
    refetchInterval: CHAT_POLL_MS,
    staleTime: 0,
  });
}

/**
 * 정답 공개. reveal·replay 페이즈에서만 켠다.
 *
 * ★ 정체가 클라이언트로 오는 유일한 경로다 (I1). 라우트가 페이즈와 참가 여부를
 *   확인한 뒤에만 주므로, 여기서 미리 당겨 받아 두지 않는다 —
 *   enabled 를 항상 true 로 바꾸면 lobby 에서도 요청이 나간다.
 */
export function useReveal(
  roomId: string | undefined,
  enabled: boolean,
): UseQueryResult<RevealResponse> {
  return useQuery({
    queryKey: roomKeys.reveal(roomId ?? ''),
    queryFn: ({ signal }) => fetchReveal(roomId!, signal),
    enabled: Boolean(roomId) && enabled,
    staleTime: 0,
  });
}

/* ─────────────────────────────── 서버 시각 ─────────────────────────────── */

/**
 * 서버 시각 오프셋 (SPEC §12.5). 접속할 때 한 번만 잰다.
 *
 * ★ 실패하면 0(= 로컬 시계)이다. NaN 이 되면 안 된다 —
 *   offset 이 NaN 이면 serverNow() 도 NaN 이고 `left <= 0` 이 영영 false 라서
 *   **그 탭은 페이즈 만료를 한 번도 감지하지 못한다.** 화면에는 'NaN초'만 뜨고
 *   타이머가 죽은 건 보이지 않는다. 몇 초 어긋나는 편이 훨씬 낫다 —
 *   어차피 판정은 서버가 한다 (I2).
 */
export function useServerClock(): { serverNow: () => number; offsetMs: number } {
  const { data } = useQuery({
    queryKey: serverTimeKey,
    queryFn: async ({ signal }) => {
      const before = Date.now();
      const { now } = await fetchServerTime(signal);
      const t = new Date(now).getTime();
      if (!Number.isFinite(t)) return 0;
      // 왕복 시간의 절반을 빼서 대략 보정한다
      return t - (before + Date.now()) / 2;
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });

  const offsetMs = Number.isFinite(data) ? (data as number) : 0;
  const serverNow = useCallback(() => Date.now() + offsetMs, [offsetMs]);
  return { serverNow, offsetMs };
}

/* ─────────────────────────────── 무효화 ─────────────────────────────── */

/**
 * 그 방에 속한 모든 쿼리를 다시 읽게 한다 — 예전의 refresh() 자리다.
 *
 * ★ 두 번 부르는 이유: 방 행은 code 로 키를 잡고(아직 id 를 모를 때 쓰므로),
 *   나머지는 scope(roomId) 접두사를 쓴다. 한쪽만 지우면 phase 가 그대로 남거나
 *   좌석만 갱신되는, 원인 찾기 어려운 상태가 된다 (keys.ts 머리말).
 */
export function useInvalidateRoom(code: string, roomId: string | undefined): () => Promise<void> {
  const qc = useQueryClient();
  return useCallback(async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: roomKeys.byCode(code) }),
      roomId ? qc.invalidateQueries({ queryKey: roomKeys.scope(roomId) }) : Promise.resolve(),
    ]);
  }, [qc, code, roomId]);
}
