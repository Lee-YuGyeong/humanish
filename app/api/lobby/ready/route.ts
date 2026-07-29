/**
 * 대기방 준비 완료 토글. 소유: A (SPEC §15-3-결정)
 *
 * POST /api/lobby/ready  { room_id, ready }  →  { ok }
 *
 * ★ 발화가 아니라 **상태**다. 좌석 카드에 붙고 말풍선으로 뜨지 않는다 —
 *   채팅으로 흘리면 켜고 끄는 순서가 그대로 신호가 된다.
 *
 * ★ 시작을 막지 않는다. 시작 조건은 사람 2명뿐이고(MIN_HUMANS_TO_START, §17.6),
 *   그 판정은 /api/room/start 와 advance_phase 가 두 겹으로 한다. 여기에 "전원 준비"를
 *   더하면 한 명이 자리를 비운 방이 영원히 시작되지 않는다. 준비는 방장이 참고하는
 *   표시일 뿐이다.
 *
 * ★ player_id 를 받지 않는다. 쿠키의 토큰으로 되찾는다 (I9, SPEC §17.4).
 */

import { ApiError, apiError, readJson, requirePlayer } from '@/lib/server/auth';
import { setLobbyReady } from '@/lib/server/lobby';

interface Body {
  room_id?: string;
  ready?: boolean;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { room_id: roomId, ready } = await readJson<Body>(req);
    if (!roomId) throw new ApiError(400, 'room_id가 없다');
    if (typeof ready !== 'boolean') throw new ApiError(400, 'ready가 true/false가 아니다');

    const me = await requirePlayer(roomId);
    await setLobbyReady(roomId, me.id, ready);

    return Response.json({ ok: true });
  } catch (e) {
    return apiError(e);
  }
}
