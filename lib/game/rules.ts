/**
 * 역할 배정 · 점수 계산 · 승패 판정. 소유: B (SPEC §2, §8)
 *
 * 순수 함수만. DB · 네트워크 접근 금지 (SPEC §1 금지 사항).
 * A는 이 함수들의 내부를 모르고, B는 DB를 모른다.
 */

import type { Role } from '@/lib/game/types';

/**
 * seat 순서대로의 역할 배열을 반환한다.
 * 규칙: 봇은 전부 'ai'. 인간이 2명 이상이면 1명만 'spy', 나머지 'citizen'.
 */
export function assignRoles(_humanCount: number, _total: number): Role[] {
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
