/**
 * 강퇴 — 방장이 대기방에서 한 사람을 내보낸다. 소유: A (2026-08-07)
 *
 * POST /api/room/kick  { room_id, target_id }  →  { ok, kicked }
 *
 * ★ **시킨 사람의 id 는 받지 않는다.** 쿠키의 토큰으로 되찾는다 (I9, SPEC §17.4).
 *   받아서 믿으면 남의 id 를 적어 보내는 것만으로 방장 행세를 할 수 있다.
 *
 * ★ 방장인지 · 대기방인지 · 자기 자신이 아닌지는 **SQL 안에서** 본다
 *   (supabase/functions/room.sql 의 kick_player). 여기서 미리 보고 넘기면
 *   그 사이에 방장이 바뀔 수 있다 — 판정과 삭제가 같은 트랜잭션이어야 한다.
 *
 * ★ **자리를 빼는 것으로 끝나지 않는다** (2026-08-08). 같은 트랜잭션에서
 *   room_bans 에 한 줄이 남고, join_room 이 그걸 보고 재입장을 거절한다.
 *   자리만 지우면 그 사람은 이미 아는 코드로 곧장 다시 들어왔다.
 *
 * ★ 내보내진 사람에게는 아무것도 보내지 않는다. players 삭제가 roster_seq 를
 *   올리고(schema.sql 트리거), 그 rooms UPDATE 가 이미 걸려 있는 구독으로 가서
 *   그 사람 화면이 스스로 "내 자리가 없다"를 알아챈다 (components/room-view.tsx).
 */

import { ApiError, apiError, readJson, requirePlayer } from '@/lib/server/auth';
import { kickPlayer } from '@/lib/server/room';

interface Body {
  room_id?: string;
  target_id?: string;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { room_id: roomId, target_id: targetId } = await readJson<Body>(req);
    if (!roomId) throw new ApiError(400, 'room_id가 없다');
    if (!targetId) throw new ApiError(400, 'target_id가 없다');

    const me = await requirePlayer(roomId);
    const { kicked } = await kickPlayer(roomId, me.id, targetId);

    return Response.json({ ok: true, kicked });
  } catch (e) {
    return apiError(e);
  }
}
