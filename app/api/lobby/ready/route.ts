/**
 * 대기방 준비 완료 토글. 소유: A (SPEC §15-3-결정)
 *
 * POST /api/lobby/ready  { room_id, ready }  →  { ok }
 *
 * ★ 발화가 아니라 **상태**다. 좌석 카드에 붙고 말풍선으로 뜨지 않는다 —
 *   채팅으로 흘리면 켜고 끄는 순서가 그대로 신호가 된다.
 *
 * ★ **이제 시작을 막는다** (2026-08-06 결정). 시작 조건은 사람 2~8명 + **방장 뺀**
 *   전원 준비이고(2026-08-07), 판정은 lib/game/rules.ts 의 startBlock 하나다 —
 *   시작 라우트 둘(/api/room/start · /api/room/start-world)과 화면의 시작 버튼이
 *   같은 함수를 본다.
 *
 * ★ 방장이 불러도 막지 않는다. 화면에 버튼이 없을 뿐이고(components/room-lobby.tsx),
 *   여기서 403 을 더하면 방장이 넘어가는 순간(leave_room 의 승계) 이미 켜 둔 준비를
 *   못 끄는 자리가 생긴다. 켜져 있든 아니든 startBlock 이 그 자리를 안 본다.
 *
 *   대가는 알고 있다: **한 명이 자리를 비우면 그 방은 시작되지 않는다.** 그래도
 *   막는 쪽을 골랐다 — 안 누른 사람은 좌석 카드에 그대로 드러나고(누가 안 눌렀는지
 *   보인다), 나가면 자리가 빠져 조건이 다시 성립한다 (leave_room).
 *   advance_phase 는 준비를 보지 못한다 — shuffle_seats 가 is_ready 를 지운 뒤에
 *   불리기 때문이다. 그래서 두 겹 중 바깥쪽(라우트)만 이 조건을 안다.
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
