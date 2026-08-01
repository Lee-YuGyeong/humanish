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
  /**
   * 방 정원. 방을 만들 때 3~8에서 정하고 이후 바뀌지 않는다 (SPEC §4).
   * 하한이 3인 이유는 사람이 2명 이상이어야 스파이가 생기기 때문이고(SPEC §8),
   * 상한이 8인 이유는 좌석 화면이 8칸 기준으로 그려져 있어서다.
   */
  capacity: number;
  /**
   * 방 제목. 방을 만들 때 정하고 이후 바뀌지 않는다 (정원과 같은 취급).
   *
   * ★ 이름이 없으면 **null 하나뿐이다.** 빈 문자열은 오지 않는다 — 서버가
   *   normalizeRoomName 에서 접고 DB 제약이 한 번 더 막는다. 두 가지 빈 값이
   *   있으면 "이름이 있는데 안 보이는" 방이 생긴다.
   * ★ 화면은 이름이 없을 때 방 코드로 대신 부른다.
   */
  name: string | null;
  phase: Phase;
  phase_seq: number; // 전환마다 +1. 중복 전환 방지 키
  phase_ends_at: string | null; // ISO. null이면 무기한(lobby)
  round: number; // question 페이즈에서만 의미 있음
  host_id: string | null;
  /**
   * 참가자 명단이 바뀌었다는 신호 (SPEC §17.3).
   * 이 값이 변하면 클라이언트가 public_players를 다시 읽는다.
   * phase_seq와 헷갈리지 않는다 — 이건 잠금 키가 아니다.
   */
  roster_seq: number;
}

export interface Player {
  id: string;
  room_id: string;
  nickname: string; // '익명1' ~ '익명8'. 자리 번호를 그대로 쓴다
  mask_id: string;
  seat: number; // 1 ~ room.capacity(최대 8). 표시 순서 고정
  is_bot: boolean;
  connected: boolean;
  /**
   * 이 자리에 앉은 사람의 계정 (SPEC §15-2-결정). 봇은 null, 로그인 전 브라우저도 null.
   *
   * ★ **PublicPlayer 에 절대 옮겨 적지 않는다** (I1). 봇에게는 계정이 없으므로
   *   이 값이 새면 `user_id 가 null 인 자리 = 봇`이 되어 명단이 통째로 드러난다.
   *   is_bot 과 정확히 같은 급이다.
   */
  user_id: string | null;
}

/**
 * 계정의 프로필 (SPEC §15-2-결정). `profiles` 테이블과 1:1이다.
 *
 * ★ **랭킹 · 친구 화면에만 나온다. 방 안에서는 끝까지 '익명N'이다.**
 *   이 이름이 방 화면 어딘가에 뜨는 순간 익명성이 끝나고, 그게 이 게임의 전부다.
 *   PublicPlayer 와 한 화면에서 만나지 않게 두는 것이 이 타입을 따로 둔 이유다.
 *
 * ★ 익명 계정에는 행이 없다 — 아직 부를 이름이 없기 때문이다.
 *   구글을 연결하는 순간 서버가 만든다 (app/api/auth/callback).
 */
export interface Profile {
  user_id: string;
  display_name: string; // 1~20자
  avatar_url: string | null;
  created_at: string;
}

/**
 * 클라이언트가 실제로 받는 플레이어 모양. `public_players` 뷰와 1:1이다.
 * SPEC §7.2: is_bot이 새어나가면 게임이 즉시 끝난다.
 *
 * **`Omit<Player, 'is_bot'>`이 아니라 넣을 필드를 하나씩 적는다.**
 * Omit이면 Player에 컬럼이 늘 때마다 자동으로 따라 새어나간다.
 * 실제로 `created_at`이 그렇게 샜다 — 봇은 게임 시작 순간 한꺼번에 만들어져서
 * 생성 시각이 몇 ms 안에 뭉치고, 그것만으로 봇이 전부 특정된다.
 * 필드를 더할 때마다 "이걸로 봇을 골라낼 수 있나"를 먼저 묻는다.
 */
export interface PublicPlayer {
  id: string;
  room_id: string;
  nickname: string;
  mask_id: string;
  seat: number;
  connected: boolean;

  /**
   * 대기방 값 (SPEC §15-3-결정). **lobby 페이즈에서만 채워진다** — 뷰가
   * `phase = 'lobby'` 일 때만 내려주고, 시작할 때 shuffle_seats 가 원본을 비운다.
   *
   * 위의 질문("이걸로 봇을 골라낼 수 있나")을 통과한 근거: 대기방에는 사람만 있다.
   * 봇은 시작 순간 fill_with_bots 로 앉는다. 그래서 대기방에서는 이 값이 누구도
   * 가려내지 못하고, 게임이 시작되면 전원 빈 값이 된다.
   *
   * ☐ 봇을 로비에서 채우는 안(§15-3)으로 가면 이 판단을 다시 해야 한다.
   *   그때는 봇도 사람처럼 이 값을 채워야 한다 — 준비 완료를 봇만 즉시 누르면
   *   그게 곧 정답이다.
   */
  is_ready: boolean;
  /** 지금 떠 있는 말풍선. 기록이 아니라 현재 한 줄이다 (순서가 신호가 되는 걸 막는다). */
  lobby_line: string | null;
  lobby_line_at: string | null;
}

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
  room_id: string; // 방 스코프 쿼리에 쓴다 (I10). 스키마에서 not null이다
  player_id: string;
  text: string;
  visible_at: string; // 이 시각 이후에만 노출. 기본값이 없으니 항상 명시한다
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

/**
 * LLM 호출 계약 — A(app/api/agent/route.ts)가 구현하고 B(lib/agent/generate.ts)가
 * 인자로 받는다 (SPEC §9.2 "실제 호출은 route가 넘겨준 함수로 한다").
 * 공급자 세부(NIM 엔드포인트 · 인증 · 모델 ID)는 route.ts 밖으로 나오지 않는다.
 * B는 이 함수만 알면 되고, 공급자가 바뀌어도 이 타입은 그대로다 (§15-1-결정).
 */
export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type LlmCall = (
  messages: LlmChatMessage[],
  opts?: { signal?: AbortSignal },
) => Promise<string>;

export interface AgentLog {
  id: string;
  room_id: string;
  player_id: string;
  ref_id: string; // 해당 message 또는 answer id
  reasoning: string;
  suspicion: number; // 0~1
  action: AgentAction;
}
