/**
 * 라운드테이블 v2 — 단계 전환 · 표 집계 · I1 회귀. 소유: A
 *
 * roundtable.ts 는 lib/mp(constants·protocol 타입)만 import 하는 순수 스텝 함수라
 * node 환경에서 그대로 돈다 (bots.test.ts 와 같은 이유). 한 판이 252초라 브라우저로는
 * 검사할 수 없는 흐름이고, **집계 한 줄이 틀리면 그 버그는 판이 끝나야 드러난다.**
 * 그래서 여기서 시각을 밀어 가며 조각으로 확인한다.
 *
 * ┌─ 이 파일이 지키는 규약 (bots.test.ts 와 같다) ─────────────────────────────┐
 * │ · 시각은 **전부 인자로 주입한다.** Date.now() 를 부르지 않는다 (I2).          │
 * │ · 랜덤은 **rng 를 주입해 고정한다.** 동점 추첨 하나가 누가 처형되는지를        │
 * │   바꾸므로, "이 rng 면 반드시 b" 를 결정적으로 못 박을 수 있어야 한다.        │
 * │   확률 자체를 보고 싶을 때만(분포 검사) 여러 번 돌린다.                       │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

import { describe, expect, it } from 'vitest';

import {
  EMOTION_TOPICS,
  FACT_TOPICS,
  abortRound,
  castVerdict,
  castVote,
  decideWinner,
  eliminatedId,
  haveAllVoted,
  resolveVerdict,
  revealSnapshot,
  roundSnapshot,
  startRound,
  stepRound,
  tallyNomination,
  voteProgress,
  type RoundState,
  type Rng,
} from '../../worker/src/roundtable';
import type { RoundPhase } from '../../lib/mp/protocol';
import {
  ROUND_DEFENSE_MS,
  ROUND_FREECHAT_MS,
  ROUND_REVEAL_MS,
  ROUND_SPEAK_MS,
  ROUND_TOPIC_MS,
  ROUND_TOPIC_ROUNDS,
  ROUND_VERDICT_MS,
  ROUND_VOTE_MS,
} from '../../lib/mp/constants';

/** 4석. a·b 는 사람, c·d 는 봇. **이 배치는 이 파일 안에서만 안다** (I1). */
const SEATS = ['a', 'b', 'c', 'd'];
const HUMANS = ['a', 'b'];

/** 항상 같은 값을 돌려주는 rng. pick() 이 floor(rng()*len) 이라 인덱스가 못 박힌다. */
function rngOf(v: number): Rng {
  return () => v;
}
const FIXED = rngOf(0);

/** 마감까지 시각을 밀어 한 단계 넘긴다. */
function advance(s: RoundState, rng: Rng = FIXED): boolean {
  return stepRound(s, s.phaseEndsAt, rng);
}

/** 원하는 단계까지 굴린다. 못 닿으면 던진다 — 조용히 지나가면 그 뒤 검사가 전부 무의미해진다. */
function runTo(s: RoundState, phase: RoundPhase, rng: Rng = FIXED): RoundState {
  for (let i = 0; i < 40 && s.phase !== phase; i += 1) advance(s, rng);
  if (s.phase !== phase) throw new Error(`${phase} 에 도달하지 못했다 (지금 ${s.phase})`);
  return s;
}

/** 표를 한꺼번에 넣는다. 마감 직전에 넣어 "마지막이 유효" 규칙과 엉키지 않게 한다. */
function castAll(s: RoundState, votes: Record<string, string>): void {
  for (const [voter, target] of Object.entries(votes)) {
    expect(castVote(s, voter, target, s.phaseEndsAt - 1), `${voter}→${target} 가 거절됐다`).toBe(
      true,
    );
  }
}

/* ═══════════════════════════════ 판 열기 ═══════════════════════════════ */

describe('startRound', () => {
  it('좌석이 없으면 판을 열지 않는다', () => {
    expect(startRound([], [], 1_000)).toBeNull();
  });

  it('topic 단계 · 1라운드로 시작한다', () => {
    const s = startRound(SEATS, HUMANS, 1_000, FIXED)!;
    expect(s.phase).toBe('topic');
    expect(s.round).toBe(1);
    expect(s.topic).toBe(s.topics[0]);
    expect(s.phaseEndsAt).toBe(1_000 + ROUND_TOPIC_MS);
    expect(s.spotlightId).toBeNull();
    expect(s.nomineeId).toBeNull();
    expect(s.winner).toBeNull();
    expect(s.done).toBe(false);
  });

  it('주제는 1라운드 사실형 · 2라운드 감정형이고 서로 다르다 (GAMEFLOW-V2 §3-②)', () => {
    for (let i = 0; i < 200; i += 1) {
      const s = startRound(SEATS, HUMANS, 0)!;
      expect(s.topics.length).toBe(ROUND_TOPIC_ROUNDS);
      expect(FACT_TOPICS).toContain(s.topics[0]);
      expect(EMOTION_TOPICS).toContain(s.topics[1]);
      expect(s.topics[0]).not.toBe(s.topics[1]);
    }
  });

  it('주제는 판 시작 때 얼린다 — 라운드 경계에서 다시 뽑지 않는다', () => {
    const s = startRound(SEATS, HUMANS, 0, rngOf(0.99))!;
    const frozen = s.topics.slice();
    runTo(s, 'freechat', rngOf(0)); // 그 사이 rng 를 바꿔도
    expect(s.topics).toEqual(frozen);
  });

  it('humanIds 는 seatIds 로 교집합을 낸다 — 없는 좌석은 버린다', () => {
    const s = startRound(SEATS, ['a', 'zzz'], 0, FIXED)!;
    expect(s.humanIds).toEqual(['a']);
  });

  it('사람이 하나도 없어도 판은 열린다 — 여기서 막으면 그게 관찰 가능한 차이다 (I1)', () => {
    const s = startRound(SEATS, [], 0, FIXED);
    expect(s).not.toBeNull();
    expect(s!.phase).toBe('topic');
  });

  it('seatIds 를 복사해 얼린다 — 호출부 배열이 바뀌어도 분모가 안 흔들린다', () => {
    const live = SEATS.slice();
    const s = startRound(live, HUMANS, 0, FIXED)!;
    live.push('late'); // 판 도중에 누가 들어왔다
    expect(s.seatIds).toEqual(SEATS);
    expect(voteProgress(s).total).toBe(SEATS.length);
  });
});

