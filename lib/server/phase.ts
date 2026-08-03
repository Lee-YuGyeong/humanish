/**
 * 페이즈 전환 로직. 소유: A (SPEC §2, §5)
 *
 * 여기가 꼬이면 전부 멈춘다. 판정은 전부 서버 시각 기준이며,
 * 클라이언트 카운트다운은 표시용일 뿐이다 (SPEC §12.5).
 */

import { after } from 'next/server';
import { getServiceClient } from '@/lib/server/supabase';
import { regenerateBotAnswers } from '@/lib/agent/prefill';
import type { Phase } from '@/lib/game/types';

/** SPEC §5.1 전환표. lobby / reveal은 시간이 아니라 조작으로 넘어간다. */
export const PHASE_DURATION_MS: Record<Phase, number | null> = {
  lobby: null,
  question: 60_000,
  // 한 사람이 한 문장 쓰는 데 60초는 길다. 나머지는 그동안 할 일이 없다.
  // target에는 조기 종료가 없어(아래 EARLY_EXIT) 대상이 누구든 매번 꽉 채운다 —
  // 그래서 이 숫자가 곧 죽은 시간이다. 답을 뜯어보는 시간은 바로 뒤 chat 120초가 맡는다.
  target: 30_000,
  chat: 120_000,
  vote: 30_000,
  // 재투표는 짧다 — 후보가 좁혀졌고 생각도 이미 굳었다 (SPEC §18.3)
  revote: 20_000,
  reveal: null,
  replay: null,
};

/**
 * 조기 종료 조건. "사람 전원"은 is_bot = false만 센다 (SPEC §5.1, I5).
 *
 * ┌─ target에는 조기 종료가 아예 없다 (SPEC §5.3) ─────────────────────────┐
 * │ 한때 'human-target-only'였다 — 대상이 봇이면 조기 종료를 껐다. 봇은      │
 * │ 진입 즉시 답변이 생겨서, 그대로 두면 페이즈가 0초에 끝나고 그것만으로   │
 * │ 대상이 봇임이 드러나기 때문이다.                                        │
 * │                                                                        │
 * │ 그런데 그 처방은 **누수의 방향만 뒤집었다.** 봇이 대상이면 항상 30초를  │
 * │ 꽉 채우고, 사람이 대상이면 답하는 즉시 넘어간다. 즉 "빨리 넘어갔다"가   │
 * │ 곧 "대상은 사람"이라는 확정 신호다. §5.3이 스스로 적어둔 경고 —         │
 * │ "봇일 때만 짧게 하면 그게 다시 신호가 된다" — 의 거울상이다.            │
 * │                                                                        │
 * │ 대칭을 만드는 방법은 하나뿐이다: 양쪽 다 시간을 채운다. 그 대가(죽은    │
 * │ 시간)는 60초를 30초로 줄이면서 이미 치렀다.                             │
 * └────────────────────────────────────────────────────────────────────────┘
 */
export const EARLY_EXIT: Record<Phase, 'all-humans' | 'none'> = {
  lobby: 'none',
  question: 'all-humans',
  target: 'none', // ★ 대상이 사람이든 봇이든 30초를 채운다. 위 상자 참고
  chat: 'none', // 시간 만료만
  vote: 'all-humans',
  // 재투표도 사람 전원이 다시 내면 넘어간다. 진입 훅이 vote 표를 지우므로 이번 표만 센다 (§18.3)
  revote: 'all-humans',
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
      // 기본은 reveal. **사람 표가 동점이면** DB(advance_phase)가 revote 로 갈아탄다
      // (SPEC §18.3). 표 집계는 순수 함수가 못 보므로 여기서는 정할 수 없다 —
      // 이 미러는 '동점이 아닐 때'의 경로다.
      return { phase: 'reveal', round };
    case 'revote':
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

  // 전환 성공 → 새 페이즈의 봇 답변을 응답 반환 뒤 LLM으로 재생성한다
  // (lib/agent/prefill.ts, SPEC §17.5). 실패해도 문구 풀이 그대로 남는다.
  if (data === true) {
    try {
      after(() => regenerateBotAnswers(roomId));
    } catch {
      // 요청 컨텍스트 밖(테스트·스크립트)에서는 after가 없다 — 그냥 발사한다
      void regenerateBotAnswers(roomId);
    }
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
