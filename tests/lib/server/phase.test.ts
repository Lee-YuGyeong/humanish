/**
 * 페이즈 상태머신의 순수 부분. 소유: A (SPEC §5.1, §5.3, I5)
 *
 * 여기 있는 세 개(전환표·지속시간·조기종료표)는 게임 진행의 뼈대다. 하나라도 어긋나면
 * 판이 엉뚱한 데서 끝나거나 영영 안 끝난다. 그런데 셋 다 순수한 표라서 DB 없이 검사된다.
 *
 * 전환이 **실제로 일어나는지**(잠금·낙관적 잠금·진입 훅)는 여기서 안 본다.
 * 그건 Postgres 함수 안의 일이라 ./supabase/test.sh가 진짜 DB에 대고 검사한다.
 */
import { describe, expect, it } from 'vitest';
import { EARLY_EXIT, PHASE_DURATION_MS, nextPhase } from '@/lib/server/phase';
import type { Phase } from '@/lib/game/types';

/** SPEC §3의 Phase 전부. 표에 빠진 페이즈가 없는지 보는 기준이기도 하다. */
const ALL_PHASES: Phase[] = [
  'lobby',
  'question',
  'target',
  'chat',
  'vote',
  'reveal',
  'replay',
];

describe('nextPhase — SPEC §5.1 전환표', () => {
  // [지금 페이즈, 지금 라운드] → [다음 페이즈, 다음 라운드]
  const table: [Phase, number, Phase, number][] = [
    ['lobby', 0, 'question', 1],
    ['question', 1, 'question', 2], // 공통 질문은 두 번이다
    ['question', 2, 'target', 2],
    ['target', 2, 'chat', 2],
    ['chat', 2, 'vote', 2],
    ['vote', 2, 'reveal', 2],
    ['reveal', 2, 'replay', 2],
  ];

  it.each(table)('%s(라운드 %i) → %s(라운드 %i)', (phase, round, wantPhase, wantRound) => {
    expect(nextPhase(phase, round)).toEqual({ phase: wantPhase, round: wantRound });
  });

  it('replay는 갈 곳이 없다 (SPEC §15-5 미결정)', () => {
    // 여기서 다른 페이즈를 내놓기 시작하면 §15-5가 정해졌다는 뜻이다.
    // 그때는 이 테스트가 아니라 SPEC부터 고친다.
    expect(nextPhase('replay', 2)).toEqual({ phase: 'replay', round: 2 });
  });

  it('라운드는 2를 넘지 않는다 (rooms.round check 제약)', () => {
    // DB가 round between 0 and 2로 막고 있다. 표가 3을 내놓으면 전환이 통째로 실패한다.
    for (const [phase, round] of ALL_PHASES.flatMap(
      (p) => [0, 1, 2].map((r) => [p, r] as [Phase, number]),
    )) {
      expect(nextPhase(phase, round).round).toBeLessThanOrEqual(2);
    }
  });

  it('lobby에서 시작하면 항상 라운드 1이다', () => {
    // 라운드가 0으로 남으면 on_enter_phase가 round=0짜리 질문을 만들고
    // 화면은 round=1의 질문을 찾아서 "질문을 기다리는 중…"에 멈춘다.
    expect(nextPhase('lobby', 0).round).toBe(1);
  });
});

