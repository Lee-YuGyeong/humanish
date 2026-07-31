/**
 * 클립 병합의 바인드 보정. 소유: 원상 (/world) · 검사: A
 *
 * `tools/merge-glb-anims.mjs` 는 원본 GLB 가 있어야 돌릴 수 있는데 그 원본은
 * 저장소에 없다 (app/world/avatar.tsx 머리말). 그래서 **수학만이라도** 여기서 잡는다.
 * 이게 틀리면 증상은 "팔이 벌어지고 다리가 X 자로 모인다" 로 나오고,
 * 3D 를 눈으로 보기 전에는 아무도 모른다.
 */

import { describe, expect, it } from 'vitest';

import { qinv, qmul, retargetRotation } from '../../tools/merge-glb-anims.mjs';

type Q = [number, number, number, number];

const I: Q = [0, 0, 0, 1];

/**
 * 축 둘레로 deg 만큼 도는 쿼터니언.
 * ★ 축을 반드시 정규화한다 — 안 하면 단위 쿼터니언이 아니게 되어 qinv(켤레)가
 *   역이 아니게 되고, 검사가 미세하게 틀어진다 (실제로 한 번 걸렸다).
 */
function axisAngle(axis: [number, number, number], deg: number): Q {
  const len = Math.hypot(...axis) || 1;
  const r = (deg * Math.PI) / 180 / 2;
  const s = Math.sin(r) / len;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(r)];
}

/** 쿼터니언으로 벡터를 돌린다 — 결과를 눈에 보이는 값으로 견주려고 쓴다 */
function rotate(q: Q, v: [number, number, number]): [number, number, number] {
  const t: [number, number, number] = [
    2 * (q[1] * v[2] - q[2] * v[1]),
    2 * (q[2] * v[0] - q[0] * v[2]),
    2 * (q[0] * v[1] - q[1] * v[0]),
  ];
  return [
    v[0] + q[3] * t[0] + q[1] * t[2] - q[2] * t[1],
    v[1] + q[3] * t[1] + q[2] * t[0] - q[0] * t[2],
    v[2] + q[3] * t[2] + q[0] * t[1] - q[1] * t[0],
  ];
}

function expectClose(a: readonly number[], b: readonly number[]) {
  // 쿼터니언은 q 와 -q 가 같은 회전이다
  const flip = a[3] * b[3] < 0 ? -1 : 1;
  a.forEach((v, i) => expect(v).toBeCloseTo(flip * b[i], 6));
}

describe('retargetRotation', () => {
  it('바인드가 같으면 아무것도 안 바꾼다 — 보정을 켜도 손해가 없다', () => {
    const rest = axisAngle([0, 0, 1], 63);
    const q = axisAngle([1, 0, 0], 20);
    expect(retargetRotation(q, rest, rest)).toBe(q);
  });

  it('바인드만 다르고 자세는 바인드 그대로면, 결과도 base 바인드다', () => {
    // 소스에서 "안 움직인 상태"(q = 소스 바인드)는 base 에서도 "안 움직인 상태"여야 한다.
    const restSrc = axisAngle([0, 0, 1], 40);
    const restBase = axisAngle([0, 0, 1], 63);
    expectClose(retargetRotation(restSrc, restSrc, restBase), restBase);
  });

  it('바인드 대비 회전량은 그대로 옮겨진다', () => {
    const restSrc = axisAngle([0, 0, 1], 40);
    const restBase = axisAngle([0, 0, 1], 63);
    const delta = axisAngle([0, 0, 1], 15); // 바인드에서 15도 더 돈 자세
    const q = qmul(restSrc, delta) as Q;

    const out = retargetRotation(q, restSrc, restBase) as Q;
    // base 바인드에서 본 회전량이 그대로 15도여야 한다
    expectClose(qmul(qinv(restBase), out), delta);
  });

  it('★ 팔이 벌어지는 그 상황 — 보정하면 팔이 제자리로 온다', () => {
    // 소스 리그의 팔 바인드가 base 보다 30도 덜 내려가 있다고 하자.
    // 보정 없이 그대로 얹으면 팔이 딱 그만큼 위로 뜬다 (= 벌어져 보인다).
    const restBase = axisAngle([0, 0, 1], -70); // base: 팔을 몸 옆으로 내린 자세
    const restSrc = axisAngle([0, 0, 1], -40); // 소스: 덜 내려간 자세
    const q = restSrc as Q; // 소스에서 가만히 서 있는 프레임

    const armDown: [number, number, number] = [1, 0, 0];
    const raw = rotate(q, armDown); // 보정 없이 얹었을 때
    const fixed = rotate(retargetRotation(q, restSrc, restBase) as Q, armDown);
    const want = rotate(restBase, armDown); // 원래 있어야 할 자리

    // 보정본은 제자리, 보정 안 한 쪽은 눈에 띄게 어긋난다
    expectClose(fixed, want);
    expect(Math.hypot(raw[0] - want[0], raw[1] - want[1])).toBeGreaterThan(0.4);
  });

  it('qmul · qinv 가 서로의 역이다', () => {
    const q = axisAngle([0.267, 0.535, 0.802], 77);
    expectClose(qmul(q, qinv(q)), I);
  });
});
