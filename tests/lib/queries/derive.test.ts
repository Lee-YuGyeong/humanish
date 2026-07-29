/**
 * 표시 규칙 (lib/queries/derive.ts).
 *
 * 이 화면에서 제일 헷갈리는 규칙이 "지금 질문의 답이 아니라 **가장 최근에 공개된**
 * 질문의 답을 띄운다"인데, 예전에는 refresh() 안에 있어서 화면을 띄우고 페이즈를
 * 넘겨봐야만 확인할 수 있었다.
 */

import { describe, expect, it } from 'vitest';

import type { AnswerRow } from '@/lib/api/db';
import { currentQuestion, nicknameOf, revealedAnswers } from '@/lib/queries/derive';
import type { Question } from '@/lib/game/types';

const ROOM = 'r1';

function q(id: string, kind: 'common' | 'target', round: number): Question {
  return {
    id,
    room_id: ROOM,
    round,
    kind,
    text: `${id} 질문`,
    asked_by: null,
    target_id: null,
  };
}

function a(id: string, questionId: string, playerId = 'p1'): AnswerRow {
  return { id, question_id: questionId, player_id: playerId, text: `${id} 답` };
}

const COMMON_1 = q('c1', 'common', 1);
const COMMON_2 = q('c2', 'common', 2);
const TARGET_1 = q('t1', 'target', 2);
const TARGET_2 = q('t2', 'target', 2);

describe('currentQuestion', () => {
  it('question 페이즈에서는 그 라운드의 공통 질문을 고른다', () => {
    const all = [COMMON_1, COMMON_2];
    expect(currentQuestion(all, 'question', 1)?.id).toBe('c1');
    expect(currentQuestion(all, 'question', 2)?.id).toBe('c2');
  });

  it('target 페이즈에서는 지목 질문 중 마지막을 고른다', () => {
    // 한 판에 지목이 여러 번 올 수 있다. 라운드로는 갈리지 않으므로 순서로 잡는다.
    expect(currentQuestion([COMMON_1, TARGET_1, TARGET_2], 'target', 2)?.id).toBe('t2');
  });

  it('없으면 null 이다 — 질문이 아직 안 만들어진 순간이 있다', () => {
    expect(currentQuestion([], 'question', 1)).toBeNull();
    expect(currentQuestion([COMMON_1], 'target', 1)).toBeNull();
  });
});

describe('revealedAnswers', () => {
  it('공개된 답이 없으면 비어 있다', () => {
    const got = revealedAnswers([COMMON_1, COMMON_2], []);
    expect(got.question).toBeNull();
    expect(got.answers).toEqual([]);
  });

  it('★ 라운드2를 푸는 동안 라운드1의 답이 남아 있다', () => {
    // 답은 페이즈가 끝나야 열리는데, 열리는 순간이 곧 다음 질문으로 넘어가는
    // 순간이다. "지금 질문의 답"만 그리면 한 판 내내 아무것도 안 뜬다.
    const got = revealedAnswers([COMMON_1, COMMON_2], [a('a1', 'c1'), a('a2', 'c1', 'p2')]);
    expect(got.question?.id).toBe('c1');
    expect(got.answers.map((x) => x.id)).toEqual(['a1', 'a2']);
  });

  it('둘 다 열렸으면 나중 것을 고른다', () => {
    const got = revealedAnswers([COMMON_1, COMMON_2], [a('a1', 'c1'), a('a2', 'c2')]);
    expect(got.question?.id).toBe('c2');
    expect(got.answers.map((x) => x.id)).toEqual(['a2']);
  });

  it('지목 질문은 항상 공통보다 뒤다 (SPEC §5.1)', () => {
    // target 의 round 는 2라서 round 만으로 정렬하면 c2 와 동률이 된다.
    const got = revealedAnswers([COMMON_1, COMMON_2, TARGET_1], [a('a2', 'c2'), a('a3', 't1')]);
    expect(got.question?.id).toBe('t1');
  });

  it('질문 목록에 없는 답은 무시한다', () => {
    // 방을 옮기는 중이거나 질문 쿼리가 아직 안 온 순간에 실제로 생긴다.
    const got = revealedAnswers([COMMON_1], [a('a9', '없는질문')]);
    expect(got.question).toBeNull();
    expect(got.answers).toEqual([]);
  });
});

describe('nicknameOf', () => {
  const players = [
    { id: 'p1', nickname: '익명1' },
    { id: 'p2', nickname: '익명2' },
  ];

  it('이름을 찾는다', () => {
    expect(nicknameOf(players, 'p2')).toBe('익명2');
  });

  it('없으면 ? 다 — 나간 사람의 표를 그릴 때 걸린다', () => {
    expect(nicknameOf(players, 'p9')).toBe('?');
  });
});
