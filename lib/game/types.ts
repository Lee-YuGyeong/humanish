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
  | 'revote' // ★ §18.3 — 사람 표 최다가 동점일 때만. 20초, 후보는 동점자뿐
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
   * 투표로 지목된 한 자리 (SPEC §18.3, §18.4). vote/revote를 벗어날 때 서버가 확정한다.
   * 그 전에는 null. reveal이 이 자리의 정체로 진영 승패를 정한다.
   *
   * ★ player_id일 뿐 봇 여부를 담지 않는다 (I1). reveal 전까지는 아무도 이걸로
   *   정체를 역산할 수 없다 — 지목됐다는 사실만으로는 사람/봇/연기자가 안 갈린다.
   */
  nominated_player_id: string | null;
  /**
   * 재투표 후보 (SPEC §18.3). vote에서 사람 표가 동점이면 그 동점자들로 채워지고,
   * revote 화면은 이 목록 안에서만 고르게 한다. 동점이 아니면 null.
   */
  revote_candidates: string[] | null;
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
 * 끝난 한 판, 내 것 (SPEC §15-2-결정 「아직 안 한 것」). `match_results` 한 행이다.
 *
 * ★ **내 행만 다룬다.** 남의 행이 한 화면에 오면 "그 방에서 누가 스파이였나"가
 *   나오고, 한 방의 행을 세면 사람 수가 나와 정원에서 빼면 봇 수가 나온다 (I1).
 *   RLS 가 auth.uid() = user_id 로 막고 있고(supabase/policies.sql),
 *   읽는 라우트도 쿠키 세션의 계정 하나로만 조회한다.
 *
 * ★ 방 안 화면에 쓰지 않는다. Profile 과 같은 이유다 — 로비·전적 화면의 것이다.
 */
export interface RecentMatch {
  /** 목록의 key 로만 쓴다. 방은 24시간 뒤 지워지지만(§16.4) 이 값은 남는다.
   *  ★ 월드 판은 방이 아니라 **판**의 uuid 다 (lib/server/match.ts 의
   *    buildWorldMatchRows) — 같은 방의 rematch 판들이 각각 한 줄씩 온다. */
  room_id: string;
  /** 봇의 'ai' 는 오지 않는다. 봇에게는 계정이 없어서 행 자체가 없다.
   *  'spy' 는 예전 2D 판, 'actor' 는 월드 판이다 — 같은 뜻이고 이름만 §18.2 에서
   *  바뀌었다. 지난 행을 고쳐 쓰지 않으므로(소급 금지) 둘 다 온다. */
  role: 'citizen' | 'spy' | 'actor';
  /** 자기 목표를 이뤘나. 기록할 때 정해서 저장한 값이다 (lib/server/match.ts) */
  won: boolean;
  score: number;
  created_at: string;
}

/** 로비 왼쪽 기둥이 그리는 내 전적 전체. GET /api/profile/stats 의 응답이다. */
export interface ProfileStats {
  games: number;
  wins: number;
  /**
   * 0~1. **한 판도 없으면 null 이다.**
   * 0 으로 접으면 아직 안 해 본 사람과 다 진 사람이 화면에서 같아 보인다.
   */
  win_rate: number | null;
  /** 누적 점수 = 누적 경험치 */
  exp: number;
  level: number;
  level_into: number;
  level_need: number;
  /** level_into / level_need. EXP 막대가 이 값을 쓴다 */
  level_ratio: number;
  /** 최신순. 로비는 앞의 몇 개만 그린다 */
  recent: RecentMatch[];
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

  /**
   * 계정을 만들 때 본인이 지은 이름 (SPEC §15-2-결정).
   * **대기방에서만 보인다.** 게임이 시작되면 null 이다 — 두 겹으로 막혀 있다:
   * shuffle_seats 가 원본을 지우고, 뷰가 phase='lobby' 일 때만 내려준다.
   *
   * 로그인하지 않은 사람은 null 이고, 화면은 그때 nickname('익명N')으로 부른다.
   * 대기방에는 사람만 있으므로(봇은 시작할 때 앉는다) 비어 있다고 봇이 드러나지 않는다.
   *
   * ★ 게임 화면에서 이 값을 쓰지 않는다. 쓰는 순간 대기방의 그 사람과 게임의
   *   이 자리가 다시 이어져서 shuffle_seats 가 한 일이 무의미해진다 (I1).
   */
  lobby_name: string | null;
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
