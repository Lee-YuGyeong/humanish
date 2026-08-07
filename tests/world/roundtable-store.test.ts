/**
 * 좌석 메모 (app/world/roundtable-store.ts 의 guesses).
 *
 * 화면 없이 **누르는 차례만** 본다 — 사용자가 정한 순서가 ? → 사람 → 연기자 → AI → ?
 * 하나뿐이라, 여기가 그 순서의 기준이다. 그리는 쪽(game-hud 의 SeatNotes)은 이 값을
 * 라벨로 바꾸기만 한다.
 *
 * ★ 소켓·서버는 여기 없다. 이 값은 화면 밖으로 나가지 않는다 (스토어 머리말, I1).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { useRoundtableStore } from '@/app/world/roundtable-store';

const guessOf = (id: string) => useRoundtableStore.getState().guesses[id];
const cycle = (id: string) => useRoundtableStore.getState().cycleGuess(id);

beforeEach(() => {
  useRoundtableStore.getState().reset();
});

describe('좌석 메모 — ? → 사람 → 연기자 → AI → ?', () => {
  it('처음에는 아무것도 안 찍혀 있다', () => {
    expect(guessOf('p1')).toBeUndefined();
  });

  it('누를 때마다 한 칸씩 돌고 처음으로 돌아온다', () => {
    cycle('p1');
    expect(guessOf('p1')).toBe('human');
    cycle('p1');
    expect(guessOf('p1')).toBe('actor');
    cycle('p1');
    expect(guessOf('p1')).toBe('ai');
    cycle('p1');
    // ★ '?' 는 값이 아니라 **키가 없는 것**이다 — undefined 를 넣어 두면 나간
    //   사람의 자리가 메모에 계속 남는다.
    expect(guessOf('p1')).toBeUndefined();
    expect('p1' in useRoundtableStore.getState().guesses).toBe(false);
  });

  it('자리마다 따로 센다 — 한 명을 눌러도 남의 칸은 안 움직인다', () => {
    cycle('p1');
    cycle('p2');
    cycle('p2');
    expect(guessOf('p1')).toBe('human');
    expect(guessOf('p2')).toBe('actor');
  });

  it('★ 새 판(rematch)이 열리면 지난 판의 낙서가 걷힌다', () => {
    // 지난 판의 메모가 남아 있으면 그게 지금 판의 판단인 것처럼 보인다.
    // 걷는 자리는 myRole 과 **같다** — 판이 끝난 뒤에 오는 topic 하나뿐이다.
    const round = (phase: 'reveal' | 'topic') => ({
      phase,
      topic: null,
      endsAt: 0,
      round: 0,
      totalRounds: 2,
      spotlightId: null,
      nomineeId: null,
      revote: 0,
    });

    cycle('p1');
    useRoundtableStore.getState().applyRound(round('reveal'));
    expect(guessOf('p1')).toBe('human'); // 결과를 읽는 동안에는 남아 있다

    useRoundtableStore.getState().applyRound(round('topic'));
    expect(guessOf('p1')).toBeUndefined();
  });

  it('판 중간의 topic 은 안 걷는다 — 두 번째 주제에서 메모가 사라지면 안 된다', () => {
    // 한 판에 topic 은 두 번 온다 (ROUND_TOPIC_ROUNDS). 역할 라벨이 그렇게 한 번
    // 사라졌던 적이 있고(스토어 상자 주석), 메모도 같은 조건을 탄다.
    const topic = {
      phase: 'topic' as const,
      topic: '두 번째 주제',
      endsAt: 0,
      round: 2,
      totalRounds: 2,
      spotlightId: null,
      nomineeId: null,
      revote: 0,
    };

    cycle('p1');
    useRoundtableStore.getState().applyRound({ ...topic, phase: 'speak' });
    useRoundtableStore.getState().applyRound(topic);
    expect(guessOf('p1')).toBe('human');
  });
});
