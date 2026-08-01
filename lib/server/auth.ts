/**
 * 플레이어 본인 확인. 소유: A (SPEC §7.1, §17.4)
 *
 * 익명 플레이라 DB는 요청자가 누구인지 모른다. player_id는 public_players로
 * 누구나 읽으므로, 그것만 받아서 믿으면 남의 이름으로 답변·투표를 넣을 수 있다.
 *
 * 그래서 입장할 때 발급한 token을 httpOnly 쿠키로 들고 다니게 하고,
 * 쓰기 라우트는 **클라이언트가 보낸 player_id를 쓰지 않고** 쿠키에서 되찾는다.
 *
 * 이건 익명 인증(SPEC §15-2)을 대신하지 않는다. "이 브라우저가 그때 그 자리에
 * 앉았다"만 증명한다. RLS로 방을 가르려면 여전히 §15-2가 필요하다 (§7.3).
 */

import { cookies } from 'next/headers';
import { getServerAuthClient, getServiceClient } from '@/lib/server/supabase';

/** 방마다 쿠키를 따로 둔다. 한 사람이 방 여러 개에 들어갈 수 있고, 코드는 재사용된다 (SPEC §16.4). */
export function playerCookieName(roomId: string): string {
  return `hp_${roomId}`;
}

/** 게임 한 판보다 넉넉하게. 방은 24시간 뒤 정리되므로 그보다 길 이유가 없다 (SPEC §16.4). */
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24;

/** 상태 코드를 들고 다니는 에러. 라우트가 그대로 응답으로 바꾼다. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface SessionPlayer {
  id: string;
  room_id: string;
  seat: number;
  nickname: string;
  /** 서버 전용. 응답에 실어 보내지 않는다 (I1). */
  is_bot: boolean;
}

/** 쿠키의 토큰으로 플레이어를 되찾는다. 없으면 null. */
export async function currentPlayer(roomId: string): Promise<SessionPlayer | null> {
  const token = (await cookies()).get(playerCookieName(roomId))?.value;
  if (!token) return null;

  const { data, error } = await getServiceClient()
    .from('players')
    .select('id, room_id, seat, nickname, is_bot')
    .eq('room_id', roomId)
    .eq('token', token)
    .maybeSingle();

  if (error) throw new ApiError(500, `플레이어 조회 실패: ${error.message}`);
  return (data as SessionPlayer | null) ?? null;
}

/** 위와 같되 없으면 401로 끊는다. 모든 쓰기 라우트의 첫 줄이다. */
export async function requirePlayer(roomId: string): Promise<SessionPlayer> {
  const player = await currentPlayer(roomId);
  if (!player) {
    throw new ApiError(401, '이 방의 플레이어가 아니다. 다시 입장할 것');
  }
  return player;
}

/** 입장 직후 토큰을 심는다. httpOnly라 JS에서 읽히지 않는다. */
export async function setPlayerCookie(roomId: string, token: string): Promise<void> {
  (await cookies()).set(playerCookieName(roomId), token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: COOKIE_MAX_AGE_SEC,
  });
}

/**
 * 토큰을 지운다. 방에서 나갈 때 부른다.
 *
 * ★ 쿠키를 남겨두면 같은 방 코드로 다시 들어올 때 join_room 앞의 "이미 이 방 사람인가"
 *   검사가 **없어진 자리**를 되찾으려 한다. 지금은 행이 지워져 currentPlayer 가 null 이라
 *   결과가 같지만, 그건 우연이다 — 나간 사람에게 그 방의 열쇠를 남길 이유가 없다.
 */
export async function clearPlayerCookie(roomId: string): Promise<void> {
  (await cookies()).delete(playerCookieName(roomId));
}

/* ────────────────────────────────────────────────────────────────────────────
 * 계정 — SPEC §15-2-결정
 *
 * ★ 위의 player_token 과 **역할이 다르다. 대체하지 않는다.**
 *
 *     player_token  "이 브라우저가 그 방 그 자리에 앉았다"  → 방 안의 모든 쓰기
 *     계정(user_id) "이 사람이 누구다"                      → 전적 · 랭킹 · 친구
 *
 *   방 안의 본인 확인을 계정으로 바꾸지 않는다. 바꾸면 로그인이 실패한 사람이
 *   게임을 못 하게 되고, 한 사람이 방 여러 개에 앉는 경우(§17.4)도 표현이 안 된다.
 *   계정은 전적을 위한 것이지 입장 조건이 아니다.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface SessionUser {
  id: string;
  /** 익명 계정이면 true. 구글을 연결하면 false 가 된다 */
  is_anonymous: boolean;
}

/**
 * 쿠키의 세션으로 계정을 되찾는다. 로그인 전이면 null.
 *
 * ★ getUser() 를 쓴다. getSession() 은 **쿠키에 든 값을 그대로 믿는다** —
 *   서버에서 그걸 신뢰하면 위조된 쿠키로 남의 user_id 를 주장할 수 있다.
 *   getUser() 는 Auth 서버에 물어 서명을 확인한다. I9 와 같은 이유다.
 *
 * ★ 던지지 않는다. 계정이 없어도 게임은 돌아야 하므로, 실패는 "계정 없음"으로
 *   접는다. 이 값이 null 이면 players.user_id 가 null 로 들어갈 뿐이다.
 */
export async function currentUser(): Promise<SessionUser | null> {
  try {
    const db = await getServerAuthClient();
    const { data, error } = await db.auth.getUser();
    if (error || !data.user) return null;
    return { id: data.user.id, is_anonymous: data.user.is_anonymous ?? false };
  } catch {
    return null;
  }
}

/** 위와 같되 없으면 401로 끊는다. 계정이 꼭 필요한 라우트(전적·친구)에서 쓴다. */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw new ApiError(401, '로그인이 필요하다');
  return user;
}

/** 라우트의 catch에서 쓴다. ApiError면 그 상태로, 아니면 500. */
export function apiError(e: unknown): Response {
  if (e instanceof ApiError) {
    return Response.json({ error: e.message }, { status: e.status });
  }
  const message = e instanceof Error ? e.message : String(e);
  console.error('[api]', message);
  return Response.json({ error: message }, { status: 500 });
}

/** 요청 본문을 JSON으로 읽는다. 깨졌으면 400. */
export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new ApiError(400, '요청 본문이 JSON이 아니다');
  }
}
