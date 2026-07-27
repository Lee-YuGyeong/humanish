/**
 * 페르소나 · 시스템 프롬프트. 소유: B (SPEC §2, §9)
 */

export interface Persona {
  id: string;
  /** 봇이 연기하는 성격·말버릇의 축약. 클라이언트에 노출되지 않는다. */
  traits: string[];
  /** 시스템 프롬프트 본문. */
  system: string;
}

/** TODO(B): 봇 4명이 서로 구분되도록 최소 4종. */
export const PERSONAS: readonly Persona[] = [];