/* ═══════════════════════════════ 단계 전환 ═══════════════════════════════ */

describe('stepRound — 단계 전환', () => {
  it('마감 전에는 넘어가지 않는다 (I2 — 판정은 오직 phaseEndsAt)', () => {
    const s = startRound(SEATS, HUMANS, 0, FIXED)!;
    expect(stepRound(s, ROUND_TOPIC_MS - 1, FIXED)).toBe(false);
    expect(s.phase).toBe('topic');
  });

  it('topic→speak→topic→speak→freechat→vote→defense→verdict→reveal→ended 순서와 길이', () => {
    const s = startRound(SEATS, HUMANS, 0, FIXED)!;
    // 지목이 나와야 defense·verdict 를 거친다 (사람 표 0장이면 vote→reveal 로 건너뛴다)
    const expected: [RoundPhase, number][] = [
      ['speak', ROUND_SPEAK_MS],
      ['topic', ROUND_TOPIC_MS],
      ['speak', ROUND_SPEAK_MS],
      ['freechat', ROUND_FREECHAT_MS],
      ['vote', ROUND_VOTE_MS],
      ['defense', ROUND_DEFENSE_MS],
      ['verdict', ROUND_VERDICT_MS],
      ['reveal', ROUND_REVEAL_MS],
    ];

    for (const [phase, dur] of expected) {
      if (s.phase === 'vote') castAll(s, { a: 'c', b: 'c' }); // 지목을 만든다
      const before = s.phaseEndsAt;
      expect(advance(s)).toBe(true);
      expect(s.phase, `${phase} 로 넘어가야 한다`).toBe(phase);
      expect(s.phaseEndsAt - before, `${phase} 길이`).toBe(dur);
    }

    // reveal → ended. 여기만 길이가 없다 (done 가드가 막는다)
    expect(advance(s)).toBe(true);
    expect(s.phase).toBe('ended');
    expect(s.done).toBe(true);
    expect(s.spotlightId).toBeNull();

    // 끝난 판은 아무리 시각을 밀어도 안 움직인다
    expect(stepRound(s, s.phaseEndsAt + 1_000_000, FIXED)).toBe(false);
    expect(s.phase).toBe('ended');
  });

  it('한 판의 총 길이는 상수 합과 같다 (252초)', () => {
    const s = startRound(SEATS, HUMANS, 0, FIXED)!;
    while (s.phase !== 'reveal') {
      if (s.phase === 'vote') castAll(s, { a: 'c', b: 'c' });
      advance(s);
    }
    const total =
      ROUND_TOPIC_MS * 2 +
      ROUND_SPEAK_MS * 2 +
      ROUND_FREECHAT_MS +
      ROUND_VOTE_MS +
      ROUND_DEFENSE_MS +
      ROUND_VERDICT_MS;
    expect(s.phaseEndsAt).toBe(total + ROUND_REVEAL_MS);
  });

  it('판 길이는 좌석 수와 무관하다 — v1의 순차 발언을 버린 이유다 (I1)', () => {
    const lengthOf = (seats: string[], humans: string[]) => {
      const s = startRound(seats, humans, 0, FIXED)!;
      while (s.phase !== 'ended') {
        if (s.phase === 'vote') castAll(s, Object.fromEntries(humans.map((h) => [h, seats[0] === h ? seats[1] : seats[0]])));
        advance(s);
      }
      return s.phaseEndsAt;
    };
    const small = lengthOf(['a', 'b', 'c'], ['a', 'b']);
    const big = lengthOf(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    );
    expect(small).toBe(big);
  });

  it('round 는 topic·speak 에서만 오르고 freechat 부터 0 이다', () => {
    const s = startRound(SEATS, HUMANS, 0, FIXED)!;
    expect(s.round).toBe(1);
    advance(s); // speak 1
    expect(s.round).toBe(1);
    advance(s); // topic 2
    expect(s.round).toBe(2);
    expect(s.topic).toBe(s.topics[1]);
    advance(s); // speak 2
    expect(s.round).toBe(2);
    advance(s); // freechat
    expect(s.round).toBe(0);
    expect(s.topic).toBeNull();
  });
});

/*
 * ★ DO 는 evict 됐다가 한참 뒤에 깨어난다. 그때 stepRound 가 여러 경계를 한 번에
 *   건너뛰면 화면은 단계를 **건너뛴 채** 갱신되고, 봇 예약 훅(onPhaseEnter)도 통째로
 *   증발한다 — vote 진입 훅이 안 돌면 봇이 한 표도 안 내고, 그게 곧 봇 명단이다.
 */
