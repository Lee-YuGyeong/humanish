/**
 * 나가기. 소유: A (SPEC §13-1, §16.4)
 *
 * POST /api/room/leave  { room_id }  →  { ok, room_deleted }
 *
 * 자리를 빼고, **사람이 하나도 안 남으면 방을 지운다.** 아무도 없는 대기방이
 * 목록에 계속 뜨는 것을 막고, 방 코드도 24시간(cleanup_stale_rooms)까지 안 기다리고
 * 바로 돌려준다. 판정은 SQL 한 트랜잭션 안에서 한다 (lib/server/room.ts의 leaveRoom).
 *
 * ★ player_id 를 받지 않는다. 쿠키의 토큰으로 되찾는다 (I9, SPEC §17.4).
 *   안 그러면 남의 id 를 적어 보내는 것만으로 남을 방에서 쫓아낼 수 있다.
 *
 * ★ 그 방 사람이 아니면 401 이 아니라 그냥 성공으로 돌려준다. 이미 나간 사람이
 *   버튼을 두 번 누른 경우가 대부분이고, 그때 빨간 배너를 띄울 이유가 없다.
 *
 * 게임 중(phase ≠ lobby)에는 409다 — SPEC §15-4 미결정.
 */

import { ApiError, apiError, clearPlayerCookie, currentPlayer, readJson } from '@/lib/server/auth';
import { leaveRoom } from '@/lib/server/room';

interface Body {
  room_id?: string;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { room_id: roomId } = await readJson<Body>(req);
    if (!roomId) throw new ApiError(400, 'room_id가 없다');

    const me = await currentPlayer(roomId);
    if (!me) {
      // 자리가 없으니 뺄 것도 없다. 쿠키만 정리하고 끝낸다.
      await clearPlayerCookie(roomId);
      return Response.json({ ok: true, room_deleted: false });
    }

    const { roomDeleted } = await leaveRoom(roomId, me.id);
    await clearPlayerCookie(roomId);

    return Response.json({ ok: true, room_deleted: roomDeleted });
  } catch (e) {
    return apiError(e);
  }
}
