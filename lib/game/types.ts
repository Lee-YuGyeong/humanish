/**
 * 도메인 타입 — 프론트 · 백 · 에이전트의 공통 언어.
 *
 * SPEC §2 예외 규정: 이 파일만 A · B · C가 함께 편집한다.
 * 변경하면 반드시 팀 채널에 공지할 것.
 * SPEC §10: 타입은 여기서만 정의한다. 각자 파일에서 중복 선언 금지.
 */

export type Phase =
  | 'lobby'
  | 'question' // round 1, 2
  | 'target' // 지목 질문
  | 'chat' // 자유 채팅
  | 'vote'
  | 'reveal'
  | 'replay';

export type Role = 'citizen' | 'spy' | 'ai';

export type AgentAction = 'answer' | 'deflect' | 'accuse' | 'silent';

export interface Room {
  id: string;
  code: string; // 4자 대문자
  phase: Phase;
  phase_seq: number; // 전환마다 +1. 중복 전환 방지 키
  phase_ends_at: string | null; // ISO. null이면 무기한(lobby)
  round: number; // question 페이즈에서만 의미 있음
  host_id: string;
}

export interface Player {
  id: string;
  room_id: string;
  nickname: string; // '익명1' ~ '익명5'
  mask_id: string;
  seat: number; // 1~5. 표시 순서 고정
  is_bot: boolean;
  connected: boolean;
}

/**
 * 클라이언트가 실제로 받는 플레이어 모양. `is_bot`이 없다.
 * SPEC §7: is_bot이 새어나가면 게임이 즉시 끝난다.
 * 클라이언트는 players 테이블이 아니라 public_players 뷰를 읽는다.
 */
export type PublicPlayer = Omit<Player, 'is_bot'>;

export interface Question {
  id: string;
  room_id: string;
  round: number;
  kind: 'common' | 'target';
  text: string;
  asked_by: string | null; // target일 때만
  target_id: string | null; // target일 때만
}

export interface Answer {
  id: string;
  question_id: string;
  player_id: string;
  text: string;
  visible_at: string; // 이 시각 이후에만 노출
}

export interface Message {
  id: string;
  room_id: string;
  player_id: string;
  text: string;
  visible_at: string; // 봇의 타이핑 지연 구현
}

export interface Vote {
  room_id: string;
  voter_id: string;
  target_id: string;
  reason: string;
}

export interface AgentLog {
  id: string;
  room_id: string;
  player_id: string;
  ref_id: string; // 해당 message 또는 answer id
  reasoning: string;
  suspicion: number; // 0~1
  action: AgentAction;
}
