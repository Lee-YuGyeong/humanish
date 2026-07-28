/**
 * 로비 화면에만 있는 값. 소유: C (SPEC §2)
 *
 * 여기 남은 것은 아직 뒷받침할 데이터가 없어 화면에만 있는 값이다.
 * 실제 방 목록·방 만들기·입장은 전부 /api를 거친다 (page.tsx, SPEC I9) — 그쪽은
 * 여기를 쓰지 않는다. 화면에서도 이 값들에는 "MOCK" 배지가 붙는다.
 *
 * 플레이어 정체와 관련된 값(is_bot 등)은 여기에 절대 담지 않는다 (SPEC I1).
 */

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
  // 목업 문구라도 게임 규칙을 말하지 않는다. 봇 수를 숫자로 적으면 그게 곧 안내문이
  // 되고, 사람이 정원을 거의 채운 방에서는 우연히 맞아떨어지기까지 한다 (I1).
  { user: "Master", message: "이번 판 진짜 못 맞히겠던데요", tone: "text-amber-600" },
  { user: "Spy_X", message: "님들 방 드가셈", tone: "text-neutral-700" },
];

export const recentGames = [
  { result: "인간 승리", time: "15분 전", score: "+25", win: true },
  { result: "AI 승리 (패배)", time: "1시간 전", score: "-10", win: false },
];
