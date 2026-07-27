/**
 * 대기방 목업 데이터. 화면 확인용이다.
 *
 * TODO(A): public_players 뷰에서 받아오도록 교체 (SPEC I1 — is_bot 은 절대 내려오지 않는다).
 * TODO(A): 준비 상태 · 시작은 서버 경유 (SPEC I9). 시작 판정은 서버 시각 기준 (SPEC I2).
 */

export const MAX_PLAYERS = 8;

export type Seat = {
  seat: number;
  name: string;
  level: number;
  ready: boolean;
  isHost?: boolean;
  isYou?: boolean;
};

/** 빈 자리는 목록에 없다. seat 번호로 자리를 채운다. */
export const seats: Seat[] = [
  { seat: 1, name: "Master_AI", level: 42, ready: true, isHost: true },
  { seat: 2, name: "Player_K", level: 24, ready: true, isYou: true },
  { seat: 3, name: "Yuri_Gaming", level: 18, ready: false },
  { seat: 4, name: "Kim_Detective", level: 56, ready: true },
  { seat: 5, name: "AI_Hunter", level: 31, ready: false },
];

export const room = {
  code: "AF-8204",
  title: "초보자 환영! AI 잡아봅시다",
  mode: "일반",
  host: "Master_AI",
};

export const rules = [
  { label: "참여 인원", value: "8인 (고정)", accent: false },
  { label: "진짜 AI", value: "1명", accent: true },
  { label: "스파이 (연기자)", value: "3명", accent: false },
  { label: "인간 (수사관)", value: "4명", accent: false },
];

export type RoomMessage =
  | { kind: "chat"; author: string; text: string; mine?: boolean }
  | { kind: "system"; text: string };

export const messages: RoomMessage[] = [
  { kind: "chat", author: "Master_AI", text: "안녕하세요! 8명 차면 바로 갑니다." },
  { kind: "chat", author: "Player_K", text: "스파이 걸리고 싶다 ㅋㅋ", mine: true },
  { kind: "chat", author: "Kim_Detective", text: "이번엔 진짜 AI 꼭 잡는다." },
  { kind: "system", text: "AI_Hunter 님이 입장했습니다" },
];
