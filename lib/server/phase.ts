/**
 * 페이즈 전환 로직. 소유: A (SPEC §2, §5)
 *
 * 여기가 꼬이면 전부 멈춘다. 판정은 전부 서버 시각 기준이며,
 * 클라이언트 카운트다운은 표시용일 뿐이다 (SPEC §12.5).
 */

import type { Phase } from '@/lib/game/types';

/** SPEC §5.1 전환표. lobby / reveal은 시간이 아니라 조작으로 넘어간다. */
export const PHASE_DURATION_MS: Record<Phase, number | null> = {
  lobby: null,
  question: 60_000,
  target: 60_000,
  chat: 120_000,
  vote: 30_000,
  reveal: null,
  replay: null,
};

/** 조기 종료 조건. "사람 전원"은 is_bot = false만 센다 (SPEC §5.1). */
export const EARLY_EXIT: Record<Phase, 'all-humans' | 'target-only' | 'none'> = {
  lobby: 'none',
  question: 'all-humans',
  target: 'target-only',
  chat: 'none', // 시간 만료만
  vote: 'all-humans',
  reveal: 'none',
  replay: 'none',
};

/**
 * 다음 페이즈. question은 round 1 → 2 → target 순서라 round를 함께 본다.
 * 순수 함수 — DB를 모른다.
 */
export function nextPhase(phase: Phase, round: number): { phase: Phase; round: number } {
  switch (phase) {
    case 'lobby':
      return { phase: 'question', round: 1 };
    case 'question':
      return round < 2 ? { phase: 'question', round: 2 } : { phase: 'target', round };
    case 'target':
      return { phase: 'chat', round };
    case 'chat':
      return { phase: 'vote', round };
    case 'vote':
      return { phase: 'reveal', round };
    case 'reveal':
      return { phase: 'replay', round };
    case 'replay':
      return { phase: 'replay', round };
  }
}

/**
 * TODO(A): advance_phase RPC 호출부.
 *
 * 실제 전환은 Postgres 함수 안에서 일어난다 (SPEC §5.2).
 *   1. select ... for update 로 방 행 잠금
 *   2. expected_seq !== rooms.phase_seq → 종료
 *   3. now() < phase_ends_at 이고 조기 종료 조건 미충족 → 종료
 *   4. 다음 페이즈 계산, phase_seq += 1, phase_ends_at 갱신
 *   5. 진입 훅 실행 (SPEC §5.3)
 *
 * 낙관적 잠금 키가 phase_seq다. 5명이 동시에 불러도 첫 호출만 성공한다.
 */
export async function advancePhase(_roomId: string, _expectedSeq: number): Promise<void> {
  throw new Error('advancePhase: 미구현 — supabase/functions/advance_phase 작성 후 연결');
}

/**
 * TODO(A): SPEC §12.1 3번 안전망. pg_cron이 15초마다 부른다.
 * 클라이언트가 전부 죽어도 방이 멈추지 않게 하는 유일한 장치다. 선택이 아니다.
 */
export async function advanceExpiredRooms(): Promise<void> {
  throw new Error('advanceExpiredRooms: 미구현 — pg_cron watchdog 연결 전');
}
