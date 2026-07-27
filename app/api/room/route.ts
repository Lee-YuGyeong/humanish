/**
 * 방 만들기. 소유: A (SPEC §13-1)
 *
 * POST /api/room  →  { room, player }
 *
 * 토큰은 응답 본문이 아니라 httpOnly 쿠키로 나간다 (SPEC §17.4).
 * 이후 모든 쓰기 라우트가 그 쿠키로 본인을 확인한다.
 */

import { createRoom } from '@/lib/server/room';
import { apiError, setPlayerCookie } from '@/lib/server/auth';

export async function POST(): Promise<Response> {
  try {
    const { room, player, token } = await createRoom();
    await setPlayerCookie(room.id, token);
    return Response.json({ room, player }, { status: 201 });
  } catch (e) {
    return apiError(e);
  }
}
