/**
 * 역할 배정 · 채점 규칙. 소유: B (SPEC §8, §8.1)
 *
 * tests/lib/server/fallback-rules.test.ts(삭제됨)에서 옮겨 왔다 — 검사 목록은
 * 그대로고, 대상만 임시 규칙에서 진짜 규칙(lib/game/rules.ts)으로 바뀌었다.
 * 채점 방식의 근거는 rules.ts의 SCORE_RULE 상자 주석에 있다.
 */
import { describe, expect, it } from 'vitest';
import {
  SCORE_RULE,
  assignRoles,
  calcScores,
  humanVotesReceived,
  mostSuspectedHuman,
} from '@/lib/game/rules';
import type { Role } from '@/lib/game/types';

describe('assignRoles — SPEC §8', () => {
  it('봇 자리는 전부 ai다', () => {
    const roles = assignRoles([true, true, true], 0);
    expect(roles).toEqual(['ai', 'ai', 'ai']);
  });

  it('사람이 2명 이상이면 정확히 1명이 스파이다', () => {
    // 시드를 바꿔가며 돌려도 스파이 수는 늘 1이어야 한다.
    for (let seed = 0; seed < 20; seed += 1) {
      const roles = assignRoles([false, false, true, false, true], seed);
      expect(roles.filter((r) => r === 'spy')).toHaveLength(1);
    }
  });

  it('사람이 1명뿐이면 스파이가 없다', () => {
    // 혼자 스파이면 "AI인 척해서 표를 끌어올" 상대가 없다. 게임이 성립하지 않는다.
    const roles = assignRoles([false, true, true], 7);
    expect(roles).toEqual(['citizen', 'ai', 'ai']);
  });

  it('스파이는 반드시 사람 자리에 배정된다', () => {
    // 봇이 스파이가 되면 그 자리는 ai도 spy도 아니게 되어 채점이 통째로 어긋난다.
    for (let seed = 0; seed < 20; seed += 1) {
      const isBot = [true, false, true, false, false];
      const roles = assignRoles(isBot, seed);
      const spyIndex = roles.indexOf('spy');
      expect(isBot[spyIndex]).toBe(false);
    }
  });

  it('입력과 길이가 같고, 봇 자리는 시드와 무관하게 그대로다', () => {
    const isBot = [false, true, false, true, false, true, false, true];
    for (let seed = 0; seed < 10; seed += 1) {
      const roles = assignRoles(isBot, seed);
      expect(roles).toHaveLength(isBot.length);
      isBot.forEach((bot, i) => {
        if (bot) expect(roles[i]).toBe('ai');
        else expect(roles[i]).not.toBe('ai');
      });
    }
  });

  it('정원 3~8 어디서든 성립한다 (§17.6)', () => {
    // 정원이 방마다 다르다. 5를 전제로 짠 규칙이 8인 방에서 깨지면 안 된다.
    for (let capacity = 3; capacity <= 8; capacity += 1) {
      // 사람 2 + 나머지 봇
      const isBot = Array.from({ length: capacity }, (_, i) => i >= 2);
      const roles = assignRoles(isBot, capacity);
      expect(roles).toHaveLength(capacity);
      expect(roles.filter((r) => r === 'spy')).toHaveLength(1);
      expect(roles.filter((r) => r === 'ai')).toHaveLength(capacity - 2);
    }
  });

  it('시드가 같으면 결과도 같다 (I3 — 함수 안에서 난수를 만들지 않는다)', () => {
    const isBot = [false, false, false, true];
    expect(assignRoles(isBot, 3)).toEqual(assignRoles(isBot, 3));
  });

  it('음수 시드가 와도 스파이는 배정된다 — 인덱스가 음수로 새지 않는다', () => {
    const roles = assignRoles([false, false, true], -7);
    expect(roles.filter((r) => r === 'spy')).toHaveLength(1);
  });
});

