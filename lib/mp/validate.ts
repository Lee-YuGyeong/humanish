/**
 * 수신 메시지 검증 — **순수 함수만.** 소유: A
 * 워커가 쓰지만 `npm test`가 DB 없이 검사할 수 있도록 여기에 둔다.
 *
 * 클라이언트를 신뢰하지 않는 경계다 (SPEC의 서버 권위 표와 같은 취지):
 *   좌표·회전·애니메이션은 클라 권위지만 **범위는 서버가 본다.**
 *   NaN 하나가 통과하면 그 사람을 보는 **모든** 클라이언트의 보간이 영구히 깨진다.
 */

import { POS_MARGIN, WORLD } from './constants';
import { ANIM_STATES, type AnimState, type C2SMessage } from './protocol';

const ANIM_SET = new Set<string>(ANIM_STATES);

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 월드 밖인가. 경계에서 클라 충돌 처리가 조금 튀는 건 허용한다 (POS_MARGIN). */
export function isInsideWorld(x: number, z: number): boolean {
  return (
    x >= WORLD.minX - POS_MARGIN &&
    x <= WORLD.maxX + POS_MARGIN &&
    z >= WORLD.minZ - POS_MARGIN &&
    z <= WORLD.maxZ + POS_MARGIN
  );
}

export interface MoveInput {
  x: number;
  z: number;
  heading: number;
  anim: AnimState;
}

/**
 * move 메시지가 쓸 만한가. 아니면 null — 호출자는 **조용히 버리지 말고** 세어 둔다.
 */
export function parseMove(msg: unknown): MoveInput | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;

  if (!isFiniteNumber(m.x) || !isFiniteNumber(m.z) || !isFiniteNumber(m.heading)) return null;
  if (!isInsideWorld(m.x, m.z)) return null;
  if (typeof m.anim !== 'string' || !ANIM_SET.has(m.anim)) return null;

  return { x: m.x, z: m.z, heading: m.heading, anim: m.anim as AnimState };
}

/** JSON.parse 결과가 우리가 아는 메시지 모양인가. 타입 좁히기용. */
export function isC2SMessage(msg: unknown): msg is C2SMessage {
  return typeof msg === 'object' && msg !== null && typeof (msg as { t?: unknown }).t === 'string';
}

/** 좌석 번호로 아바타 색을 뽑는다. 사람·봇 구분 없이 좌석만 본다 (I1). */
export const SEAT_COLORS = [
  '#e8b45c',
  '#7fb0d8',
  '#d2796a',
  '#8fbf87',
  '#b391d6',
  '#d8a0c0',
  '#6fc2b8',
  '#c9a37a',
] as const;

export function seatColor(seat: number): string {
  return SEAT_COLORS[(seat - 1 + SEAT_COLORS.length) % SEAT_COLORS.length];
}
