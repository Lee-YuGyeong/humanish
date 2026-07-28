/**
 * 3D 월드 입장 티켓. 소유: A
 *
 * POST /api/world/ticket  { room_id }  →  { ticket, ws_url, self, role }
 *
 * 흐름: 쿠키(players.token)로 본인을 되찾고(I9) → 60초짜리 서명 티켓을 발급한다.
 * 브라우저는 그 티켓을 워커의 WebSocket URL에 실어 접속한다 (lib/mp/ticket.ts 머리말).
 *
 * ★ I1 — 응답에 is_bot도, **남의** 역할도 넣지 않는다.
 *   role은 /api/me와 같은 규칙으로 **쿠키로 되찾은 본인 것 하나만** 내려보낸다.
 *   스파이가 자기가 스파이인 줄 몰라야 할 이유가 없고, 그게 없으면 게임의 절반이 죽는다.
 */

import { signTicket } from '@/lib/mp/ticket';
import type { Role } from '@/lib/game/types';
import { ApiError, apiError, readJson, requirePlayer } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/supabase';

export const dynamic = 'force-dynamic';

interface Body {
  room_id?: string;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { room_id: roomId } = await readJson<Body>(req);
    if (!roomId) throw new ApiError(400, 'room_id가 없다');

    const secret = process.env.WORLD_SHARED_SECRET;
    if (!secret) {
      throw new ApiError(503, 'WORLD_SHARED_SECRET이 없다. .env.local.example 참고');
    }
    const wsUrl = process.env.NEXT_PUBLIC_WORLD_WS_URL;
    if (!wsUrl) {
      throw new ApiError(503, 'NEXT_PUBLIC_WORLD_WS_URL이 없다. .env.local.example 참고');
    }

    // 쿠키로 되찾는다. 클라이언트가 보낸 player_id는 쓰지 않는다 (I9).
    const me = await requirePlayer(roomId);

    const db = getServiceClient();
    // capacity를 빠뜨리면 그리드가 0칸이 된다 — 컬럼 목록을 항상 명시한다.
    const { data: room, error } = await db
      .from('rooms')
      .select('id, code, capacity, phase')
      .eq('id', roomId)
      .single();
    if (error || !room) throw new ApiError(404, '방을 찾을 수 없다');

    // 내 역할 한 행만 집는다. room_id로 긁으면 남의 정체가 딸려온다 (I1).
    const { data: roleRow } = await db
      .from('player_roles')
      .select('role')
      .eq('player_id', me.id)
      .maybeSingle();

    const maskId = `mask-${String(me.seat).padStart(2, '0')}`;
    const ticket = await signTicket(
      { rid: roomId, pid: me.id, seat: me.seat, nick: me.nickname, mask: maskId },
      secret,
      Math.floor(Date.now() / 1000),
    );

    return Response.json(
      {
        ticket,
        ws_url: wsUrl,
        self: {
          id: me.id,
          room_id: roomId,
          seat: me.seat,
          nickname: me.nickname,
          mask_id: maskId,
        },
        room: { id: room.id, code: room.code, capacity: room.capacity, phase: room.phase },
        role: ((roleRow as { role: Role } | null)?.role ?? null) as Role | null,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    return apiError(e);
  }
}
