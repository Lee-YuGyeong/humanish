/**
 * 보간 — 남의 아바타가 매끄럽게 움직이는지의 근거. 소유: A
 *
 * DB도 브라우저도 없이 검사한다. 시각을 인자로 받는 순수 함수라서 가능하다 (lib/mp/interp.ts).
 */

import { describe, expect, it } from 'vitest';
import { MOVE_BUFFER_MAX } from '@/lib/mp/constants';
import { lerpAngle, pushSample, sampleAt, type MoveSample, type Pose } from '@/lib/mp/interp';

function pose(): Pose {
  return { x: 0, z: 0, y: 0, heading: 0 };
}

describe('lerpAngle', () => {
  it('경계를 넘을 때 한 바퀴 돌지 않는다', () => {
    // +179° → -179°. 최단 경로는 2°지 358°가 아니다
    const a = Math.PI - 0.02;
    const b = -Math.PI + 0.02;
    const mid = lerpAngle(a, b, 0.5);
    // 중간값은 ±π 근처여야 한다. 0 근처면 반대로 돈 것이다
    expect(Math.abs(Math.abs(mid) - Math.PI)).toBeLessThan(0.05);
  });
});

describe('pushSample', () => {
  it('버퍼 상한을 넘으면 오래된 것부터 버린다', () => {
    const buffer: MoveSample[] = [];
    for (let i = 0; i < MOVE_BUFFER_MAX + 10; i++) {
      pushSample(buffer, { t: i, x: i, z: 0, y: 0, heading: 0 });
    }
    expect(buffer).toHaveLength(MOVE_BUFFER_MAX);
    expect(buffer[buffer.length - 1].x).toBe(MOVE_BUFFER_MAX + 9);
  });
});

describe('sampleAt', () => {
  const buffer: MoveSample[] = [
    { t: 1000, x: 0, z: 0, y: 0, heading: 0 },
    { t: 1100, x: 1, z: 2, y: 1, heading: 0 },
  ];

  it('버퍼가 비면 false — 호출자가 마지막 자세를 유지한다', () => {
    expect(sampleAt([], 1000, pose())).toBe(false);
  });

  it('두 샘플 사이를 선형 보간한다', () => {
    const out = pose();
    sampleAt(buffer, 1050, out);
    expect(out.x).toBeCloseTo(0.5, 6);
    expect(out.z).toBeCloseTo(1, 6);
    // 점프 높이도 같이 따라온다. 여기가 빠지면 남의 점프가 바닥에 붙어 보인다
    expect(out.y).toBeCloseTo(0.5, 6);
  });

  it('마지막 샘플보다 미래면 외삽하지 않는다', () => {
    // 외삽하면 멈춘 사람이 계속 미끄러져 벽으로 들어간다
    const out = pose();
    sampleAt(buffer, 9999, out);
    expect(out.x).toBe(1);
    expect(out.z).toBe(2);
    expect(out.y).toBe(1);
  });

  it('첫 샘플보다 과거면 첫 샘플을 쓴다', () => {
    const out = pose();
    sampleAt(buffer, 0, out);
    expect(out.x).toBe(0);
  });

  it('같은 ms에 두 샘플이 들어와도 나누기 0이 되지 않는다', () => {
    const dup: MoveSample[] = [
      { t: 1000, x: 0, z: 0, y: 0, heading: 0 },
      { t: 1000, x: 5, z: 5, y: 0, heading: 0 },
      { t: 1200, x: 5, z: 5, y: 0, heading: 0 },
    ];
    const out = pose();
    sampleAt(dup, 1000, out);
    expect(Number.isFinite(out.x)).toBe(true);
  });
});
