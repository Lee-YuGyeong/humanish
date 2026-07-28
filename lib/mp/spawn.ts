/**
 * 시작 위치 — **순수 함수.** 소유: A
 *
 * 서버(워커의 봇 조종·입장 처리)와 클라이언트(내 카메라)가 **같은 함수**를 써야 한다.
 * 한쪽만 다르면 내가 보는 내 자리와 남이 보는 내 자리가 어긋나고,
 * 봇만 다른 자리에서 시작하면 그것부터 봇의 표식이 된다 (I1).
 */

import { WORLD } from './constants';

/** 좌석을 방 가운데 원 위에 고르게 배치한다. 정원이 달라도 겹치지 않는다. */
export function spawnFor(seat: number, capacity: number): { x: number; z: number } {
  const n = Math.max(capacity, 1);
  const angle = ((seat - 1) / n) * Math.PI * 2;
  const radius = 3.4;
  const cx = (WORLD.minX + WORLD.maxX) / 2;
  const cz = (WORLD.minZ + WORLD.maxZ) / 2 + 1.5;
  return { x: cx + Math.cos(angle) * radius, z: cz + Math.sin(angle) * radius };
}
