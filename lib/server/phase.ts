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

/** 한 번의 sweep에서 처리할 방 수 상한 (SPEC §16.2). 남은 방은 다음 주기에 맡긴다. */
export const SWEEP_BATCH_SIZE = 50;

/**
 * TODO(A): SPEC §12.1 3번 안전망. pg_cron이 15초마다 부른다.
 * 클라이언트가 전부 죽어도 방이 멈추지 않게 하는 유일한 장치다. 선택이 아니다.
 *
 * 여러 방이 동시에 돌 때 이 함수가 단일 장애점이 되지 않게 세 가지를 반드시 넣는다 (SPEC §16.2).
 *   1. select ... for update SKIP LOCKED  — 전환 중인 방을 기다리지 않고 건너뛴다
 *   2. 방마다 begin ... exception 격리    — 한 방의 예외로 나머지가 롤백되지 않게
 *   3. pg_try_advisory_lock              — 실행이 15초를 넘겨도 다음 cron과 겹치지 않게
 */
export async function advanceExpiredRooms(): Promise<void> {
  throw new Error('advanceExpiredRooms: 미구현 — pg_cron watchdog 연결 전');
}
