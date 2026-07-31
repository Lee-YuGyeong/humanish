/**
 * 가구 충돌 — 순수 함수. 소유: A
 *
 * 이게 깨지면 증상이 갈린다: 사람은 소파에 막히는데 봇만 뚫고 지나간다.
 * 클라이언트와 워커가 **같은 파일**을 쓰게 만든 이유가 그거라, 그 파일을 여기서 잡는다.
 */

import { describe, expect, it } from 'vitest';

import {
  COLLIDERS,
  PLAYER_R,
  STEP_UP,
  groundHeightAt,
  isBlocked,
  resolveCollisions,
} from '@/lib/mp/collide';
import { WORLD } from '@/lib/mp/constants';

/** 회전이 없는 소파 하나 — 계산을 손으로 따라갈 수 있다. */
const SOFA = COLLIDERS.find((c) => c.rot === 0 && c.top === 0.99)!;

describe('resolveCollisions', () => {
  it('빈 자리는 건드리지 않는다', () => {
    const out = resolveCollisions(-6, -11, 0);
    expect(out).toEqual({ x: -6, z: -11 });
  });

  it('가구 한가운데에 있으면 밖으로 밀려난다', () => {
    const out = resolveCollisions(SOFA.x, SOFA.z, 0);
    expect(isBlocked(out.x, out.z, 0)).toBe(false);
  });

  it('밀려난 자리는 가구 표면에서 몸통 반지름만큼 떨어져 있다', () => {
    // 깊이 방향으로 살짝 파고든 상태 → 그 축으로 밀려난다
    const inside = { x: SOFA.x, z: SOFA.z + SOFA.hd - 0.05 };
    const out = resolveCollisions(inside.x, inside.z, 0);
    expect(out.x).toBeCloseTo(SOFA.x, 6);
    expect(out.z).toBeCloseTo(SOFA.z + SOFA.hd + PLAYER_R, 6);
  });

  it('윗면보다 높이 있으면 막지 않는다 — 뛰어넘거나 위에 올라선 상태다', () => {
    expect(isBlocked(SOFA.x, SOFA.z, SOFA.top + 0.1)).toBe(false);
    expect(isBlocked(SOFA.x, SOFA.z, 0)).toBe(true);
  });

  it('낮은 턱은 사람에게는 안 막히고, stepUp=0 이면 막힌다 (봇)', () => {
    const table = COLLIDERS.find((c) => c.top <= STEP_UP)!;
    expect(isBlocked(table.x, table.z, 0)).toBe(false); // 사람 — 걸어서 올라간다
    expect(isBlocked(table.x, table.z, 0, 0)).toBe(true); // 봇 — 돌아간다
  });

  it('밀어낸 결과가 월드 밖으로 나가지 않는다', () => {
    // 벽쪽 랙 안에서 밀려나도 서버 검증 범위를 벗어나면 안 된다
    for (const c of COLLIDERS) {
      const out = resolveCollisions(c.x, c.z, 0, 0);
      expect(out.x).toBeGreaterThanOrEqual(WORLD.minX - 2);
      expect(out.x).toBeLessThanOrEqual(WORLD.maxX + 2);
      expect(out.z).toBeGreaterThanOrEqual(WORLD.minZ - 2);
      expect(out.z).toBeLessThanOrEqual(WORLD.maxZ + 2);
    }
  });
});

describe('groundHeightAt', () => {
  it('빈 바닥은 0', () => {
    expect(groundHeightAt(-6, -11, 0)).toBe(0);
  });

  it('가구 위에 있으면 그 윗면', () => {
    expect(groundHeightAt(SOFA.x, SOFA.z, SOFA.top)).toBe(SOFA.top);
  });

  it('아직 그 윗면보다 아래면 딛지 않는다 — 옆을 걷다 순간이동하지 않게', () => {
    expect(groundHeightAt(SOFA.x, SOFA.z, 0)).toBe(0);
  });
});
