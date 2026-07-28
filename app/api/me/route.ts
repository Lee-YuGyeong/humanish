/**
 * 나는 누구인가. 소유: A (SPEC §17.4)
 *
 * GET /api/me?room_id=...  →  { player, is_host, answered, voted }
 *
 * 토큰 쿠키는 httpOnly라 브라우저 JS가 읽을 수 없다. 그래서 화면이 "내가 이 방의
 * 누구인지"를 알려면 서버에 물어봐야 한다. 새로고침해도 이 경로로 복구된다.
 *
 * ★ is_bot은 내려보내지 않는다 (I1). 내 것이라도 마찬가지다 — 응답을 보면
 *   자기가 봇인지 알 수 있어야 할 이유가 없고, 실수로 새면 되돌릴 수 없다.
 */

import { getServiceClient } from '@/lib/server/supabase';
import { ApiError, apiError, currentPlayer } from '@/lib/server/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  try {
    const roomId = new URL(req.url).searchParams.get('room_id');
    if (!roomId) throw new ApiError(400, 'room_id가 없다');

    const me = await currentPlayer(roomId);
    if (!me) return Response.json({ player: null, is_host: false, answered: false, voted: false });

    const db = getServiceClient();

    const { data: room } = await db
      .from('rooms')
      .select('host_id, phase, round')
      .eq('id', roomId)
      .single();

    // 내 답변·투표 여부. answers는 visible_at 때문에 클라이언트가 직접 못 읽는다.
    let answered = false;
    if (room?.phase === 'question' || room?.phase === 'target') {
      const base = db.from('questions').select('id').eq('room_id', roomId);
      const { data: q } =
        room.phase === 'question'
          ? await base.eq('kind', 'common').eq('round', room.round).maybeSingle()
          : await base.eq('kind', 'target').order('round', { ascending: false }).limit(1).maybeSingle();

      if (q) {
        const { count } = await db
          .from('answers')
          .select('id', { count: 'exact', head: true })
          .eq('question_id', q.id)
          .eq('player_id', me.id);
        answered = (count ?? 0) > 0;
      }
    }

    const { count: voteCount } = await db
      .from('votes')
      .select('voter_id', { count: 'exact', head: true })
      .eq('room_id', roomId)
      .eq('voter_id', me.id);

    return Response.json({
      player: {
        id: me.id,
        room_id: me.room_id,
        nickname: me.nickname,
        mask_id: `mask-${String(me.seat).padStart(2, '0')}`,
        seat: me.seat,
        connected: true,
      },
      is_host: room?.host_id === me.id,
      answered,
      voted: (voteCount ?? 0) > 0,
    });
  } catch (e) {
    return apiError(e);
  }
}
