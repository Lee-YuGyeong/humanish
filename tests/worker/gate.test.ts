/**
 * 집결 게이트 — 도착 집계 · 상한 · "한 번 열리면 안 닫힌다". 소유: A
 *
 * gate.ts 는 lib/mp 도 안 보는 순수 함수라 node 환경에서 그대로 돈다
 * (roundtable.test.ts · bots.test.ts 와 같은 이유). 여기서 깨졌을 때의 증상이
 * **"방이 영원히 시작 안 됨"** 또는 반대로 **"혼자 먼저 시작됨"** 이라
 * 브라우저로는 사람 여럿을 붙여야 재현된다 — 그래서 조각으로 확인한다.
 */

import { describe, expect, it } from 'vitest';

import { gateCounts, gateStartsAt, stepGate, type GateState } from '../../worker/src/gate';

const DEADLINE = 75_000;
const INTRO = 20_000;
const T0 = 1_000_000;

/** 사람 셋짜리 방. 봇 좌석은 애초에 인자로 들어오지 않는다 */
const HUMANS = ['a', 'b', 'c'];

describe('stepGate — 전원이 모여야 열린다', () => {
  it('아무도 안 왔으면 안 열린다', () => {
    const s = stepGate(null, HUMANS, [], T0, DEADLINE, T0 + 1_000);
    expect(s.openedAt).toBeNull();
    expect(gateCounts(s, HUMANS)).toEqual({ present: 0, total: 3 });
  });

  it('일부만 왔으면 안 열린다', () => {
    const s = stepGate(null, HUMANS, ['a', 'b'], T0, DEADLINE, T0 + 1_000);
    expect(s.openedAt).toBeNull();
    expect(gateCounts(s, HUMANS)).toEqual({ present: 2, total: 3 });
  });

  it('전원이 모이면 그 시각에 열린다', () => {
    const at = T0 + 5_000;
    const s = stepGate(null, HUMANS, HUMANS, T0, DEADLINE, at);
    expect(s.openedAt).toBe(at);
    expect(gateStartsAt(s, INTRO)).toBe(at + INTRO);
  });

  it('한 명씩 들어와도 마지막 한 명에서 열린다 — 도착은 누적된다', () => {
    let s: GateState | null = null;
    s = stepGate(s, HUMANS, ['a'], T0, DEADLINE, T0 + 1_000);
    expect(s.openedAt).toBeNull();
    // b 가 붙는 순간 a 의 소켓은 여전히 살아 있다 — 그래도 누적이 근거다
    s = stepGate(s, HUMANS, ['a', 'b'], T0, DEADLINE, T0 + 2_000);
    expect(s.openedAt).toBeNull();
    s = stepGate(s, HUMANS, ['a', 'b', 'c'], T0, DEADLINE, T0 + 3_000);
    expect(s.openedAt).toBe(T0 + 3_000);
  });
});

describe('stepGate — 새로고침이 게이트를 되돌리지 않는다 (I1)', () => {
  it('도착 명단은 소켓이 끊겨도 줄지 않는다', () => {
    let s = stepGate(null, HUMANS, ['a', 'b'], T0, DEADLINE, T0 + 1_000);
    // a 가 새로고침 중이라 지금 붙어 있는 건 b 뿐이다
    s = stepGate(s, HUMANS, ['b'], T0, DEADLINE, T0 + 2_000);
    expect(gateCounts(s, HUMANS).present).toBe(2);
  });

  it('전원 도착 뒤 한 명이 나가도 present 가 줄지 않는다 — 그 감소가 곧 신호다', () => {
    let s = stepGate(null, HUMANS, HUMANS, T0, DEADLINE, T0 + 1_000);
    s = stepGate(s, HUMANS, ['a'], T0, DEADLINE, T0 + 2_000);
    expect(gateCounts(s, HUMANS).present).toBe(3);
  });

  it('한 번 열린 게이트는 다시 닫히지 않고 시각도 안 흔들린다', () => {
    const opened = stepGate(null, HUMANS, HUMANS, T0, DEADLINE, T0 + 5_000);
    const later = stepGate(opened, HUMANS, [], T0, DEADLINE, T0 + 40_000);
    expect(later.openedAt).toBe(T0 + 5_000);
    expect(gateStartsAt(later, INTRO)).toBe(T0 + 5_000 + INTRO);
  });
});

describe('stepGate — 상한 (안 들어온 사람이 있어도 연다)', () => {
  it('상한 전에는 안 열린다', () => {
    const s = stepGate(null, HUMANS, ['a'], T0, DEADLINE, T0 + DEADLINE - 1);
    expect(s.openedAt).toBeNull();
  });

  it('상한이 지나면 한 명만 있어도 열린다', () => {
    const at = T0 + DEADLINE;
    const s = stepGate(null, HUMANS, ['a'], T0, DEADLINE, at);
    expect(s.openedAt).toBe(at);
    // 열려도 숫자는 사실 그대로다 — "누가 안 왔는지"는 어디에도 없다
    expect(gateCounts(s, HUMANS)).toEqual({ present: 1, total: 3 });
  });

  it('상한의 기준점은 시작 시각이다 — 아무도 안 들어와도 걸린다', () => {
    const s = stepGate(null, HUMANS, [], T0, DEADLINE, T0 + DEADLINE + 1);
    expect(s.openedAt).toBe(T0 + DEADLINE + 1);
  });
});

describe('stepGate — 명단 밖의 id', () => {
  it('사람 좌석이 아닌 id 는 도착으로 세지 않는다', () => {
    const s = stepGate(null, HUMANS, ['a', 'bot-1'], T0, DEADLINE, T0 + 1_000);
    expect(gateCounts(s, HUMANS).present).toBe(1);
    expect(s.openedAt).toBeNull();
  });

  it('좌석에서 빠진 사람은 도착 명단에서도 빠진다 — 안 그러면 present > total 이 된다', () => {
    let s = stepGate(null, HUMANS, HUMANS, T0, DEADLINE, T0 + 1_000);
    const two = ['a', 'b'];
    s = stepGate(s, two, ['a'], T0, DEADLINE, T0 + 2_000);
    expect(gateCounts(s, two)).toEqual({ present: 2, total: 2 });
  });

  it('사람 좌석이 없는 방은 곧바로 열린다 — 기다릴 대상이 없다', () => {
    const s = stepGate(null, [], [], T0, DEADLINE, T0);
    expect(s.openedAt).toBe(T0);
  });
});

describe('gateStartsAt', () => {
  it('열리기 전에는 null 이다 — 클라이언트는 그때 대기 화면을 띄운다', () => {
    expect(gateStartsAt(null, INTRO)).toBeNull();
    expect(gateStartsAt({ arrived: ['a'], openedAt: null }, INTRO)).toBeNull();
  });
});