describe('stepRound — 한 틱에 한 단계만 (자다 깬 DO)', () => {
  it('아무리 먼 시각을 줘도 한 번에 한 칸이다', () => {
    const s = startRound(SEATS, HUMANS, 0, FIXED)!;
    const woke = 10 * 60_000; // 10분을 자고 깼다

    let steps = 0;
    while (stepRound(s, woke, FIXED)) steps += 1;
    expect(steps).toBe(1);
    expect(s.phase).toBe('speak');
  });

  it('모든 전환이 now 기준으로 새 길이를 준다 — 같은 now 로 다시 부르면 즉시 false', () => {
    const s = startRound(SEATS, HUMANS, 0, FIXED)!;
    const woke = 10 * 60_000;
    for (let i = 0; i < 12; i += 1) {
      const now = woke + i * 1_000_000;
      if (s.phase === 'vote') castAll(s, { a: 'c', b: 'c' });
      if (!stepRound(s, now, FIXED)) break;
      // ended 만 예외다 — 거기는 phaseEndsAt = now 이고 done 플래그가 대신 막는다
      if (s.phase !== 'ended') {
        expect(s.phaseEndsAt, `${s.phase} 는 now 보다 뒤여야 한다`).toBeGreaterThan(now);
      }
      expect(stepRound(s, now, FIXED), `${s.phase} 에서 두 칸 넘어갔다`).toBe(false);
    }
    expect(s.phase).toBe('ended');
  });

  it('길이 0인 전환이 없다 — 지목 없음도 vote→reveal 한 번으로 간다', () => {
    const s = startRound(SEATS, HUMANS, 0, FIXED)!;
    runTo(s, 'vote');
    const at = s.phaseEndsAt;
    expect(stepRound(s, at, FIXED)).toBe(true);
    expect(s.phase).toBe('reveal'); // defense·verdict 를 한 번에 건너뛴다
    expect(s.phaseEndsAt).toBe(at + ROUND_REVEAL_MS);
    expect(stepRound(s, at, FIXED)).toBe(false); // 같은 틱에 또 안 넘어간다
  });
});

/* ═══════════════════════════════ 표 받기 ═══════════════════════════════ */

describe('castVote', () => {
  it('vote 단계가 아니면 거절한다', () => {
    const s = startRound(SEATS, HUMANS, 0, FIXED)!;
    expect(castVote(s, 'a', 'c', 0)).toBe(false);
    runTo(s, 'freechat');
    expect(castVote(s, 'a', 'c', 0)).toBe(false);
    runTo(s, 'vote');
    expect(castVote(s, 'a', 'c', s.phaseEndsAt - 1)).toBe(true);
  });

  it('마감이 지난 표는 거절한다', () => {
    const s = runTo(startRound(SEATS, HUMANS, 0, FIXED)!, 'vote');
    expect(castVote(s, 'a', 'c', s.phaseEndsAt)).toBe(false);
    expect(s.votes).toEqual({});
  });

  it('자기 자신은 못 찍는다 — 봇에게도 같은 규칙이다 (SPEC §18.3 · I1)', () => {
    const s = runTo(startRound(SEATS, HUMANS, 0, FIXED)!, 'vote');
    const t = s.phaseEndsAt - 1;
    expect(castVote(s, 'a', 'a', t), '사람 자기 지목').toBe(false);
    // ★ 봇도 막아야 한다. reveal 의 votes[] 에 자기 자신 투표가 한 건이라도 보이면
    //   그 자리가 봇으로 확정된다 (사람 쪽은 UI 가 막으므로 절대 안 나온다).
    expect(castVote(s, 'c', 'c', t), '봇 자기 지목').toBe(false);
    expect(s.votes).toEqual({});
  });

  it('판 시작 시점 좌석이 아니면 거절한다 — 늦게 들어온 사람의 표가 안 섞인다', () => {
    const s = runTo(startRound(SEATS, HUMANS, 0, FIXED)!, 'vote');
    const t = s.phaseEndsAt - 1;
    expect(castVote(s, 'late', 'a', t)).toBe(false);
    expect(castVote(s, 'a', 'late', t)).toBe(false);
    expect(s.votes).toEqual({});
  });

  it('마감까지 몇 번이든 바꿀 수 있고 마지막이 유효하다', () => {
    const s = runTo(startRound(SEATS, HUMANS, 0, FIXED)!, 'vote');
    const t = s.phaseEndsAt - 1;
    expect(castVote(s, 'a', 'b', t)).toBe(true);
    expect(castVote(s, 'a', 'c', t)).toBe(true);
    expect(castVote(s, 'a', 'd', t)).toBe(true);
    expect(s.votes.a).toBe('d');
    expect(Object.keys(s.votes)).toEqual(['a']);
  });
});

describe('castVerdict', () => {
  /** 지목까지 확정된 verdict 단계 판을 만든다. c(봇)가 지목된다. */
  function atVerdict(): RoundState {
    const s = runTo(startRound(SEATS, HUMANS, 0, FIXED)!, 'vote');
    castAll(s, { a: 'c', b: 'c' });
    advance(s); // → defense
    advance(s); // → verdict
    expect(s.phase).toBe('verdict');
    expect(s.nomineeId).toBe('c');
    return s;
  }

  it('verdict 단계에서만 받는다', () => {
    const s = runTo(startRound(SEATS, HUMANS, 0, FIXED)!, 'vote');
    expect(castVerdict(s, 'a', true, s.phaseEndsAt - 1)).toBe(false);
    const v = atVerdict();
    expect(castVerdict(v, 'a', true, v.phaseEndsAt - 1)).toBe(true);
  });

  it('지목된 본인은 기권이다 — 표가 아예 안 들어간다', () => {
    const s = atVerdict();
    expect(castVerdict(s, 'c', false, s.phaseEndsAt - 1)).toBe(false);
    expect('c' in s.verdicts).toBe(false);
  });

  it('마감 뒤 · 좌석 밖은 거절하고, 마지막 선택이 유효하다', () => {
    const s = atVerdict();
    expect(castVerdict(s, 'a', true, s.phaseEndsAt)).toBe(false);
    expect(castVerdict(s, 'late', true, s.phaseEndsAt - 1)).toBe(false);
    expect(castVerdict(s, 'a', true, s.phaseEndsAt - 1)).toBe(true);
    expect(castVerdict(s, 'a', false, s.phaseEndsAt - 1)).toBe(true);
    expect(s.verdicts.a).toBe(false);
  });
});