describe('calcScores — 화면에 뜨는 채점 규칙', () => {
  //  시민 A·B, 스파이 S, AI 둘(X, Y)
  const roles: Record<string, Role> = {
    A: 'citizen',
    B: 'citizen',
    S: 'spy',
    X: 'ai',
    Y: 'ai',
  };

  it('시민이 AI를 찍으면 +2', () => {
    const s = calcScores([{ voterId: 'A', targetId: 'X' }], roles);
    expect(s.A).toBe(2);
  });

  it('시민이 사람을 찍으면 0점', () => {
    const s = calcScores([{ voterId: 'A', targetId: 'S' }], roles);
    expect(s.A).toBe(0);
  });

  it('스파이는 사람 표를 한 장이라도 받으면 +4 (표 수에 비례하지 않는다)', () => {
    const one = calcScores([{ voterId: 'A', targetId: 'S' }], roles);
    const two = calcScores(
      [
        { voterId: 'A', targetId: 'S' },
        { voterId: 'B', targetId: 'S' },
      ],
      roles,
    );
    expect(one.S).toBe(4);
    // ★ 비례하면 스파이 상한이 정원에 딸려 올라간다. 옛 규칙(표당 +2)은 정원 8인 방에서
    //   최대 14점이라 시민 상한(2점)의 7배였다. 그래서 상한을 고정으로 바꿨다.
    expect(two.S).toBe(4);
  });

  it('AI는 사람 표를 하나도 안 받으면 +3, 한 장이라도 받으면 0', () => {
    const s = calcScores([{ voterId: 'A', targetId: 'X' }], roles);
    expect(s.X).toBe(0); // 들켰다
    expect(s.Y).toBe(3); // 안 들켰다
  });

  it('★ 봇이 던진 표는 점수에 넣지 않는다 (SPEC §8.1)', () => {
    // 봇은 자기 아닌 아무나 무작위로 찍는다 (on_enter_phase의 vote 훅).
    // 그 표를 세면 정원이 커질수록 결과가 실력이 아니라 주사위가 된다 —
    // 정원 8인 방에 사람이 둘이면 8표 중 6표가 무작위다.
    const botsOnly = [
      { voterId: 'X', targetId: 'S' }, // 봇이 스파이를 찍었다
      { voterId: 'Y', targetId: 'S' },
    ];
    const s = calcScores(botsOnly, roles);
    expect(s.S).toBe(0); // 봇 표만으로는 스파이가 점수를 못 얻는다
    expect(s.X).toBe(3); // 사람 표를 안 받았으므로 숨은 것이다
    expect(s.Y).toBe(3);
  });

  it('봇이 AI를 찍어도 그 봇에게 점수가 가지 않는다', () => {
    const s = calcScores([{ voterId: 'X', targetId: 'Y' }], roles);
    expect(s.X).toBe(3); // 자기가 표를 안 받았으니 +3. 맞힌 보상은 없다
    expect(s.Y).toBe(3); // 봇 표는 안 세므로 Y도 여전히 숨은 것이다
  });

  it('역할을 모르는 투표자는 사람으로 치지 않는다', () => {
    // roles에 없는 id가 섞이면 "봇 표를 뺀다"가 조용히 새는 자리다.
    const s = calcScores([{ voterId: '유령', targetId: 'S' }], roles);
    expect(s.S).toBe(0);
  });

  it('투표가 없어도 모든 참가자가 점수표에 있다', () => {
    // 한 명이라도 빠지면 순위 화면에서 그 사람이 통째로 사라진다.
    const s = calcScores([], roles);
    expect(Object.keys(s).sort()).toEqual(['A', 'B', 'S', 'X', 'Y']);
    // 아무도 안 찍었으면 AI 둘만 +3이다
    expect(s).toEqual({ A: 0, B: 0, S: 0, X: 3, Y: 3 });
  });

  it('humanVotesReceived는 사람 표만 센다 (결과 화면이 이걸 같이 띄운다)', () => {
    const got = humanVotesReceived(
      [
        { voterId: 'A', targetId: 'X' }, // 사람
        { voterId: 'Y', targetId: 'X' }, // 봇
      ],
      roles,
    );
    expect(got.X).toBe(1);
    expect(got.S).toBe(0);
  });

  it('SCORE_RULE 문구가 실제 계산과 어긋나지 않는다', () => {
    // 이 문구는 결과 화면에 그대로 뜬다. 계산을 고치고 문구를 안 고치면
    // 화면이 거짓말을 하게 된다.
    expect(SCORE_RULE).toHaveLength(4);
    expect(SCORE_RULE[0]).toContain('+2');
    expect(SCORE_RULE[1]).toContain('+4');
    expect(SCORE_RULE[2]).toContain('+3');
    // 봇 표를 뺀다는 것은 규칙의 절반이다. 화면에 안 적으면 아무도 모른다.
    expect(SCORE_RULE[3]).toContain('봇');
  });
});

describe('mostSuspectedHuman — 가장 의심받은 사람 (reveal 화면용)', () => {
  const roles: Record<string, Role> = {
    A: 'citizen',
    S: 'spy',
    X: 'ai',
  };

  it('표를 가장 많이 받은 사람(citizen·spy)을 준다', () => {
    const who = mostSuspectedHuman(
      [{ targetId: 'S' }, { targetId: 'S' }, { targetId: 'A' }],
      roles,
    );
    expect(who).toBe('S');
  });

  it('AI에게 간 표는 세지 않는다 — "의심받은 사람"이므로', () => {
    const who = mostSuspectedHuman(
      [{ targetId: 'X' }, { targetId: 'X' }, { targetId: 'A' }],
      roles,
    );
    expect(who).toBe('A');
  });

  it('사람에게 간 표가 없으면 null', () => {
    expect(mostSuspectedHuman([], roles)).toBeNull();
    expect(mostSuspectedHuman([{ targetId: 'X' }], roles)).toBeNull();
  });

  it('동수면 id 사전순으로 앞선 쪽 — 순수 함수라 결과가 흔들리면 안 된다', () => {
    const tied = [{ targetId: 'S' }, { targetId: 'A' }];
    expect(mostSuspectedHuman(tied, roles)).toBe('A');
    expect(mostSuspectedHuman([...tied].reverse(), roles)).toBe('A');
  });
});
