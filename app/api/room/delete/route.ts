/**
 * 방 삭제 (게임 종료 뒤 정리). 소유: A (SPEC §16.4)
 *
 * POST /api/room/delete  { room_id }  →  { ok, deleted }
 *
 * 3D 월드에서 판이 끝나(reveal) 로비로 돌아갈 때, **게임했던 방을 통째로 지운다.**
 * leaveRoom(§13-1)과 다르다 — 그쪽은 "사람이 하나도 안 남았을 때만" 지운다.
 * 여기는 판이 끝난 방이라 남은 자리와 무관하게 방을 접는다.
 *
 * ★ player_id 를 받지 않는다. 쿠키의 토큰으로 **그 방의 참가자인지**만 확인한다
 *   (I9, SPEC §17.4). 남의 방 id 를 적어 보내는 것만으로 지우지 못하게 한다.
 *
 * ★ 멱등이다. 방마다 여러 클라이언트가 동시에 로비로 나가며 각자 부르므로,
 *   이미 지워졌거나(참가자 조회가 null) 두 번째 호출이면 에러가 아니라 그냥 ok 다.
 *
 * ★ cascade 로 players·questions·answers·votes·messages 가 같이 지워진다.
 *   match_results 는 room_id 에 외래키가 없어(§16.4, supabase/checks.sh) 전적은 남는다.
 */

import { ApiError, apiError, clearPlayerCookie, currentPlayer, readJson } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/supabase';

interface Body {
  room_id?: string;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { room_id: roomId } = await readJson<Body>(req);
    if (!roomId) throw new ApiError(400, 'room_id가 없다');

    // 참가자였는지 쿠키 토큰으로 확인한다. 아니면(이미 지워졌거나 남의 방) 조용히 ok —
    // 여러 클라이언트가 동시에 나가며 부르는 게 정상 경로라 배너를 띄울 이유가 없다.
    const me = await currentPlayer(roomId);
    if (!me) {
      await clearPlayerCookie(roomId);
      return Response.json({ ok: true, deleted: false });
    }

    // 쓰기는 service role 서버 경유다 (I9). cascade 가 딸린 자식 행을 함께 지운다.
    const { error } = await getServiceClient().from('rooms').delete().eq('id', roomId);
    if (error) throw new ApiError(500, `방 삭제 실패: ${error.message}`);

    await clearPlayerCookie(roomId);
    return Response.json({ ok: true, deleted: true });
  } catch (e) {
    return apiError(e);
  }
}
