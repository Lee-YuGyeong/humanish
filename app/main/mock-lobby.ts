/**
 * 로비 목업 데이터. 화면 확인용이다.
 *
 * TODO(A): 실제 방 목록으로 교체. 방 목록 조회는 서버 경유로 받는다 (SPEC I9).
 * 플레이어 정체와 관련된 값(is_bot 등)은 여기에 절대 담지 않는다 (SPEC I1).
 */

export const MAX_PLAYERS = 8;

export type RoomMode = "일반" | "랭크" | "비공개";

export type LobbyRoom = {
  id: string;
  mode: RoomMode;
  title: string;
  players: number;
  host: string;
  language: string;
  locked?: boolean;
  voice?: boolean;
};

export const rooms: LobbyRoom[] = [
  {
    id: "AB12",
    mode: "일반",
    title: "초보자 환영! AI 잡아봅시다",
    players: 5,
    host: "Master_AI",
    language: "한국어",
  },
  {
    id: "KX90",
    mode: "랭크",
    title: "다이아 이상만 오세요 (빡겜)",
    players: 7,
    host: "Silent_Killer",
    language: "한국어",
  },
  {
    id: "PV77",
    mode: "비공개",
    title: "비공개 매치 — 친목방",
    players: 4,
    host: "Admin_KR",
    language: "한국어",
    locked: true,
    voice: true,
  },
  {
    id: "SP31",
    mode: "일반",
    title: "스파이 연기 잘하시는 분?",
    players: 2,
    host: "Acting_God",
    language: "한국어",
  },
  {
    id: "FG05",
    mode: "일반",
    title: "빠르게 한 판 하실 분",
    players: 1,
    host: "Fast_Game",
    language: "한국어",
  },
];

export const modeStyle: Record<RoomMode, string> = {
  일반: "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-100",
  랭크: "bg-amber-50 text-amber-700 ring-1 ring-amber-100",
  비공개: "bg-neutral-100 text-neutral-500 ring-1 ring-neutral-200",
};

export type Friend = {
  name: string;
  state: "대기 중" | "게임 중" | "오프라인";
  detail?: string;
};

export const friends: Friend[] = [
  { name: "Yuri_Gaming", state: "대기 중" },
  { name: "King_Bot", state: "게임 중", detail: "12:40" },
  { name: "Ghost_User", state: "오프라인" },
];

export const friendStyle: Record<Friend["state"], { dot: string; text: string }> = {
  "대기 중": { dot: "bg-emerald-500", text: "text-emerald-600" },
  "게임 중": { dot: "bg-blue-500", text: "text-blue-600" },
  오프라인: { dot: "bg-neutral-300", text: "text-neutral-400" },
};

export type ChatLine = { user: string; message: string; tone: string };

export const chat: ChatLine[] = [
  { user: "User_99", message: "같이 하실 분?", tone: "text-indigo-600" },
  { user: "Bot_A", message: "방금 AI 연기 오졌음ㅋㅋㅋ", tone: "text-neutral-400" },
  { user: "Master", message: "진짜 AI 1명인 거 너무 빡세네요", tone: "text-amber-600" },
  { user: "Spy_X", message: "님들 방 드가셈", tone: "text-neutral-700" },
];

export const recentGames = [
  { result: "인간 승리", time: "15분 전", score: "+25", win: true },
  { result: "AI 승리 (패배)", time: "1시간 전", score: "-10", win: false },
];
