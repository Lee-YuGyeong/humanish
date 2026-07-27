/**
 * 입장. 소유: A (SPEC §13-1)
 *
 * POST /api/room/join  { code }  →  { room, player }
 *
 * 정원 초과(409), 이미 시작된 방(409), 없는 코드(404)는 SQL 쪽에서 걸러진다.
 * 이미 그 방에 들어가 있으면(쿠키가 있으면) 새 자리를 만들지 않고 원래 자리를 돌려준다 —
 * 새로고침 때마다 자리가 하나씩 늘면 방이 금방 찬다.
 */

import { joinRoom, findRoomByCode } from '@/lib/server/room';
import { apiError, currentPlayer, readJson, setPlayerCookie } from '@/lib/server/auth';

interface Body {
  code?: string;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { code } = await readJson<Body>(req);
    if (!code) {
      return Response.json({ error: '방 코드가 없다' }, { status: 400 });
    }

    // 이미 그 방의 플레이어면 그대로 돌려준다 (재입장 · 새로고침)
    const room = await findRoomByCode(code);
    const existing = await currentPlayer(room.id);
    if (existing) {
      return Response.json({
        room,
        player: {
          id: existing.id,
          room_id: existing.room_id,
          nickname: existing.nickname,
          mask_id: `mask-${String(existing.seat).padStart(2, '0')}`,
          seat: existing.seat,
          connected: true,
        },
        rejoined: true,
      });
    }

    const joined = await joinRoom(code);
    await setPlayerCookie(joined.room.id, joined.token);
    return Response.json({ room: joined.room, player: joined.player }, { status: 201 });
  } catch (e) {
    return apiError(e);
  }
}
