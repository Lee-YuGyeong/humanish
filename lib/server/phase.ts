/**
 * 페이즈 전환 로직. 소유: A (SPEC §2, §5)
 *
 * 여기가 꼬이면 전부 멈춘다. 판정은 전부 서버 시각 기준이며,
 * 클라이언트 카운트다운은 표시용일 뿐이다 (SPEC §12.5).
 */

import { getServiceClient } from '@/lib/server/supabase';
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

/**
 * 조기 종료 조건. "사람 전원"은 is_bot = false만 센다 (SPEC §5.1, I5).
 *
 * `human-target-only`는 **대상이 사람일 때만** 조기 종료한다는 뜻이다.
 * 봇이 대상이면 진입 즉시 답변이 생기므로(SPEC §5.3), 조기 종료를 그대로 두면
 * 60초짜리 페이즈가 0초에 끝나 그것만으로 대상이 봇임이 드러난다 (SPEC §5.3, §17).
 * I5와 같은 함정인데 I5 문장("인원을 센다")으로는 안 걸린다.
 */
export const EARLY_EXIT: Record<Phase, 'all-humans' | 'human-target-only' | 'none'> = {
  lobby: 'none',
  question: 'all-humans',
  target: 'human-target-only',
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
 * 페이즈를 한 칸 넘긴다. 실제 전환은 Postgres 함수 안에서 일어난다
 * (`supabase/functions/advance_phase.sql`, SPEC §5.2).
 *
 *   1. select ... for update 로 방 행 잠금
 *   2. expected_seq !== rooms.phase_seq → 아무것도 안 하고 종료
 *   3. now() < phase_ends_at 이고 조기 종료 조건 미충족 → 종료
 *   4. 다음 페이즈 계산, phase_seq += 1, phase_ends_at 갱신
 *   5. 진입 훅 실행 (SPEC §5.3)
 *
 * 낙관적 잠금 키가 phase_seq다. 5명이 동시에 불러도 첫 호출만 성공한다 (I6).
 *
 * `actorId`는 시간이 없는 페이즈(lobby → question, reveal → replay)에만 필요하다.
 * **호출자가 보낸 값을 그대로 넘기지 않는다** — 쿠키의 player_token으로 되찾은
 * player_id여야 한다 (SPEC §17.4). 그래서 이 RPC는 anon에게 열려 있지 않다.
 *
 * @returns 실제로 전환했으면 true. 이미 남이 넘겼거나 조건 미충족이면 false.
 */
export async function advancePhase(
  roomId: string,
  expectedSeq: number,
  actorId?: string,
): Promise<boolean> {
  const { data, error } = await getServiceClient().rpc('advance_phase', {
    p_room_id: roomId,
    p_expected_seq: expectedSeq,
    p_actor_id: actorId ?? null,
  });

  if (error) {
    throw new Error(`advance_phase 실패 (room=${roomId}, seq=${expectedSeq}): ${error.message}`);
  }
  return data === true;
}

/** 한 번의 sweep에서 처리할 방 수 상한 (SPEC §16.2). 남은 방은 다음 주기에 맡긴다. */
export const SWEEP_BATCH_SIZE = 50;

/**
 * SPEC §12.1 3번 안전망. **평소에는 pg_cron이 15초마다 DB 안에서 직접 부른다**
 * (`supabase/functions/advance_phase.sql`의 `cron.schedule('phase-watchdog', ...)`).
 * 클라이언트가 전부 죽어도 방이 멈추지 않게 하는 유일한 장치다. 선택이 아니다.
 *
 * 여기서 내보내는 건 손으로 한 번 돌려보거나 테스트할 때 쓰는 통로다.
 * 워치독이 실제로 도는지는 `select * from cron.job_run_details`로 확인한다.
 *
 * 다중 방에서 안전망이 단일 장애점이 되지 않게 SQL 쪽에 세 가지가 들어 있다 (SPEC §16.2).
 *   1. for update SKIP LOCKED       — 전환 중인 방을 기다리지 않고 건너뛴다
 *   2. 방마다 begin ... exception   — 한 방의 예외로 나머지가 롤백되지 않게
 *   3. pg_try_advisory_xact_lock    — 실행이 15초를 넘겨도 다음 cron과 겹치지 않게
 *
 * @returns 실제로 전환된 방 수
 */
export async function advanceExpiredRooms(limit: number = SWEEP_BATCH_SIZE): Promise<number> {
  const { data, error } = await getServiceClient().rpc('advance_expired_rooms', {
    p_limit: limit,
  });

  if (error) {
    throw new Error(`advance_expired_rooms 실패: ${error.message}`);
  }
  return typeof data === 'number' ? data : 0;
}
