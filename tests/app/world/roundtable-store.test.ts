/**
 * 라운드테이블 화면 상태 — **판 하나가 흘러가는 동안 무엇이 남고 무엇이 걷히는가.**
 *
 * ┌─ 왜 이 파일이 생겼나 (2026-08-07) ────────────────────────────────────────┐
 * │ 머리말의 「내 역할 · 시민」 한 줄이 **두 번째 주제가 뜨는 순간 사라졌다.**   │
 * │ 한 판에 topic 은 두 번 오는데(ROUND_TOPIC_ROUNDS = 2) 「한 판 더」 감지를    │
 * │ `s.phase !== 'idle'` 로 해서, topic② 가 rematch 로 오인돼 myRole 을 걷었다. │
 * │ 새 역할은 판이 열릴 때 한 번만 오므로(room-do 의 sendRoles) 그 뒤로 라벨도   │
 * │ 카드도 영영 안 돌아온다.                                                   │
 * │                                                                          │
 * │ 타입도 린트도 안 잡는 종류다 — 값이 조용히 null 이 될 뿐이라 화면을 4분     │
 * │ 띄워 놓고 봐야 보인다. 그래서 단계 전이를 여기서 직접 굴린다.               │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { RoundInfo } from '@/app/world/net/connection';
import { roleCardOpen, useRoundtableStore } from '@/app/world/roundtable-store';
import type { RoundPhase } from '@/lib/mp/protocol';

/** 서버 t:'round' 한 건. 이 검사가 보는 건 phase 뿐이라 나머지는 기본값으로 채운다. */
function round(phase: RoundPhase, over: Partial<RoundInfo> = {}): RoundInfo {
  return {
    phase,
    spotlightId: null,
    topic: phase === 'topic' || phase === 'speak' ? '주제' : null,
    endsAt: 0,
    round: phase === 'topic' || phase === 'speak' ? 1 : 0,
    totalRounds: 2,
    nomineeId: null,
    revote: 0,
    ...over,
  };
}

const store = () => useRoundtableStore.getState();

/** 역할을 받고 「확인」까지 누른 상태 — 머리말 라벨이 떠 있는 지점이다. */
function ackedRole(): void {
  store().setMyRole('citizen');
  store().ackRole();
}

beforeEach(() => {
  store().reset();
});

describe('내 역할 라벨 — 판이 도는 내내 남는다', () => {
  it('두 번째 주제가 떠도 역할이 걷히지 않는다 (2026-08-07 회귀)', () => {
    // 게이트가 열리며 역할이 먼저 온다 (카드 선공개) → 확인 → 판 시작
    ackedRole();
    store().applyRound(round('topic', { round: 1 }));
    store().applyRound(round('speak', { round: 1 }));

    // ★ 여기가 터졌던 자리다. topic② 는 「한 판 더」가 아니다.
    store().applyRound(round('topic', { round: 2 }));

    expect(store().myRole).toBe('citizen');
    expect(store().roleAck).toBe(true);
    // 라벨이 살아 있으면 카드는 다시 뜨지 않는다 — 둘은 한 셀렉터로 묶여 있다.
    expect(roleCardOpen(store())).toBe(false);
  });

  it('판 전체(topic→…→reveal)를 굴려도 한 번도 안 걷힌다', () => {
    ackedRole();
    const flow: RoundPhase[] = [
      'topic',
      'speak',
      'topic',
      'speak',
      'freechat',
      'vote',
      'defense',
      'verdict',
      'reveal',
    ];
    for (const p of flow) {
      store().applyRound(round(p));
      expect(store().myRole).toBe('citizen');
      expect(store().roleAck).toBe(true);
    }
  });

  it('부결로 vote 로 되돌아가도 남는다 — 재투표는 새 판이 아니다', () => {
    ackedRole();
    store().applyRound(round('verdict'));
    store().applyRound(round('vote', { revote: 1 }));

    expect(store().myRole).toBe('citizen');
    expect(store().roleAck).toBe(true);
  });
});

describe('「한 판 더」에서만 걷는다', () => {
  it('reveal 뒤에 온 topic 은 새 판이다 — 역할을 걷고 카드부터 다시 본다', () => {
    ackedRole();
    store().applyRound(round('reveal'));
    store().applyRound(round('topic', { round: 1 }));

    expect(store().myRole).toBeNull();
    expect(store().roleAck).toBe(false);
  });

  it('ended 뒤에 온 topic 도 새 판이다 (abortRound 로 끝난 판)', () => {
    ackedRole();
    store().applyRound(round('ended'));
    store().applyRound(round('topic', { round: 1 }));

    expect(store().myRole).toBeNull();
  });

  it('idle 에서 온 첫 topic 은 안 걷는다 — 역할은 게이트에서 먼저 왔다', () => {
    ackedRole();
    store().applyRound(round('topic', { round: 1 }));

    expect(store().myRole).toBe('citizen');
    // 방금 확인한 카드가 판이 열리는 순간 한 번 더 뜨면 안 된다.
    expect(roleCardOpen(store())).toBe(false);
  });
});
