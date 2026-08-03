/**
 * 시작 위치 — **순수 함수.** 소유: A
 *
 * 서버(워커의 봇 조종·입장 처리)와 클라이언트(내 카메라)가 **같은 함수**를 써야 한다.
 * 한쪽만 다르면 내가 보는 내 자리와 남이 보는 내 자리가 어긋나고,
 * 봇만 다른 자리에서 시작하면 그것부터 봇의 표식이 된다 (I1).
 */

import { WORLD } from './constants';

/**
 * 좌석 원의 중심 = **라운드테이블이 서는 자리**.
 *
 * ★ 이 값을 베껴 쓰지 마라. app/world/roundtable.tsx 의 테이블 메시,
 *   lib/mp/collide.ts 의 테이블 콜라이더, 워커의 봇 목적지(BOT_GATHER_RADIUS)가
 *   전부 여기를 본다 — 한 군데만 어긋나면 아바타가 테이블을 등지고 둘러선다.
 */
export const SPAWN_CENTER = {
  x: (WORLD.minX + WORLD.maxX) / 2,
  z: (WORLD.minZ + WORLD.maxZ) / 2 + 1.5,
} as const;

/** 좌석 원의 반지름 (m). */
export const SPAWN_RADIUS = 3.4;

/** 좌석을 방 가운데 원 위에 고르게 배치한다. 정원이 달라도 겹치지 않는다. */
export function spawnFor(seat: number, capacity: number): { x: number; z: number } {
  const n = Math.max(capacity, 1);
  const angle = ((seat - 1) / n) * Math.PI * 2;
  return {
    x: SPAWN_CENTER.x + Math.cos(angle) * SPAWN_RADIUS,
    z: SPAWN_CENTER.z + Math.sin(angle) * SPAWN_RADIUS,
  };
}
