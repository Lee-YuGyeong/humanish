/**
 * 로비 화면에만 있는 값. 소유: C (SPEC §2)
 *
 * 여기 남은 것은 아직 뒷받침할 데이터가 없어 화면에만 있는 값이다 — 친구 목록과
 * 로비 채팅 둘뿐이다. 실제 방 목록·방 만들기·입장은 전부 /api를 거치고
 * (page.tsx, SPEC I9), **전적(레벨·승률·판수·최근 게임)도 이제 진짜다** —
 * GET /api/profile/stats 에서 온다 (SPEC §15-2-결정). 그쪽은 여기를 쓰지 않는다.
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

/**
 * 색은 창고 팔레트에서 고른다 (app/globals.css).
 * 새 씬에는 초록이 없다 — 켜짐은 텅스텐, 진행 중은 비상등 붉은색이다.
 * 켜졌다는 걸 색이 아니라 **번짐**으로 알린다.
 */
export const friendStyle: Record<Friend["state"], { dot: string; text: string }> = {
  "대기 중": { dot: "bg-tung shadow-[0_0_8px_2px] shadow-tung/50", text: "text-tung/80" },
  "게임 중": { dot: "bg-signal shadow-[0_0_8px_2px] shadow-signal/50", text: "text-signal/80" },
  오프라인: { dot: "bg-ash", text: "text-ash" },
};

export type ChatLine = { user: string; message: string; tone: string };

export const chat: ChatLine[] = [
  { user: "User_99", message: "같이 하실 분?", tone: "text-tung" },
  { user: "Bot_A", message: "방금 AI 연기 오졌음ㅋㅋㅋ", tone: "text-grime" },
  // 목업 문구라도 게임 규칙을 말하지 않는다. 봇 수를 숫자로 적으면 그게 곧 안내문이
  // 되고, 사람이 정원을 거의 채운 방에서는 우연히 맞아떨어지기까지 한다 (I1).
  { user: "Master", message: "이번 판 진짜 못 맞히겠던데요", tone: "text-bounce" },
  { user: "Spy_X", message: "님들 방 드가셈", tone: "text-signal/70" },
];
