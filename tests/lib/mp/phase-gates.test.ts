/**
 * 단계별 행동표 — **워커와 클라이언트가 같이 읽는 유일한 목록.** 소유: A
 *
 * ┌─ 왜 이 파일이 있나 ────────────────────────────────────────────────────────┐
 * │ 여기 있는 건 상수 배열 몇 개라 "검사할 게 없어" 보인다. 그런데 이 저장소가   │
 * │ 실제로 데인 사고가 정확히 이거였다: 같은 규칙이 두 파일에 손으로 적혀 있었고  │
 * │ (worker 의 botsStill, 클라의 uiOpen) **클라 쪽에 defense 가 빠져 있었다.**    │
 * │ 그 20초 동안 봇은 통째로 얼어붙고 사람만 걸어다녔다 — player_moved 가 한 번   │
 * │ 이라도 나온 자리는 사람 확정이고, 총 자리·AI 수가 공개(§15-3)라 소거법으로    │
 * │ 전 좌석이 갈린다. 한 판이면 게임이 끝난다.                                   │
 * │                                                                            │
 * │ 그래서 이 검사는 "값이 맞는가"가 아니라 **"목록이 조용히 갈라졌는가"** 를     │
 * │ 본다. 단계를 더하거나 뺄 때 여기가 먼저 걸리는 게 이 파일의 전부다.           │
 * └────────────────────────────────────────────────────────────────────────────┘
 */

import { describe, expect, it } from 'vitest';

import {
  CHAT_LOCKED_PHASES,
  MOVEMENT_LOCKED_PHASES,
  isChatLocked,
  isMovementLocked,
  mayChat,
  mayMove,
} from '@/lib/mp/constants';
import type { RoundPhase } from '@/lib/mp/protocol';

/** RoundPhase 전부. 멤버가 늘면 여기서 타입 에러가 난다 — 그게 목적이다. */
const ALL_PHASES: readonly RoundPhase[] = [
  'idle',
  'topic',
  'speak',
  'freechat',
  'vote',
  'defense',
  'verdict',
  'reveal',
  'ended',
];

describe('이동 잠금 (I1)', () => {
  it('UI 가 떠서 전원이 멈추는 단계는 vote · verdict · reveal 셋이다', () => {
    expect([...MOVEMENT_LOCKED_PHASES].sort()).toEqual(['reveal', 'verdict', 'vote'].sort());
  });

  it("'ended' 는 잠기지 않는다 — abortRound 로 끝난 판은 reveal 이 안 온다", () => {
    // 그 경우 클라는 결과를 못 받으므로 스스로 풀 근거가 없다. 봇도 같이 풀려야
    // 대칭이 유지된다 (worker 의 봇 루프가 'ended' 를 뺀 것과 짝이다).
    expect(isMovementLocked('ended')).toBe(false);
  });

  it('판이 안 도는 방(idle)은 잠기지 않는다 — 라운지는 그냥 걸어다니는 곳이다', () => {
    expect(isMovementLocked('idle')).toBe(false);
  });

  it('말하는 단계(topic · speak · freechat)에서는 움직일 수 있다', () => {
    for (const p of ['topic', 'speak', 'freechat'] as const) {
      expect(isMovementLocked(p)).toBe(false);
    }
  });
});

describe('최후변론의 이동 — 지목된 한 명만 선다 (I1)', () => {
  it('지목된 자리는 못 움직이고, 나머지는 움직인다', () => {
    // 이게 mayChat 의 **거울상**이다. 말하기는 지목자만 열리고, 움직이기는 지목자만 닫힌다.
    expect(mayMove('defense', true)).toBe(false);
    expect(mayMove('defense', false)).toBe(true);
  });

  it('defense 를 통째로 잠그지 않는다 — 변론 20초가 정지 화면이 되면 안 된다', () => {
    // 예전엔 MOVEMENT_LOCKED_PHASES 에 defense 가 있었다. 비대칭(봇만 얼어붙음)을
    // 막으려던 것이었는데, 사람과 봇이 **같이** 걸으면 그 비대칭은 애초에 안 생긴다.
    expect(MOVEMENT_LOCKED_PHASES).not.toContain('defense');
  });

  it('지목됐다고 다른 잠긴 단계까지 풀리지는 않는다', () => {
    for (const p of MOVEMENT_LOCKED_PHASES) {
      expect(mayMove(p, true)).toBe(false);
      expect(mayMove(p, false)).toBe(false);
    }
  });

  it('잠기지 않은 단계는 지목 여부와 무관하게 움직인다', () => {
    for (const p of ALL_PHASES) {
      if (p === 'defense' || isMovementLocked(p)) continue;
      expect(mayMove(p, true)).toBe(true);
      expect(mayMove(p, false)).toBe(true);
    }
  });
});

describe('발화 잠금 (I1)', () => {
  it('이동이 잠기는 단계에서는 말도 잠긴다', () => {
    // 둘이 갈리면 "못 움직이는데 말은 되는" 구간이 생기고, 거기서 한쪽만
    // 말할 수 있으면 그 발화가 통째로 한 진영 것이 된다.
    for (const p of MOVEMENT_LOCKED_PHASES) expect(isChatLocked(p)).toBe(true);
  });

  it('말 잠금과 이동 잠금이 같아졌다 — defense 는 둘 다에서 빠졌다 (2026-08-06)', () => {
    // 예전엔 defense 만 "말은 지목자에게 열리고 이동은 지목자에게만 닫힌다"라 두 목록이
    // 한 칸 달랐다. 이제 defense 발화가 전원에게 열려서(사람·봇 대칭) 목록에서 통째로
    // 빠졌고, 두 목록이 같아졌다. 한쪽에만 defense 가 남아 있으면 되돌린 흔적이다.
    expect([...CHAT_LOCKED_PHASES].sort()).toEqual([...MOVEMENT_LOCKED_PHASES].sort());
    expect(CHAT_LOCKED_PHASES).not.toContain('defense');
  });

  it('지목되지 않은 좌석은 잠긴 단계에서 아무도 말할 수 없다', () => {
    for (const p of CHAT_LOCKED_PHASES) expect(mayChat(p, false)).toBe(false);
  });

  it('최후변론은 이제 전원이 말한다 — 지목 여부와 무관하게 (I1: 사람·봇 대칭)', () => {
    // 지목된 본인만 열면 "변론한 자 = 봇 / 침묵한 자 = 사람"이 되고, 반대로 사람만
    // 열어도 샌다. defense 를 CHAT_LOCKED 에서 빼 봇도 같이 말하게 했으므로 전원이 열린다.
    expect(mayChat('defense', true)).toBe(true);
    expect(mayChat('defense', false)).toBe(true);
  });

  it('잠긴 단계(vote·verdict·reveal)는 지목돼도 열리지 않는다', () => {
    for (const p of CHAT_LOCKED_PHASES) {
      expect(mayChat(p, true)).toBe(false);
      expect(mayChat(p, false)).toBe(false);
    }
  });

  it('잠기지 않은 단계는 지목 여부와 무관하게 말할 수 있다', () => {
    for (const p of ALL_PHASES) {
      if (isChatLocked(p)) continue;
      expect(mayChat(p, false)).toBe(true);
      expect(mayChat(p, true)).toBe(true);
    }
  });
});

describe('두 목록이 RoundPhase 안에만 있다', () => {
  it('오타로 없는 단계 이름이 섞이면 아무도 잠기지 않는다', () => {
    for (const p of [...MOVEMENT_LOCKED_PHASES, ...CHAT_LOCKED_PHASES]) {
      expect(ALL_PHASES).toContain(p);
    }
  });
});
