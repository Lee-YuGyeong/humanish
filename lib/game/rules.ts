/**
 * 역할 배정 · 점수 계산 · 승패 판정. 소유: B (SPEC §2, §8)
 *
 * 순수 함수만. DB · 네트워크 접근 금지 (SPEC §1 금지 사항).
 * A는 이 함수들의 내부를 모르고, B는 DB를 모른다.
 */

import type { Role } from '@/lib/game/types';

/**
 * seat 순서대로의 역할 배열을 반환한다. 입력과 길이가 같다.
 * 규칙: 봇 자리는 전부 'ai'. 사람이 2명 이상이면 그중 1명만 'spy', 나머지 'citizen'.
 *
 * @param isBotBySeat seat 1..N 순서. 어느 자리가 봇인지는 호출자(A)가 안다
 * @param seed        스파이를 고르는 난수. 함수 안에서 만들지 않는다 (I3)
 *
 * ※ 시그니처가 (humanCount, total)에서 바뀌었다 (SPEC §8).
 *   개수만 받으면 "앞쪽 seat이 사람"이라는 가정이 숨고, 시드가 없으면 스파이를 못 고른다.
 */
export function assignRoles(_isBotBySeat: boolean[], _seed: number): Role[] {
  throw new Error('assignRoles: 미구현 (B)');
}

export function calcScores(
  _votes: { voterId: string; targetId: string }[],
  _roles: Record<string, Role>,
): Record<string, number> {
  throw new Error('calcScores: 미구현 (B)');
}

export function mostSuspectedHuman(
  _votes: { targetId: string }[],
  _roles: Record<string, Role>,
): string | null {
  throw new Error('mostSuspectedHuman: 미구현 (B)');
}
