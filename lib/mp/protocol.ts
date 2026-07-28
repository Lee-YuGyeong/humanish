/**
 * 멀티플레이 프로토콜 — 클라이언트와 워커가 공유하는 **유일한 계약**.
 * 소유: A. app/world/net/* 와 worker/src/* 가 이 파일 하나만 본다.
 *
 * 규칙 네 가지 (worker/README.md에도 같은 내용이 있다):
 *  1. 양쪽 핸들러(RoomDO.webSocketMessage · RoomConnection.onmessage)를 **같은 커밋에서** 고친다.
 *  2. 양쪽 switch의 default는 **무시**한다. 필드·타입 추가는 non-breaking이다.
 *  3. PROTOCOL_VERSION은 **의미가 바뀔 때만** 올리고, 올렸으면 워커를 먼저 배포한다.
 *  4. 위조되면 곤란한 값은 애초에 C2S에 넣지 않는다. 닉네임·좌석·시각은 전부 서버가 정한다.
 *
 * ★ I1 — 이 파일의 어떤 타입에도 `is_bot`에 해당하는 필드를 만들지 않는다.
 *   봇 아바타는 사람과 **똑같은 PlayerSnapshot**으로 내려가고, 똑같은 player_moved
 *   스트림을 탄다. 클라이언트는 누가 봇인지 구분할 정보를 한 조각도 받지 않는다.
 */

/** 아바타 애니메이션 상태. 서버가 화이트리스트로 검증한다. */
export type AnimState = 'idle' | 'walk' | 'run' | 'sit';

export const ANIM_STATES: readonly AnimState[] = ['idle', 'walk', 'run', 'sit'];

/**
 * 방에 있는 한 사람(또는 봇)의 현재 모습.
 *
 * ★ 필드를 더할 때마다 "이걸로 봇을 골라낼 수 있나"를 먼저 묻는다 (SPEC §7.2와 같은 규칙).
 *   예: `joinedAt`을 넣으면 봇은 방 생성 시각에 뭉쳐 있어서 전부 특정된다.
 */
export interface PlayerSnapshot {
  /** players.id (uuid). 방 안에서만 유효하다. */
  id: string;
  /** 1 ~ room.capacity. 표시 순서·색을 여기서 뽑는다. */
  seat: number;
  /** '익명1' 형태. 클라이언트가 보낸 값을 절대 쓰지 않는다 — 티켓에 서명된 값이다. */
  nickname: string;
  /** 아바타 외형 키. `mask-01` 형태. */
  maskId: string;
  x: number;
  z: number;
  /** y축 회전(rad). 아바타가 보는 방향. */
  heading: number;
  anim: AnimState;
}

/** 클라이언트 → 서버 */
export type C2SMessage =
  | { t: 'move'; x: number; z: number; heading: number; anim: AnimState }
  | { t: 'chat'; text: string };

/** 접속이 거절되는 이유. 클라이언트가 이걸 보고 재시도할지 정한다. */
export type ErrorCode =
  | 'version_mismatch'
  | 'unauthorized'
  | 'room_full'
  | 'room_unavailable'
  | 'bad_request';

/** 서버 → 클라이언트 */
export type S2CMessage =
  | { t: 'welcome'; selfId: string; players: PlayerSnapshot[] }
  | { t: 'player_joined'; player: PlayerSnapshot }
  | { t: 'player_left'; id: string }
  | { t: 'player_moved'; id: string; x: number; z: number; heading: number; anim: AnimState }
  | { t: 'chat'; id: string; nickname: string; text: string; ts: number }
  | { t: 'error'; code: ErrorCode };

/**
 * 입장 티켓의 알맹이. Next(`/api/world/ticket`)가 서명하고 워커가 검증한다.
 * 브라우저를 통과하므로 **여기에 봇 여부·역할·남의 정보를 넣지 않는다.**
 */
export interface TicketPayload {
  /** rooms.id */
  rid: string;
  /** players.id */
  pid: string;
  seat: number;
  nick: string;
  mask: string;
  /** 만료 (epoch seconds) */
  exp: number;
}
