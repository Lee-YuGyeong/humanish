/**
 * 대기방에서 프리셋 문구를 하나 말한다. 소유: A (SPEC §15-3-결정)
 *
 * POST /api/lobby/line  { room_id, line_id }  →  { ok }
 *
 * ★ text 가 아니라 **line_id** 를 받는다. 텍스트를 받으면 클라이언트가 아무 말이나
 *   넣을 수 있어서 프리셋으로 좁힌 의미가 사라진다. 문구는 서버가 id 로 찾는다.
 *
 * ★ player_id 를 받지 않는다. 쿠키의 토큰으로 되찾는다 (I9, SPEC §17.4).
 *
 * 쿨다운 · 같은 문구 연속 금지 · 1인 총량은 DB 가 본다 (functions/lobby.sql).
 * 확인과 기록 사이에 다른 탭이 끼어드는 틈을 없애려고 한 트랜잭션에 맡긴다.
 */

import { ApiError, apiError, readJson, requirePlayer } from '@/lib/server/auth';
import { sayLobbyLine } from '@/lib/server/lobby';
import { lobbyLineText } from '@/lib/server/lobby-lines';

interface Body {
  room_id?: string;
  line_id?: string;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { room_id: roomId, line_id: lineId } = await readJson<Body>(req);
    if (!roomId) throw new ApiError(400, 'room_id가 없다');
    if (!lineId) throw new ApiError(400, 'line_id가 없다');

    // 화이트리스트. 목록에 없는 id는 여기서 끊긴다 (I9).
    const text = lobbyLineText(lineId);
    if (!text) throw new ApiError(400, `대기방에서 쓸 수 없는 문구다: ${lineId}`);

    const me = await requirePlayer(roomId);
    await sayLobbyLine(roomId, me.id, text);

    return Response.json({ ok: true });
  } catch (e) {
    return apiError(e);
  }
}