/* ═══════════════════════════════ 집계 ═══════════════════════════════ */

describe('tallyNomination — 사람 표만 센다 (SPEC §18.3)', () => {
  it('봇 표는 결과를 바꾸지 못한다', () => {
    // 사람 둘은 a 를 찍었고, 봇 둘이 몰표로 b 를 찍었다 → 그래도 a 다
    const votes = { a: 'x', b: 'x', c: 'y', d: 'y' };
    expect(tallyNomination({ a: 'x', b: 'x' }, HUMANS, FIXED)).toBe('x');
    expect(tallyNomination(votes, HUMANS, FIXED)).toBe('x');
  });

  it('봇만 표를 냈으면 지목이 없다', () => {
    expect(tallyNomination({ c: 'a', d: 'a' }, HUMANS, FIXED)).toBeNull();
  });

  it('표가 하나도 없으면 null', () => {
    expect(tallyNomination({}, HUMANS, FIXED)).toBeNull();
  });

  it('사람이 하나도 없는 판은 언제나 null 이다', () => {
    expect(tallyNomination({ c: 'a', d: 'b' }, [], FIXED)).toBeNull();
  });

  it('단독 최다는 rng 없이 확정된다', () => {
    const boom: Rng = () => {
      throw new Error('단독 최다인데 추첨을 굴렸다');
    };
    expect(tallyNomination({ a: 'c', b: 'c' }, HUMANS, boom)).toBe('c');
  });

  it('동점이면 동점자 중 하나를 뽑는다 — rng 로 결과가 확정된다', () => {
    const votes = { a: 'c', b: 'd' }; // c·d 가 1표씩
    expect(tallyNomination(votes, HUMANS, rngOf(0))).toBe('c'); // 사전순 [c,d] 의 0번
    expect(tallyNomination(votes, HUMANS, rngOf(0.99))).toBe('d');
  });

  it('추첨은 명단/삽입 순서에 의존하지 않는다 — 뒤집어 넣어도 같은 결과 (I1)', () => {
    // votes 의 키 순서는 표가 들어온 순서 = 봇의 예약 시각 분포다. 그게 추첨에 새면 안 된다.
    const forward = tallyNomination({ a: 'd', b: 'c' }, ['a', 'b'], rngOf(0));
    const backward = tallyNomination({ b: 'c', a: 'd' }, ['b', 'a'], rngOf(0));
    expect(forward).toBe('c'); // 사전순 [c,d]
    expect(backward).toBe('c');
  });

  it('3자 동점이면 셋 다 뽑힐 수 있다 — 한쪽으로 굳지 않는다', () => {
    const votes = { a: 'x', b: 'y', e: 'z' };
    const humans = ['a', 'b', 'e'];
    const seen = new Set<string | null>();
    for (let i = 0; i < 300; i += 1) seen.add(tallyNomination(votes, humans));
    expect(seen).toEqual(new Set(['x', 'y', 'z']));
  });
});

describe('resolveVerdict — 찬 과반만 처형, 동수는 생존', () => {
  it('찬이 반보다 많아야 처형이다', () => {
    expect(resolveVerdict({ a: true, b: true }, HUMANS, 'c').executed).toBe(true);
    expect(resolveVerdict({ a: true, b: false }, HUMANS, 'c').executed).toBe(false); // 동수
    expect(resolveVerdict({ a: false, b: false }, HUMANS, 'c').executed).toBe(false);
  });

  it('유효표가 0이면 생존이다', () => {
    const r = resolveVerdict({}, HUMANS, 'c');
    expect(r).toEqual({ executed: false, guilty: 0, innocent: 0 });
  });

  it('봇 표는 세지 않는다', () => {
    // 봇 둘이 찬성해도 사람 표가 동수면 생존이다
    const r = resolveVerdict({ a: true, b: false, c: true, d: true }, HUMANS, 'x');
    expect(r).toEqual({ executed: false, guilty: 1, innocent: 1 });
  });

  it('지목된 본인의 표는 무시한다 — 뒷문으로 들어와도 안 센다', () => {
    // castVerdict 가 막지만, 저장/복구로 되살아난 상태를 집계가 다시 걸러야 한다
    const r = resolveVerdict({ a: true, b: false }, HUMANS, 'b');
    expect(r).toEqual({ executed: true, guilty: 1, innocent: 0 });
  });
});

describe('decideWinner — 승패 매핑 (SPEC §18.4)', () => {
  it('처형했고 그가 AI 면 시민 승', () => {
    expect(decideWinner(true, 'ai')).toBe('citizen');
  });
  it('처형했는데 연기자면 연기자 승', () => {
    expect(decideWinner(true, 'actor')).toBe('actor');
  });
  it('처형했는데 시민이면 AI 승', () => {
    expect(decideWinner(true, 'citizen')).toBe('ai');
  });
  it('처형하지 못했으면 정체와 무관하게 AI 승', () => {
    expect(decideWinner(false, 'ai')).toBe('ai');
    expect(decideWinner(false, 'citizen')).toBe('ai');
    expect(decideWinner(false, 'actor')).toBe('ai');
    expect(decideWinner(true, null)).toBe('ai'); // 지목 없음 방어 — 실제로는 오지 않는 조합
  });
});

