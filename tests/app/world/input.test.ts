/**
 * 모바일 조작의 순수 함수 — 조이스틱 벡터 · 세로 시야각.
 *
 * 화면을 띄우지 않고 확인할 수 있는 게 이 함수들을 따로 뺀 이유다
 * (app/world/input.ts 머리말). 손가락 좌표는 브라우저 없이도 만들 수 있다.
 */

import { describe, expect, it } from 'vitest';

import {
  BASE_FOV,
  STICK_DEADZONE,
  STICK_RADIUS,
  STICK_RUN,
  fovForAspect,
  stickKnob,
  stickVector,
} from '@/app/world/input';

describe('stickVector', () => {
  it('중심을 짚기만 하면 안 움직인다', () => {
    expect(stickVector(0, 0)).toEqual({ x: 0, z: 0, running: false });
  });

  it('데드존 안은 안 움직인다 — 엄지를 얹기만 해도 걸어가면 안 된다', () => {
    const inside = STICK_RADIUS * (STICK_DEADZONE - 0.05);
    const v = stickVector(inside, 0);
    expect(v.x).toBe(0);
    expect(v.z).toBe(0);
  });

  it('위로 밀면 앞으로 간다 (화면 좌표는 아래가 양수)', () => {
    const v = stickVector(0, -STICK_RADIUS);
    expect(v.z).toBeGreaterThan(0);
    expect(v.x).toBeCloseTo(0);
  });

  it('오른쪽으로 밀면 x 가 양수다', () => {
    const v = stickVector(STICK_RADIUS, 0);
    expect(v.x).toBeGreaterThan(0);
    expect(v.z).toBeCloseTo(0);
  });

  it('길이가 절대 1을 넘지 않는다 — 대각선으로 끝까지 밀어도', () => {
    const far = STICK_RADIUS * 3;
    for (const [dx, dy] of [
      [far, far],
      [-far, far],
      [far, -far],
      [-far, -far],
    ]) {
      const v = stickVector(dx, dy);
      expect(Math.hypot(v.x, v.z)).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('데드존을 갓 넘으면 느리고, STICK_RUN 부터는 최고 속도다', () => {
    const justOver = stickVector(STICK_RADIUS * (STICK_DEADZONE + 0.02), 0);
    expect(Math.hypot(justOver.x, justOver.z)).toBeLessThan(0.2);

    const full = stickVector(STICK_RADIUS * STICK_RUN, 0);
    expect(Math.hypot(full.x, full.z)).toBeCloseTo(1, 5);
  });

  it('끝까지 밀어야 달린다 — 별도 버튼이 없으므로 이 문턱이 유일한 통로다', () => {
    expect(stickVector(STICK_RADIUS * (STICK_RUN - 0.1), 0).running).toBe(false);
    expect(stickVector(STICK_RADIUS * STICK_RUN, 0).running).toBe(true);
    expect(stickVector(STICK_RADIUS * 2, 0).running).toBe(true);
  });
});

describe('stickKnob', () => {
  it('원 안에서는 손가락을 그대로 따라간다', () => {
    expect(stickKnob(10, -20)).toEqual({ x: 10, y: -20 });
  });

  it('원 밖으로 나가면 테두리에 붙는다', () => {
    const k = stickKnob(500, 0);
    expect(k.x).toBeCloseTo(STICK_RADIUS);
    expect(k.y).toBeCloseTo(0);
  });
});

describe('fovForAspect', () => {
  /*
   * ★ 이 검사가 이 함수의 존재 이유다. 폰을 고치려다 **이미 하던 데스크톱 게임의
   *   화면을 바꿔 놓으면** 안 된다 — 창을 최대화하지 않은 사람은 16:9 가 아니다.
   *   기준을 4:3 으로 둔 덕에 그보다 넓은 창은 전부 정확히 기본값이다.
   */
  it.each([
    ['4:3 (창을 좁게 쓴 데스크톱)', 4 / 3],
    ['16:10 (맥북)', 16 / 10],
    ['16:9', 16 / 9],
    ['21:9 (울트라와이드)', 21 / 9],
    ['32:9', 32 / 9],
  ])('가로 %s 에서는 기본값 그대로다', (_label, aspect) => {
    expect(fovForAspect(aspect)).toBeCloseTo(BASE_FOV, 5);
  });

  it('세로 화면에서는 시야각을 넓힌다', () => {
    expect(fovForAspect(9 / 16)).toBeGreaterThan(BASE_FOV);
  });

  it('아무리 좁아도 82도를 넘지 않는다 — 넘으면 가장자리가 어안렌즈가 된다', () => {
    expect(fovForAspect(0.3)).toBeLessThanOrEqual(82);
    expect(fovForAspect(9 / 21)).toBeLessThanOrEqual(82);
  });

  it('4:3 보다 조금이라도 좁아지면 그때부터 넓어진다 (끊기지 않고 이어진다)', () => {
    const justNarrower = fovForAspect(4 / 3 - 0.01);
    expect(justNarrower).toBeGreaterThan(BASE_FOV);
    // 문턱에서 확 튀지 않는다 — 창 크기를 조금 줄였는데 화면이 확 넓어지면 안 된다
    expect(justNarrower).toBeLessThan(BASE_FOV + 1);
  });

  it('말이 안 되는 비율에는 기본값을 준다 (첫 프레임의 0 등)', () => {
    expect(fovForAspect(0)).toBe(BASE_FOV);
    expect(fovForAspect(Number.NaN)).toBe(BASE_FOV);
  });

  it('좁아질수록 단조롭게 넓어진다', () => {
    const wide = fovForAspect(1.6);
    const square = fovForAspect(1.0);
    const tall = fovForAspect(0.6);
    expect(square).toBeGreaterThanOrEqual(wide);
    expect(tall).toBeGreaterThanOrEqual(square);
  });
});
