/**
 * B를 기다리는 동안 게임을 돌리고 있는 임시 규칙. 소유: A (SPEC §8, §17)
 *
 * ┌─ 왜 이걸 검사하나 ──────────────────────────────────────────────────────┐
 * │ lib/game/rules.ts는 아직 전부 '미구현 (B)'로 던진다. 그래서 지금 한 판을 │
 * │ 실제로 굴리고 있는 건 라우트 안의 폴백 두 개다. 즉 **지금 이 게임의      │
 * │ 규칙은 여기 적힌 것**이고, 이게 틀리면 스파이가 안 생기거나 점수가       │
 * │ 엉뚱해진다. 임시라고 검사를 안 하면 임시인 채로 배포된다.               │
 * │                                                                        │
 * │ 채점 규칙(SCORE_RULE)은 **SPEC에 근거가 없다.** §8은 시그니처만 정했고  │
 * │ 방식은 정해진 적이 없어서 A가 임의로 골랐다. 여기 값은 "합의된 규칙"이  │
 * │ 아니라 "지금 화면에 뜨는 규칙"이다. 정해지면 SPEC·라우트·이 파일을      │
 * │ 같이 고친다.                                                           │
 * └────────────────────────────────────────────────────────────────────────┘
 */
import { describe, expect, it } from 'vitest';
import { SCORE_RULE, fallbackAssignRoles, fallbackCalcScores } from '@/lib/server/fallback-rules';
import { assignRoles, calcScores, mostSuspectedHuman } from '@/lib/game/rules';
import type { Role } from '@/lib/game/types';

describe('fallbackAssignRoles — SPEC §8', () => {
  it('봇 자리는 전부 ai다', () => {
    const roles = fallbackAssignRoles([true, true, true], 0);
    expect(roles).toEqual(['ai', 'ai', 'ai']);
  });

  it('사람이 2명 이상이면 정확히 1명이 스파이다', () => {
    // 시드를 바꿔가며 돌려도 스파이 수는 늘 1이어야 한다.
    for (let seed = 0; seed < 20; seed += 1) {
      const roles = fallbackAssignRoles([false, false, true, false, true], seed);
      expect(roles.filter((r) => r === 'spy')).toHaveLength(1);
    }
  });

  it('사람이 1명뿐이면 스파이가 없다', () => {
    // 혼자 스파이면 "AI인 척해서 표를 끌어올" 상대가 없다. 게임이 성립하지 않는다.
    const roles = fallbackAssignRoles([false, true, true], 7);
    expect(roles).toEqual(['citizen', 'ai', 'ai']);
  });

  it('스파이는 반드시 사람 자리에 배정된다', () => {
    // 봇이 스파이가 되면 그 자리는 ai도 spy도 아니게 되어 채점이 통째로 어긋난다.
    for (let seed = 0; seed < 20; seed += 1) {
      const isBot = [true, false, true, false, false];
      const roles = fallbackAssignRoles(isBot, seed);
      const spyIndex = roles.indexOf('spy');
      expect(isBot[spyIndex]).toBe(false);
    }
  });

  it('입력과 길이가 같고, 봇 자리는 시드와 무관하게 그대로다', () => {
    const isBot = [false, true, false, true, false, true, false, true];
    for (let seed = 0; seed < 10; seed += 1) {
      const roles = fallbackAssignRoles(isBot, seed);
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
      const roles = fallbackAssignRoles(isBot, capacity);
      expect(roles).toHaveLength(capacity);
      expect(roles.filter((r) => r === 'spy')).toHaveLength(1);
      expect(roles.filter((r) => r === 'ai')).toHaveLength(capacity - 2);
    }
  });

  it('시드가 같으면 결과도 같다 (I3 — 함수 안에서 난수를 만들지 않는다)', () => {
    const isBot = [false, false, false, true];
    expect(fallbackAssignRoles(isBot, 3)).toEqual(fallbackAssignRoles(isBot, 3));
  });
});

describe('fallbackCalcScores — 화면에 뜨는 채점 규칙', () => {
  //  시민 A·B, 스파이 S, AI 둘(X, Y)
  const roles: Record<string, Role> = {
    A: 'citizen',
    B: 'citizen',
    S: 'spy',
    X: 'ai',
    Y: 'ai',
  };

  it('시민이 AI를 찍으면 +2', () => {
    const s = fallbackCalcScores([{ voterId: 'A', targetId: 'X' }], roles);
    expect(s.A).toBe(2);
  });

  it('시민이 사람을 찍으면 0점', () => {
    const s = fallbackCalcScores([{ voterId: 'A', targetId: 'S' }], roles);
    expect(s.A).toBe(0);
  });

  it('스파이는 받은 표 하나당 +2', () => {
    const s = fallbackCalcScores(
      [
        { voterId: 'A', targetId: 'S' },
        { voterId: 'B', targetId: 'S' },
      ],
      roles,
    );
    expect(s.S).toBe(4);
  });

  it('AI는 표를 하나도 안 받으면 +3, 한 장이라도 받으면 0', () => {
    const s = fallbackCalcScores([{ voterId: 'A', targetId: 'X' }], roles);
    expect(s.X).toBe(0); // 들켰다
    expect(s.Y).toBe(3); // 안 들켰다
  });

  it('투표가 없어도 모든 참가자가 점수표에 있다', () => {
    // 한 명이라도 빠지면 순위 화면에서 그 사람이 통째로 사라진다.
    const s = fallbackCalcScores([], roles);
    expect(Object.keys(s).sort()).toEqual(['A', 'B', 'S', 'X', 'Y']);
    // 아무도 안 찍었으면 AI 둘만 +3이다
    expect(s).toEqual({ A: 0, B: 0, S: 0, X: 3, Y: 3 });
  });

  it('SCORE_RULE 문구가 실제 계산과 어긋나지 않는다', () => {
    // 이 문구는 결과 화면에 그대로 뜬다. 계산을 고치고 문구를 안 고치면
    // 화면이 거짓말을 하게 된다.
    expect(SCORE_RULE).toHaveLength(3);
    expect(SCORE_RULE[0]).toContain('+2');
    expect(SCORE_RULE[1]).toContain('+2');
    expect(SCORE_RULE[2]).toContain('+3');
  });
});

describe('lib/game/rules.ts는 아직 B의 것이다 (경보용)', () => {
  /**
   * ★ 이 describe가 실패하면 축하할 일이다 — B가 구현했다는 뜻이다.
   *   그때 할 일:
   *     1. lib/server/fallback-rules.ts 를 통째로 지운다
   *     2. app/api/room/start/route.ts 의 resolveRoles, app/api/reveal/route.ts 의
   *        resolveScores — try/catch를 지우고 진짜 함수를 직접 부른다
   *     3. 이 파일의 폴백 테스트를 lib/game/rules 쪽으로 옮긴다
   *   폴백을 남겨두면 진짜 규칙이 던질 때 조용히 임시 규칙으로 돌아간다.
   */
  const 안내 = '구현됐다면 라우트의 폴백을 지울 것 (이 파일 주석 참고)';

  it(`assignRoles는 아직 미구현이다 — ${안내}`, () => {
    expect(() => assignRoles([false, true], 0)).toThrow('미구현');
  });

  it(`calcScores는 아직 미구현이다 — ${안내}`, () => {
    expect(() => calcScores([], {})).toThrow('미구현');
  });

  it(`mostSuspectedHuman은 아직 미구현이다 — ${안내}`, () => {
    expect(() => mostSuspectedHuman([], {})).toThrow('미구현');
  });
});
