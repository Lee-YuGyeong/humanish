/**
 * 투표. 소유: A (SPEC §13-7)
 *
 * POST /api/vote  { room_id, target_id, reason }  →  { ok, advanced }
 *
 * ★ voter_id는 받지 않는다. 쿠키의 토큰으로 되찾는다 (I9, SPEC §17.4).
 *   받아서 믿으면 남의 이름으로 투표를 넣을 수 있다.
 *
 * 투표는 reveal 전까지 아무에게도 안 보인다 — RLS가 막는다 (SPEC §7.2).
 * 사람이 전부 냈으면 그 자리에서 reveal로 넘어간다.
 */

import { advancePhase } from '@/lib/server/phase';
import { getServiceClient } from '@/lib/server/supabase';
import { ApiError, apiError, readJson, requirePlayer } from '@/lib/server/auth';

interface Body {
  room_id?: string;
  target_id?: string;
  reason?: string;
}

const MAX_REASON_LEN = 200;

export async function POST(req: Request): Promise<Response> {
  try {
    const { room_id: roomId, target_id: targetId, reason } = await readJson<Body>(req);
    if (!roomId) throw new ApiError(400, 'room_id가 없다');
    if (!targetId) throw new ApiError(400, 'target_id가 없다');

    const me = await requirePlayer(roomId);
    if (targetId === me.id) throw new ApiError(400, '자기 자신에게는 투표할 수 없다');

    const db = getServiceClient();

    const { data: room, error: roomErr } = await db
      .from('rooms')
      .select('id, phase, phase_seq')
      .eq('id', roomId)
      .single();
    if (roomErr) throw new ApiError(500, `방 조회 실패: ${roomErr.message}`);
    if (room.phase !== 'vote') {
      throw new ApiError(409, `지금은 투표할 때가 아니다 (${room.phase})`);
    }

    // 지목 대상이 같은 방 사람인지 확인한다. 다른 방 player_id를 넣으면 안 된다 (I10).
    const { data: target, error: targetErr } = await db
      .from('players')
      .select('id')
      .eq('id', targetId)
      .eq('room_id', roomId)
      .maybeSingle();
    if (targetErr) throw new ApiError(500, `대상 조회 실패: ${targetErr.message}`);
    if (!target) throw new ApiError(400, '이 방에 없는 사람이다');

    const { error: insErr } = await db.from('votes').upsert(
      {
        room_id: roomId,
        voter_id: me.id,
        target_id: targetId,
        reason: (reason ?? '').trim().slice(0, MAX_REASON_LEN),
      },
      { onConflict: 'room_id,voter_id' },
    );
    if (insErr) throw new ApiError(500, `투표 저장 실패: ${insErr.message}`);

    const advanced = await advancePhase(roomId, room.phase_seq, me.id);

    return Response.json({ ok: true, advanced });
  } catch (e) {
    return apiError(e);
  }
}