describe('연기자 배정 (§18.2) — 수는 0~상한 균등 랜덤, 사람 중에서만', () => {
  it('사람 2명 이하면 연기자가 없다 — 인원표의 상한이 0 이다 (§18.1)', () => {
    const s = startRound(SEATS, HUMANS, 0, rngOf(0.99))!;
    expect(s.actorIds).toEqual([]);
  });

  it('0명인 판이 정상적으로 나온다 — 예외 처리 대상이 아니다', () => {
    const zero = startRound(['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c'], 0, rngOf(0))!;
    expect(zero.actorIds).toEqual([]);
    const one = startRound(['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c'], 0, rngOf(0.99))!;
    expect(one.actorIds.length).toBe(1);
  });

  it('연기자는 언제나 사람 중에서만 나오고 상한을 넘지 않는다', () => {
    for (let i = 0; i < 200; i += 1) {
      const s = startRound(
        ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
        ['a', 'b', 'c', 'd', 'e', 'f'],
        0,
      )!;
      for (const id of s.actorIds) expect(s.humanIds).toContain(id);
      expect(s.actorIds.length).toBeLessThanOrEqual(2); // 사람 6명 → 상한 2 (§18.1)
    }
  });

  it('연기자를 처형하면 연기자 승이고 reveal 에 role 이 실린다 (§18.4)', () => {
    const s = startRound(['a', 'b', 'c', 'd'], ['a', 'b', 'c'], 0, rngOf(0.99))!;
    expect(s.actorIds.length).toBe(1);
    const actor = s.actorIds[0];
    const others = s.humanIds.filter((h) => h !== actor);

    runTo(s, 'vote');
    castAll(s, { [others[0]]: actor, [others[1]]: actor });
    advance(s); // → defense
    advance(s); // → verdict
    castVerdict(s, others[0], true, s.phaseEndsAt - 1);
    castVerdict(s, others[1], true, s.phaseEndsAt - 1);
    advance(s); // → reveal

    expect(s.winner).toBe('actor');
    expect(revealSnapshot(s)!.identities.find((i) => i.id === actor)?.role).toBe('actor');
  });
});

/* ═══════════════════════════════ 판 전체 ═══════════════════════════════ */

/** 지목·생사 표를 넣고 reveal 까지 굴린다. */
function playRound(opts: {
  seats?: string[];
  humans?: string[];
  votes: Record<string, string>;
  verdicts?: Record<string, boolean>;
  rng?: Rng;
}): RoundState {
  const s = startRound(opts.seats ?? SEATS, opts.humans ?? HUMANS, 0, FIXED)!;
  runTo(s, 'vote', opts.rng ?? FIXED);
  for (const [voter, target] of Object.entries(opts.votes)) {
    castVote(s, voter, target, s.phaseEndsAt - 1);
  }
  advance(s, opts.rng ?? FIXED);
  if (s.phase === 'defense') {
    advance(s); // → verdict
    for (const [voter, guilty] of Object.entries(opts.verdicts ?? {})) {
      castVerdict(s, voter, guilty, s.phaseEndsAt - 1);
    }
    advance(s); // → reveal
  }
  expect(s.phase).toBe('reveal');
  return s;
}

describe('판 전체 — 집계가 결말로 이어진다', () => {
  it('봇을 처형하면 시민 승', () => {
    const s = playRound({ votes: { a: 'c', b: 'c' }, verdicts: { a: true, b: true } });
    expect(s.nomineeId).toBe('c');
    expect(s.executed).toBe(true);
    expect(s.winner).toBe('citizen');
    expect(eliminatedId(s)).toBe('c');
  });

  it('사람을 처형하면 AI 승', () => {
    const s = playRound({ votes: { a: 'b', b: 'a' }, verdicts: { a: true, b: true }, rng: rngOf(0) });
    expect(s.nomineeId).toBe('a'); // 동점 [a,b] 의 0번
    expect(s.executed).toBe(true);
    expect(s.winner).toBe('ai');
    expect(eliminatedId(s)).toBe('a');
  });

  it('생사 표가 동수면 생존하고 AI 승이다 — 확신 없이 처형하지 못한다', () => {
    const s = playRound({ votes: { a: 'c', b: 'c' }, verdicts: { a: true, b: false } });
    expect(s.nomineeId).toBe('c');
    expect(s.verdictTally).toEqual({ guilty: 1, innocent: 1 });
    expect(s.executed).toBe(false);
    expect(s.winner).toBe('ai');
    expect(eliminatedId(s)).toBeNull();
  });

  it('생사 표를 아무도 안 내면 생존이다', () => {
    const s = playRound({ votes: { a: 'c', b: 'c' } });
    expect(s.executed).toBe(false);
    expect(s.winner).toBe('ai');
  });

  it('봇 표만 있으면 지목 없이 reveal 로 가고 AI 승이다', () => {
    const s = playRound({ votes: { c: 'a', d: 'a' } });
    expect(s.nomineeId).toBeNull();
    expect(s.executed).toBe(false);
    expect(s.winner).toBe('ai');
    expect(eliminatedId(s)).toBeNull();
    expect(s.verdictTally).toEqual({ guilty: 0, innocent: 0 });
  });

  it('전원 봇인 방도 끝까지 돈다 — 지목 없음 → AI 승', () => {
    const s = playRound({ humans: [], votes: { a: 'b', b: 'a', c: 'a', d: 'a' } });
    expect(s.nomineeId).toBeNull();
    expect(s.winner).toBe('ai');
  });

  it('지목 집계는 한 번만 굴린다 — 다시 밟아도 동점 추첨이 다시 안 굴러간다', () => {
    const s = startRound(SEATS, HUMANS, 0, FIXED)!;
    runTo(s, 'vote');
    castAll(s, { a: 'c', b: 'd' }); // 동점
    advance(s, rngOf(0));
    expect(s.nomineeId).toBe('c');
    expect(s.nominationSettled).toBe(true);

    // rng 를 바꿔 다시 굴려도 이미 확정된 지목은 안 바뀐다
    const before = s.nomineeId;
    advance(s, rngOf(0.99)); // defense → verdict
    advance(s, rngOf(0.99)); // verdict → reveal
    expect(s.nomineeId).toBe(before);
  });
});

