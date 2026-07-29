/**
 * 서버에서 온 값을 화면이 쓰는 모양으로 바꾸는 **순수 함수**. 소유: A
 *
 * 쿼리 훅 안에 두지 않는 이유: 여기 있는 규칙이 이 화면에서 제일 헷갈리는
 * 부분인데, 훅 안에 있으면 렌더 트리를 세우지 않고는 검사할 수 없다.
 * 밖으로 빼면 `npm test` 에서 배열만 넣어 확인할 수 있다 (tests/lib/queries/).
 *
 * DB·네트워크·Date.now() 를 쓰지 않는다. lib/game/ 의 규칙과 같은 성격이지만,
 * 게임 규칙이 아니라 **표시 규칙**이라 여기 둔다.
 */

import type { AnswerRow } from '@/lib/api/db';
import type { Phase, Question } from '@/lib/game/types';

/**
 * 지금 풀고 있는 질문.
 *
 * target 페이즈는 지목 질문 중 **마지막** 것이고(한 판에 여러 번 올 수 있다),
 * question 페이즈는 이번 라운드의 공통 질문이다 (SPEC §5.1).
 */
export function currentQuestion(all: Question[], phase: Phase, round: number): Question | null {
  if (phase === 'target') {
    return all.filter((q) => q.kind === 'target').at(-1) ?? null;
  }
  return all.find((q) => q.kind === 'common' && q.round === round) ?? null;
}

/**
 * 지금 화면에 띄울 답변 묶음 — **지금 질문의 답이 아니라 가장 최근에 공개된 질문의 답**이다.
 *
 * ┌─ 왜 이렇게 하는가 ─────────────────────────────────────────────────────────┐
 * │ 답은 그 페이즈가 끝나야 열린다 (answers.visible_at = phase_ends_at).        │
 * │ 그런데 열리는 순간이 곧 화면이 다음 질문으로 넘어가는 순간이라, "지금       │
 * │ 질문의 답"만 그리면 한 판 내내 아무것도 뜨지 않는다. 라운드2를 푸는 동안    │
 * │ 라운드1의 답이 남아 있어야 서로를 뜯어볼 수 있다.                          │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * 인자로 온 rows 는 이미 RLS 가 걸러 준 **공개된 답뿐이다** (SPEC §7.2).
 * 여기서 visible_at 을 다시 보지 않는다 — 애초에 안 열린 답은 오지 않는다.
 */
export function revealedAnswers(
  all: Question[],
  rows: AnswerRow[],
): { question: Question | null; answers: AnswerRow[] } {
  const byQuestion = new Map<string, AnswerRow[]>();
  for (const a of rows) {
    const bucket = byQuestion.get(a.question_id);
    if (bucket) bucket.push(a);
    else byQuestion.set(a.question_id, [a]);
  }

  // 진행 순서: 공통1 → 공통2 → 지목. target 은 항상 마지막이다 (SPEC §5.1).
  const orderOf = (q: Question) => (q.kind === 'target' ? 3 : q.round);
  const latest = all
    .filter((q) => byQuestion.has(q.id))
    .sort((a, b) => orderOf(a) - orderOf(b))
    .at(-1);

  return {
    question: latest ?? null,
    answers: latest ? (byQuestion.get(latest.id) ?? []) : [],
  };
}

/** 좌석 명단에서 이름을 찾는다. 없으면 '?' — 나간 사람의 표를 그릴 때 걸린다. */
export function nicknameOf(players: { id: string; nickname: string }[], id: string): string {
  return players.find((p) => p.id === id)?.nickname ?? '?';
}
