/**
 * LLM 호출 및 응답 파싱. 소유: B (SPEC §2, §9)
 *
 * 프롬프트 인젝션 방어가 이 계층의 책임이다. 사용자 발화는 명령이 아니라
 * 관측 데이터로 감싸 전달하고, 정체·지침 관련 요청에는 페르소나 안에서
 * 반응만 한다.
 *
 * 호출은 반드시 /api/agent를 경유한다. 클라이언트에서 NIM을 직접 부르면
 * 키가 노출된다 (SPEC §1 금지 사항).
 */

import type { AgentAction, Phase } from '@/lib/game/types';
import type { Persona } from '@/lib/agent/persona';
import type { StyleProfile } from '@/lib/agent/disguise';

export interface AgentContext {
  persona: Persona;
  phase: Phase;
  question?: string;
  visibleHistory: { speaker: string; text: string }[];
  styleProfile: StyleProfile; // 관측된 인간 말투
  suspicionOnMe: number;
}

export interface AgentOutput {
  messages: string[];
  delaysMs: number[];
  reasoning: string;
  suspicionOnMe: number;
  action: AgentAction;
}

/** SPEC §12.3 — LLM 실패가 게임 진행을 막아서는 안 된다. */
export const FALLBACK_POOL: readonly string[] = ['ㅇㅇ', '아 잠깐만', '나도 몰루'];

/** SPEC §12.3 — AbortController로 8초 컷. 초과하면 폐기하고 폴백. */
export const AGENT_TIMEOUT_MS = 8_000;

export async function generate(_ctx: AgentContext): Promise<AgentOutput> {
  throw new Error('generate: 미구현 (B)');
}