/* ═══════════════════════════════ 진행 카운터 ═══════════════════════════════ */

describe('voteProgress — 숫자 둘뿐이다', () => {
  it('voted 는 고유 좌석 수다 — 표를 바꿔도 안 오른다 (변경 행위가 관측되면 안 된다)', () => {
    const s = runTo(startRound(SEATS, HUMANS, 0, FIXED)!, 'vote');
    const t = s.phaseEndsAt - 1;
    castVote(s, 'a', 'c', t);
    expect(voteProgress(s).voted).toBe(1);
    castVote(s, 'a', 'd', t);
    castVote(s, 'a', 'b', t);
    expect(voteProgress(s).voted).toBe(1);
    castVote(s, 'b', 'c', t);
    expect(voteProgress(s).voted).toBe(2);
  });

  it('total 은 **전 좌석 수**다 — 사람 좌석 수로 두면 빼기로 봇 수가 나온다 (I1)', () => {
    const s = runTo(startRound(SEATS, HUMANS, 0, FIXED)!, 'vote');
    expect(voteProgress(s).total).toBe(SEATS.length);
    expect(voteProgress(s).total).not.toBe(HUMANS.length);
  });

  it('total 은 정체 배치와 무관하다 (I1)', () => {
    const many = startRound(SEATS, HUMANS, 0, FIXED)!;
    const few = startRound(SEATS, ['a'], 0, FIXED)!;
    expect(voteProgress(many).total).toBe(voteProgress(few).total);
  });

  it('verdict 단계에서는 생사 표를 센다', () => {
    const s = runTo(startRound(SEATS, HUMANS, 0, FIXED)!, 'vote');
    castAll(s, { a: 'c', b: 'c', d: 'c' });
    advance(s); // defense — 아직 지목 표를 센다
    expect(voteProgress(s).voted).toBe(3);
    advance(s); // verdict — 여기서부터 생사 표
    expect(voteProgress(s).voted).toBe(0);
    castVerdict(s, 'a', true, s.phaseEndsAt - 1);
    expect(voteProgress(s)).toEqual({ voted: 1, total: SEATS.length });
  });
});

describe('haveAllVoted — vote 조기 종료 (I5)', () => {
  it('빈 목록이면 false — 아무도 없는 방에서 판이 순간이동하지 않는다', () => {
    const s = runTo(startRound(SEATS, HUMANS, 0, FIXED)!, 'vote');
    expect(haveAllVoted(s, [])).toBe(false);
  });

  it('넘긴 좌석이 전부 냈을 때만 true', () => {
    const s = runTo(startRound(SEATS, HUMANS, 0, FIXED)!, 'vote');
    const t = s.phaseEndsAt - 1;
    expect(haveAllVoted(s, HUMANS)).toBe(false);
    castVote(s, 'a', 'c', t);
    expect(haveAllVoted(s, HUMANS)).toBe(false);
    castVote(s, 'b', 'c', t);
    expect(haveAllVoted(s, HUMANS)).toBe(true);
    // 끊긴 사람을 넣으면 영영 참이 안 된다 — 호출부가 접속 중인 좌석만 넘겨야 하는 이유
    expect(haveAllVoted(s, [...HUMANS, 'd'])).toBe(false);
  });
});

/* ═══════════════════════════════ I1 회귀 ═══════════════════════════════ */

