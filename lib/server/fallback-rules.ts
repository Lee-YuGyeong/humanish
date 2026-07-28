/**
 * B를 기다리는 동안 게임을 실제로 굴리고 있는 임시 규칙. 소유: A (SPEC §8, §17)
 *
 * ┌─ 왜 이 파일이 따로 있나 ────────────────────────────────────────────────┐
 * │ 원래 이 함수들은 라우트 파일 안에 있었고, 검사하려고 export했다. 그런데  │
 * │ **Next 라우트 파일은 GET·POST·dynamic 같은 정해진 것 말고는 export할 수  │
 * │ 없다.** 깨끗한 빌드에서 실제로 이렇게 튀었다:                            │
 * │                                                                        │
 * │   Route "app/api/room/start/route.ts" does not match the required      │
 * │   types of a Next.js Route.                                            │
 * │                                                                        │
 * │ 증상이 들쭉날쭉해서 더 나쁘다 — 내 기계에서는 통과하고 CI에서 깨진다.   │
 * │ 순수 함수를 lib/server/ 로 내보내면 라우트는 얇아지고 검사도 Next 런타임 │
 * │ 없이 된다.                                                             │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ★ B가 lib/game/rules.ts를 구현하면 **이 파일을 통째로 지운다.** 그리고 두 라우트의
 *   try/catch(resolveRoles · resolveScores)도 같이 지운다. 남겨두면 진짜 규칙이
 *   던질 때 조용히 임시 규칙으로 되돌아간다.
 *   tests/lib/server/fallback-rules.test.ts 의 경보 테스트가 그때를 알려준다.
 *
 * ★ lib/game/ 이 아니라 lib/server/ 에 둔다. lib/game/ 은 B 소유라 A가 채우지 않는다 (I7).
 */

import type { Role } from '@/lib/game/types';

/**
 * 역할 배정 폴백. 규칙은 SPEC §8 그대로다.
 * 봇 자리는 전부 'ai'. 사람이 2명 이상이면 그중 1명만 'spy', 나머지 'citizen'.
 */
export function fallbackAssignRoles(isBotBySeat: boolean[], seed: number): Role[] {
  const humanIndexes = isBotBySeat.flatMap((isBot, i) => (isBot ? [] : [i]));
  const spyIndex = humanIndexes.length >= 2 ? humanIndexes[seed % humanIndexes.length] : -1;

  return isBotBySeat.map((isBot, i) => {
    if (isBot) return 'ai';
    return i === spyIndex ? 'spy' : 'citizen';
  });
}

/**
 * ★ 이 채점 규칙은 SPEC §8에 시그니처만 있고 방식이 비어 있던 자리를 채운 것이다.
 *   바꿀 거면 아래 계산과 이 문구를 **같이** 고친다 — 이 배열이 결과 화면에 그대로 뜬다.
 *
 * ┌─ 봇 표를 세지 않는다 (SPEC §8.1 두 선택지 중 후자) ─────────────────────┐
 * │ 봇은 자기 아닌 아무나 무작위로 찍는다 (on_enter_phase의 vote 훅).       │
 * │ 그 표를 점수에 넣으면 **정원이 커질수록 결과가 주사위가 된다** —        │
 * │ 정원 8인 방에 사람이 둘이면 8표 중 6표가 무작위다.                      │
 * │                                                                        │
 * │ 특히 옛 규칙("스파이는 받은 표 하나당 +2")은 그 주사위를 그대로 점수로  │
 * │ 바꿔서, 스파이 상한이 시민 상한의 7배(14점 대 2점)였다. 잘해서가 아니라 │
 * │ 봇이 우연히 찍어줘서 이기는 판이 나온다.                                │
 * │                                                                        │
 * │ 사람 표만 세면 운이 사라진다. 대가는 사람이 적은 방에서 점수가 잘 안    │
 * │ 움직이는 것인데, §8.1이 예고한 그대로다. 봇에게 근거 있는 투표를        │
 * │ 시키는 쪽(LLM)은 §17.5에서 AI를 얹을 때 다시 본다.                     │
 * └────────────────────────────────────────────────────────────────────────┘
 */
export const SCORE_RULE = [
  '시민 — 진짜 AI에게 투표했으면 +2',
  '스파이 — 사람 표를 한 장이라도 받으면 +4',
  'AI — 사람 표를 한 장도 안 받으면 +3',
  '봇이 던진 표는 세지 않는다 — 무작위라서 실력이 아니다',
];

/** 스파이가 사람 표를 한 장이라도 받았을 때의 점수. 표 수에 비례하지 않는다. */
const SPY_EXPOSED_SCORE = 4;
/** AI가 사람 표를 한 장도 안 받았을 때의 점수. */
const AI_HIDDEN_SCORE = 3;
/** 시민이 진짜 AI를 맞혔을 때의 점수. */
const CITIZEN_HIT_SCORE = 2;

/**
 * 사람이 던진 표인가. 역할을 모르는 id(집계에서 빠진 플레이어)는 **사람으로 치지 않는다** —
 * 모르는 표를 사람 표로 세면 봇 표를 뺀 의미가 조용히 사라진다.
 */
function isHumanVoter(voterId: string, roles: Record<string, Role>): boolean {
  const role = roles[voterId];
  return role === 'citizen' || role === 'spy';
}

/**
 * 각자가 **사람에게서** 받은 표 수. 결과 화면이 "3표 받았는데 왜 0점?"이 되지 않도록
 * reveal 라우트가 이 값을 함께 내려보낸다.
 *
 * ★ B가 lib/game/rules.ts를 구현해 이 파일을 지울 때, 이 함수를 쓰는 쪽
 *   (app/api/reveal/route.ts)도 같이 옮겨야 한다.
 */
export function humanVotesReceived(
  votes: { voterId: string; targetId: string }[],
  roles: Record<string, Role>,
): Record<string, number> {
  const received: Record<string, number> = {};
  for (const id of Object.keys(roles)) received[id] = 0;
  for (const v of votes) {
    if (isHumanVoter(v.voterId, roles)) received[v.targetId] = (received[v.targetId] ?? 0) + 1;
  }
  return received;
}

export function fallbackCalcScores(
  votes: { voterId: string; targetId: string }[],
  roles: Record<string, Role>,
): Record<string, number> {
  const score: Record<string, number> = {};
  for (const id of Object.keys(roles)) score[id] = 0;

  const received = humanVotesReceived(votes, roles);

  for (const v of votes) {
    if (!isHumanVoter(v.voterId, roles)) continue;
    if (roles[v.voterId] === 'citizen' && roles[v.targetId] === 'ai') {
      score[v.voterId] += CITIZEN_HIT_SCORE;
    }
  }
  for (const [id, role] of Object.entries(roles)) {
    if (role === 'spy' && (received[id] ?? 0) > 0) score[id] += SPY_EXPOSED_SCORE;
    if (role === 'ai' && (received[id] ?? 0) === 0) score[id] += AI_HIDDEN_SCORE;
  }
  return score;
}