describe('PHASE_DURATION_MS — SPEC §5.1', () => {
  it('사람이 넘기는 페이즈는 시간이 없다', () => {
    // null이면 advance_phase가 actor(방장/참가자)를 요구한다. 숫자가 들어가면
    // 대기실이 저절로 시작돼 버린다.
    expect(PHASE_DURATION_MS.lobby).toBeNull();
    expect(PHASE_DURATION_MS.reveal).toBeNull();
    expect(PHASE_DURATION_MS.replay).toBeNull();
  });

  it('시간이 있는 페이즈의 길이', () => {
    expect(PHASE_DURATION_MS.question).toBe(60_000);
    expect(PHASE_DURATION_MS.target).toBe(30_000);
    expect(PHASE_DURATION_MS.chat).toBe(120_000);
    expect(PHASE_DURATION_MS.vote).toBe(30_000);
  });

  it('target은 question보다 짧다 (SPEC §5.3)', () => {
    // 한 사람만 답하는데 60초를 주면 나머지는 그동안 할 일이 없다.
    // 답을 뜯어보는 시간은 바로 뒤 chat이 맡는다.
    expect(PHASE_DURATION_MS.target!).toBeLessThan(PHASE_DURATION_MS.question!);
    expect(PHASE_DURATION_MS.chat!).toBeGreaterThan(PHASE_DURATION_MS.target!);
  });

  it('모든 페이즈가 표에 있다', () => {
    // 페이즈를 새로 만들고 표를 안 채우면 undefined가 되고,
    // phase_duration()이 null과 구분되지 않아 그 페이즈가 영영 안 끝난다.
    expect(Object.keys(PHASE_DURATION_MS).sort()).toEqual([...ALL_PHASES].sort());
  });
});

describe('EARLY_EXIT — 조기 종료 조건 (I5, SPEC §5.3)', () => {
  it('question·vote는 사람 전원이 마치면 넘어간다', () => {
    expect(EARLY_EXIT.question).toBe('all-humans');
    expect(EARLY_EXIT.vote).toBe('all-humans');
  });

  it('★ target에는 조기 종료가 없다 — 대상이 누구든 30초를 채운다', () => {
    // 이 저장소에서 제일 미끄러운 자리다. 여기가 'all-humans'면 봇이 대상일 때
    // 페이즈가 0초에 끝나 대상이 봇임이 드러난다 (on_enter_phase가 즉시 답을 넣으므로).
    //
    // 그렇다고 'human-target-only'(대상이 사람일 때만 조기 종료)도 답이 아니다 —
    // 그건 **누수의 방향만 뒤집는다.** 봇이면 항상 30초, 사람이면 즉시 종료가 되어
    // "빨리 넘어갔다 = 대상은 사람"이 확정된다. 한때 실제로 그 상태였다.
    //
    // 대칭을 만드는 방법은 하나뿐이다: 양쪽 다 시간을 채운다 (I1, SPEC §5.3).
    expect(EARLY_EXIT.target).toBe('none');
  });

  it('chat은 시간 만료로만 끝난다', () => {
    // 자유 채팅에 "전원 완료"라는 게 없다. all-humans로 두면 아무도 말을 안 한
    // 순간을 완료로 볼 위험이 있다.
    expect(EARLY_EXIT.chat).toBe('none');
  });

  it('사람이 넘기는 페이즈에는 조기 종료가 없다', () => {
    expect(EARLY_EXIT.lobby).toBe('none');
    expect(EARLY_EXIT.reveal).toBe('none');
    expect(EARLY_EXIT.replay).toBe('none');
  });

  it('모든 페이즈가 표에 있다', () => {
    expect(Object.keys(EARLY_EXIT).sort()).toEqual([...ALL_PHASES].sort());
  });

  it('조기 종료가 있는 페이즈는 question·vote 둘뿐이다', () => {
    // 새 페이즈에 조기 종료를 붙일 때는 "봇만 만족시킬 수 있는 조건인가"를 먼저 묻는다.
    // 봇은 진입 즉시 답변·투표가 생기므로, 그런 조건은 전부 봇을 드러낸다 (I1, I5).
    const withExit = Object.entries(EARLY_EXIT)
      .filter(([, v]) => v !== 'none')
      .map(([p]) => p)
      .sort();
    expect(withExit).toEqual(['question', 'vote']);
  });

  it('시간이 없는 페이즈는 조기 종료도 없다', () => {
    // 시간도 없고 조건도 없으면 사람만이 넘길 수 있다 — 그게 lobby·reveal·replay다.
    // 한쪽만 바꾸면 "아무도 못 넘기는 페이즈"나 "저절로 넘어가는 대기실"이 된다.
    for (const p of ALL_PHASES) {
      if (PHASE_DURATION_MS[p] === null) expect(EARLY_EXIT[p]).toBe('none');
    }
  });
});