/**
 * ┌─ 이 블록이 지키는 것 ──────────────────────────────────────────────────────┐
 * │ **reveal 이전에 나가는 어떤 값에도 봇을 특정할 정보가 없다.**                 │
 * │ v1 은 "워커가 정체를 몰라서" 구조적으로 안 샜다. v2 는 알면서 안 내보내는     │
 * │ 것이라 규율로만 지켜진다 — 그 규율을 검사로 못 박는 자리가 여기다.            │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
describe('I1 — reveal 이전에는 정체가 새지 않는다', () => {
  it('roundSnapshot 의 필드는 정확히 이 일곱 개다 — 늘어나면 여기서 걸린다', () => {
    const s = startRound(SEATS, HUMANS, 0, FIXED)!;
    expect(Object.keys(roundSnapshot(s)).sort()).toEqual(
      ['endsAt', 'nomineeId', 'phase', 'round', 'spotlightId', 'topic', 'totalRounds'].sort(),
    );
  });

  it('스냅샷 어디에도 is_bot 성 값이 없다 — 좌석 명단조차 안 나간다', () => {
    const s = runTo(startRound(SEATS, HUMANS, 0, FIXED)!, 'vote');
    const json = JSON.stringify(roundSnapshot(s));
    expect(json).not.toMatch(/isBot|is_bot|human|identit|seatIds/i);
    // humanIds 배열이 통째로 실려 나가는 사고를 문자열로도 막는다
    expect(json).not.toContain('"a"');
    expect(json).not.toContain('"b"');
  });

  it('spotlightId 는 defense 에서만 나간다', () => {
    const s = startRound(SEATS, HUMANS, 0, FIXED)!;
    runTo(s, 'vote');
    castAll(s, { a: 'c', b: 'c' });
    for (;;) {
      const snap = roundSnapshot(s);
      if (snap.phase === 'defense') expect(snap.spotlightId).toBe('c');
      else expect(snap.spotlightId, `${snap.phase} 에서 조명이 켜졌다`).toBeNull();
      if (!advance(s)) break;
    }
  });

  it('nomineeId 는 defense 이전에는 절대 안 나간다 — 결과가 미리 새면 안 된다', () => {
    const s = startRound(SEATS, HUMANS, 0, FIXED)!;
    runTo(s, 'vote');
    castAll(s, { a: 'c', b: 'c' });
    // vote 단계에서 이미 상태에는 표가 있지만 스냅샷에는 나가면 안 된다
    expect(roundSnapshot(s).nomineeId).toBeNull();

    const seen: (string | null)[] = [];
    const phases: RoundPhase[] = [];
    for (;;) {
      seen.push(roundSnapshot(s).nomineeId);
      phases.push(s.phase);
      if (!advance(s)) break;
    }
    for (let i = 0; i < phases.length; i += 1) {
      const after = ['defense', 'verdict', 'reveal', 'ended'].includes(phases[i]);
      if (after) expect(seen[i], `${phases[i]}`).toBe('c');
      else expect(seen[i], `${phases[i]} 에서 지목이 샜다`).toBeNull();
    }
  });

  it('revealSnapshot 은 reveal 전에는 null 이다 — 판 중간 입장자에게 새는 경로를 막는다', () => {
    const s = startRound(SEATS, HUMANS, 0, FIXED)!;
    runTo(s, 'vote');
    castAll(s, { a: 'c', b: 'c' });
    while (s.phase !== 'reveal') {
      expect(revealSnapshot(s), `${s.phase} 에서 정체가 나왔다`).toBeNull();
      advance(s);
    }
    expect(revealSnapshot(s)).not.toBeNull();
  });

  it('중도 종료(abortRound)한 판은 정체를 내주지 않는다', () => {
    const s = runTo(startRound(SEATS, HUMANS, 0, FIXED)!, 'freechat');
    abortRound(s, 999_999);
    expect(s.phase).toBe('ended');
    expect(s.done).toBe(true);
    expect(revealSnapshot(s), '판정 없이 끝난 판이 정체를 공개했다').toBeNull();
    expect(roundSnapshot(s).spotlightId).toBeNull();
    expect(roundSnapshot(s).topic).toBeNull();
  });

  /*
   * 판정 **전**이라면 어느 단계에서 끊겨도 정체는 안 나가야 한다. DO 가 오래 잠들었다
   * 깨어나는 시점은 고를 수 없으므로 단계별로 전부 확인한다.
   */
  it.each(['topic', 'speak', 'freechat', 'vote', 'defense', 'verdict'] as const)(
    '%s 에서 끊겨도 정체가 안 나간다',
    (phase) => {
      const s = startRound(SEATS, HUMANS, 0, FIXED)!;
      // ★ runTo 로 건너뛰지 않는다. vote 를 지나야 지목이 생기고, vote 에 표가 없으면
      //   defense·verdict 자체가 없는 판이 된다 — 그 두 케이스를 놓치게 된다.
      for (let i = 0; i < 40 && s.phase !== phase; i += 1) {
        if (s.phase === 'vote') castAll(s, { a: 'c', b: 'c' });
        advance(s);
      }
      expect(s.phase, `${phase} 에 도달하지 못했다`).toBe(phase);
      abortRound(s, 999_999);
      expect(revealSnapshot(s)).toBeNull();
      expect(s.done).toBe(true);
      expect(stepRound(s, 9_999_999, FIXED), '끝난 판이 되살아났다').toBe(false);
    },
  );

  it('eliminatedId 는 좌석 id 뿐이다 — 쓰러지는 것과 정체는 별개다', () => {
    const bot = playRound({ votes: { a: 'c', b: 'c' }, verdicts: { a: true, b: true } });
    const human = playRound({ votes: { a: 'b', b: 'a' }, verdicts: { a: true, b: true }, rng: rngOf(0) });
    expect(typeof eliminatedId(bot)).toBe('string');
    expect(typeof eliminatedId(human)).toBe('string');
    // 값의 **모양**이 같아야 한다. 봇일 때만 뭔가 더 붙으면 그게 답이 된다.
    expect(eliminatedId(bot)).toBe('c');
    expect(eliminatedId(human)).toBe('a');
  });

  /**
   * ★ 가장 중요한 회귀다. **정체 배치만 다르고 나머지가 같은 두 판**을 vote 마감까지
   *   나란히 굴려, 밖으로 나가는 값(roundSnapshot · voteProgress)이 **한 글자도** 다르지
   *   않은지 본다. 어디선가 is_bot 이 타이밍·순서·카운트로 새면 여기서 갈라진다.
   */
  it('정체 배치를 뒤집어도 vote 마감 전까지 나가는 값이 완전히 같다', () => {
    const A = startRound(SEATS, ['a', 'b'], 0, FIXED)!; // c·d 가 봇
    const B = startRound(SEATS, ['c', 'd'], 0, FIXED)!; // a·b 가 봇

    const trace = (s: RoundState) => {
      const out: unknown[] = [];
      while (s.phase !== 'vote') {
        out.push([roundSnapshot(s), voteProgress(s)]);
        advance(s);
      }
      out.push([roundSnapshot(s), voteProgress(s)]);
      // 전 좌석이 같은 순서로 표를 낸다 — 카운터가 정체와 무관함을 본다
      for (const id of SEATS) {
        castVote(s, id, id === 'a' ? 'b' : 'a', s.phaseEndsAt - 1);
        out.push([roundSnapshot(s), voteProgress(s)]);
      }
      return JSON.stringify(out);
    };

    expect(trace(A)).toBe(trace(B));
  });

  it('단계 길이는 지목된 자리의 정체와 무관하다 — defense 는 누구든 20초다 (§5.3)', () => {
    const lengths = (votes: Record<string, string>, rng: Rng) => {
      const s = startRound(SEATS, HUMANS, 0, FIXED)!;
      runTo(s, 'vote');
      for (const [v, t] of Object.entries(votes)) castVote(s, v, t, s.phaseEndsAt - 1);
      const out: [RoundPhase, number][] = [];
      let prev = s.phaseEndsAt;
      while (advance(s, rng)) {
        out.push([s.phase, s.phaseEndsAt - prev]);
        prev = s.phaseEndsAt;
      }
      return out;
    };
    // c 는 봇, b 는 사람 — 지목 대상만 다르다
    expect(lengths({ a: 'c', b: 'c' }, FIXED)).toEqual(lengths({ a: 'b' }, FIXED));
  });
});

