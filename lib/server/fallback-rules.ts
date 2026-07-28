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
 * ★ 이 채점 규칙은 SPEC에 없다. §8은 시그니처만 정했고 방식이 정해진 적이 없어서,
 *   게임이 끝나는 느낌이 나도록 A가 임의로 골랐다. 바꿀 거면 아래 계산과 이 문구를
 *   **같이** 고친다 — 이 배열이 결과 화면에 그대로 뜬다.
 *
 *   알려진 결함은 SPEC §8.1이다: 봇 표가 무작위라 점수가 실력보다 운에 좌우된다.
 *   특히 스파이 점수가 통째로 운이다. 규칙을 확정할 때 같이 정해야 한다.
 */
export const SCORE_RULE = [
  '시민 — AI에게 투표했으면 +2',
  '스파이 — 자신이 받은 표 하나당 +2',
  'AI — 표를 하나도 안 받으면 +3',
];

export function fallbackCalcScores(
  votes: { voterId: string; targetId: string }[],
  roles: Record<string, Role>,
): Record<string, number> {
  const score: Record<string, number> = {};
  for (const id of Object.keys(roles)) score[id] = 0;

  const received: Record<string, number> = {};
  for (const v of votes) received[v.targetId] = (received[v.targetId] ?? 0) + 1;

  for (const v of votes) {
    if (roles[v.voterId] === 'citizen' && roles[v.targetId] === 'ai') score[v.voterId] += 2;
  }
  for (const [id, role] of Object.entries(roles)) {
    if (role === 'spy') score[id] += (received[id] ?? 0) * 2;
    if (role === 'ai' && (received[id] ?? 0) === 0) score[id] += 3;
  }
  return score;
}
