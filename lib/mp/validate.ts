/**
 * 수신 메시지 검증 — **순수 함수만.** 소유: A
 * 워커가 쓰지만 `npm test`가 DB 없이 검사할 수 있도록 여기에 둔다.
 *
 * 클라이언트를 신뢰하지 않는 경계다 (SPEC의 서버 권위 표와 같은 취지):
 *   좌표·회전·애니메이션은 클라 권위지만 **범위는 서버가 본다.**
 *   NaN 하나가 통과하면 그 사람을 보는 **모든** 클라이언트의 보간이 영구히 깨진다.
 */

import { POS_MARGIN, WORLD } from './constants';
import { ANIM_STATES, type AnimState, type C2SMessage } from './protocol';

const ANIM_SET = new Set<string>(ANIM_STATES);

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 월드 밖인가. 경계에서 클라 충돌 처리가 조금 튀는 건 허용한다 (POS_MARGIN). */
export function isInsideWorld(x: number, z: number): boolean {
  return (
    x >= WORLD.minX - POS_MARGIN &&
    x <= WORLD.maxX + POS_MARGIN &&
    z >= WORLD.minZ - POS_MARGIN &&
    z <= WORLD.maxZ + POS_MARGIN
  );
}

/**
 * 발 높이가 말이 되는가. 바닥(0)과 점프·발판 사이여야 한다.
 *
 * x·z와 달리 여유(POS_MARGIN)를 크게 주지 않는다 — 높이는 클라이언트 충돌 처리가
 * 튈 여지가 없는 값이고, 여기가 헐거우면 천장 위를 떠다니는 아바타가 생긴다.
 * 아래로는 살짝 음수를 허용한다(착지 프레임에서 -0.001쯤 스친다).
 */
export function isValidHeight(y: number): boolean {
  return y >= -0.5 && y <= WORLD.maxY;
}

export interface MoveInput {
  x: number;
  z: number;
  /** 발 높이. 구 클라이언트가 안 보내면 0이다 */
  y: number;
  heading: number;
  anim: AnimState;
}

/**
 * move 메시지가 쓸 만한가. 아니면 null — 호출자는 **조용히 버리지 말고** 세어 둔다.
 */
export function parseMove(msg: unknown): MoveInput | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;

  if (!isFiniteNumber(m.x) || !isFiniteNumber(m.z) || !isFiniteNumber(m.heading)) return null;
  if (!isInsideWorld(m.x, m.z)) return null;
  if (typeof m.anim !== 'string' || !ANIM_SET.has(m.anim)) return null;

  // y는 나중에 붙은 필드다. 없으면 바닥으로 읽는다 — 구 클라이언트를 끊지 않는다.
  // 있는데 이상하면 **메시지 전체를 버린다.** 높이만 0으로 고쳐 통과시키면
  // 그 사람은 남의 화면에서 계속 바닥을 기고, 왜 그런지 아무도 모른다.
  let y = 0;
  if (m.y !== undefined) {
    if (!isFiniteNumber(m.y) || !isValidHeight(m.y)) return null;
    y = m.y;
  }

  return { x: m.x, z: m.z, y, heading: m.heading, anim: m.anim as AnimState };
}

/**
 * players.id 모양인가. **모양만 본다** — 그 좌석이 이 방에 있는지, 자기 자신은 아닌지는
 * 워커가 본다 (여기는 순수 함수라 방 명단을 모른다).
 *
 * ★ 모양 검사를 여기서 하는 이유: 워커가 좌석 명단을 조회하기 **전에** 쓰레기를 거른다.
 *   길이 제한이 없으면 64KB짜리 문자열이 투표 Map 의 키로 들어앉고, 그건 그대로
 *   reveal 의 votes[] 에 실려 방 전원에게 증폭돼 나간다.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPlayerId(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export interface VoteInput {
  targetId: string;
}

/**
 * vote 메시지가 쓸 만한가. 아니면 null.
 *
 * ★ **voter 를 여기서 받지 않는다.** 규칙 4 — "내가 누구인지"는 C2S 에 넣지 않고
 *   서버가 소켓에서 되찾는다. 넣는 순간 남의 이름으로 투표할 수 있다.
 * ★ **자기 자신 투표 거부는 여기가 아니라 워커다** (SPEC §18.3). 이 함수는 voter 를
 *   모르므로 판정할 수 없다. 워커가 반드시 하드 거부해야 한다 — reveal 의 votes[] 에
 *   자기 자신 투표가 한 건이라도 보이면 그 자리가 봇으로 확정된다 (I1: 봇에게도
 *   같은 규칙을 걸어야 하는데, 사람 쪽만 UI 로 막고 봇은 서버에서 통과시키면 갈린다).
 */
export function parseVote(msg: unknown): VoteInput | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (!isPlayerId(m.targetId)) return null;
  return { targetId: m.targetId };
}

export interface VerdictInput {
  guilty: boolean;
}

/**
 * verdict 메시지가 쓸 만한가. 아니면 null.
 *
 * ★ boolean 만 받는다. `'true'`·1·0 을 너그럽게 받아 주면 `!!value` 로 읽는 순간
 *   `'false'` 가 찬성표가 된다 — 사람 목숨이 걸린 표라 관대할 이유가 없다.
 * ★ 기권은 **메시지를 안 보내는 것**이지 별도 값이 아니다. 지목된 본인의 표는
 *   워커가 무시한다(§18.3).
 */
export function parseVerdict(msg: unknown): VerdictInput | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (typeof m.guilty !== 'boolean') return null;
  return { guilty: m.guilty };
}

/** JSON.parse 결과가 우리가 아는 메시지 모양인가. 타입 좁히기용. */
export function isC2SMessage(msg: unknown): msg is C2SMessage {
  return typeof msg === 'object' && msg !== null && typeof (msg as { t?: unknown }).t === 'string';
}

/** 좌석 번호로 아바타 색을 뽑는다. 사람·봇 구분 없이 좌석만 본다 (I1). */
export const SEAT_COLORS = [
  '#e8b45c',
  '#7fb0d8',
  '#d2796a',
  '#8fbf87',
  '#b391d6',
  '#d8a0c0',
  '#6fc2b8',
  '#c9a37a',
] as const;

export function seatColor(seat: number): string {
  return SEAT_COLORS[(seat - 1 + SEAT_COLORS.length) % SEAT_COLORS.length];
}