/*
 * ★ room-do 는 단계 전환 때마다 RoundState 를 통째로 ctx.storage 에 굽는다. 봇이 0기인
 *   방은 틱 타이머가 없어서 투표 중에 DO 가 hibernate 할 수 있고, 그때 인스턴스 필드는
 *   통째로 날아간다. Map/Set 이 하나라도 섞이면 그 순간 표가 **조용히** 사라진다 —
 *   구조화 복제는 던지지 않고 그냥 못 담는 것을 빼먹는 게 아니라, Map 은 담기지만
 *   JSON 경계를 타면 {} 이 된다. 여기서 못 박는다.
 */
describe('저장·복구 — RoundState 는 통째로 구울 수 있어야 한다', () => {
  it('복제해도 표와 진행이 살아남고, 이어서 굴리면 같은 결말이 난다', () => {
    const s = runTo(startRound(SEATS, HUMANS, 0, FIXED)!, 'vote');
    castAll(s, { a: 'c', b: 'c', d: 'a' });

    const revived: RoundState = structuredClone(s);
    expect(revived).toEqual(s);
    // JSON 경계도 같이 본다 — Map/Set 은 여기서 {} 로 뭉개진다
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);

    for (const r of [s, revived]) {
      advance(r); // → defense
      advance(r); // → verdict
      castVerdict(r, 'a', true, r.phaseEndsAt - 1);
      castVerdict(r, 'b', true, r.phaseEndsAt - 1);
      advance(r); // → reveal
    }
    expect(revealSnapshot(revived)).toEqual(revealSnapshot(s));
    expect(revealSnapshot(revived)!.winner).toBe('citizen');
  });
});

/* ═══════════════════════════════ reveal (I1 의 예외) ═══════════════════════════════ */

describe('revealSnapshot — 정체를 내보내는 유일한 함수', () => {
  it('identities 는 전 좌석을 좌석 순서 그대로 담는다 — 봇을 몰아 담으면 순서가 답이 된다', () => {
    const s = playRound({ votes: { a: 'c', b: 'c' }, verdicts: { a: true, b: true } });
    const r = revealSnapshot(s)!;
    expect(r.identities.map((i) => i.id)).toEqual(SEATS);
    // 사람 2명 방은 연기자 상한이 0 (§18.1) — 사람은 전부 시민이다
    expect(r.identities).toEqual([
      { id: 'a', isBot: false, role: 'citizen' },
      { id: 'b', isBot: false, role: 'citizen' },
      { id: 'c', isBot: true, role: 'ai' },
      { id: 'd', isBot: true, role: 'ai' },
    ]);
  });

  it('votes 도 좌석 순서다 — 표가 들어온 순서는 봇의 예약 시각 분포다', () => {
    const s = startRound(SEATS, HUMANS, 0, FIXED)!;
    runTo(s, 'vote');
    const t = s.phaseEndsAt - 1;
    // 봇이 먼저, 사람이 나중에 냈다
    castVote(s, 'd', 'a', t);
    castVote(s, 'c', 'a', t);
    castVote(s, 'b', 'c', t);
    castVote(s, 'a', 'c', t);
    advance(s); // → defense
    advance(s); // → verdict
    advance(s); // → reveal

    const r = revealSnapshot(s)!;
    expect(r.votes.map((v) => v.voterId)).toEqual(SEATS);
    expect(r.votes).toEqual([
      { voterId: 'a', targetId: 'c' },
      { voterId: 'b', targetId: 'c' },
      { voterId: 'c', targetId: 'a' },
      { voterId: 'd', targetId: 'a' },
    ]);
  });

  it('표를 안 낸 좌석은 votes 에 없다', () => {
    const s = playRound({ votes: { a: 'c', b: 'c' }, verdicts: { a: true, b: true } });
    const r = revealSnapshot(s)!;
    expect(r.votes.map((v) => v.voterId)).toEqual(['a', 'b']);
  });

  it('결말 전부를 담는다', () => {
    const s = playRound({ votes: { a: 'c', b: 'c' }, verdicts: { a: true, b: true, d: false } });
    expect(revealSnapshot(s)).toEqual({
      nomineeId: 'c',
      executed: true,
      winner: 'citizen',
      verdict: { guilty: 2, innocent: 0 }, // 봇(d)의 반대표는 안 센다
      votes: [
        { voterId: 'a', targetId: 'c' },
        { voterId: 'b', targetId: 'c' },
      ],
      identities: [
        { id: 'a', isBot: false, role: 'citizen' },
        { id: 'b', isBot: false, role: 'citizen' },
        { id: 'c', isBot: true, role: 'ai' },
        { id: 'd', isBot: true, role: 'ai' },
      ],
    });
  });

  it('지목이 없던 판도 정체는 공개한다 — 판은 끝났다', () => {
    const s = playRound({ votes: { c: 'a', d: 'a' } });
    const r = revealSnapshot(s)!;
    expect(r.nomineeId).toBeNull();
    expect(r.executed).toBe(false);
    expect(r.winner).toBe('ai');
    expect(r.identities.length).toBe(SEATS.length);
  });

  it('ended 로 넘어가도 같은 값을 낸다 — 늦게 붙은 사람이 결과를 못 보면 안 된다', () => {
    const s = playRound({ votes: { a: 'c', b: 'c' }, verdicts: { a: true, b: true } });
    const atReveal = revealSnapshot(s);
    advance(s);
    expect(s.phase).toBe('ended');
    expect(revealSnapshot(s)).toEqual(atReveal);
  });
});
