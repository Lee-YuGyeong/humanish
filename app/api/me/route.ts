/**
 * 나는 누구인가. 소유: A (SPEC §17.4)
 *
 * GET /api/me?room_id=...  →  { player, is_host, answered, voted, role, bot_count }
 *
 * 토큰 쿠키는 httpOnly라 브라우저 JS가 읽을 수 없다. 그래서 화면이 "내가 이 방의
 * 누구인지"를 알려면 서버에 물어봐야 한다. 새로고침해도 이 경로로 복구된다.
 *
 * ★ is_bot은 **행 단위로는** 내려보내지 않는다 (I1). 내 것이라도 마찬가지다 —
 *   응답을 보면 자기가 봇인지 알 수 있어야 할 이유가 없고, 실수로 새면 되돌릴 수 없다.
 *
 * ★ 대신 bot_count(그 방의 봇 **총 수**)는 내려보낸다. SPEC §15-3에서 "몇인지는
 *   공개하고 어느 자리인지는 숨긴다"로 정했다. 이 값은 자리와 묶이지 않는 집계라
 *   누구를 특정하지 못한다. 0일 수 있다 — 사람이 정원을 다 채운 방이다.
 *
 *   ※ 여기에 자리별 정보를 덧붙이지 않는다. seat 배열이나 "봇이 앉은 seat"을
 *     더하는 순간 §15-3이 허용한 범위를 넘어 I1 위반이 된다.
 *
 * ★ role은 **쿠키로 되찾은 본인 것 하나만** 내려보낸다 (SPEC §0, §8).
 *   이게 없으면 스파이가 자기가 스파이인 줄 모른 채 한 판이 끝난다 —
 *   "인간 중 한 명은 AI인 척해야 하는 스파이"라는 게임의 절반이 죽는다.
 *   player_roles는 RLS로 전면 차단돼 있어서 이 경로 말고는 알 방법이 없다.
 *
 *   남의 role은 어떤 이유로도 여기서 나가면 안 된다. 정체가 전부 열리는 곳은
 *   /api/reveal 하나뿐이고, 거기는 페이즈까지 확인한다 (SPEC §7.2).
 *   그래서 아래 조회는 player_id로 한 행만 집는다 — room_id로 긁지 않는다.
 */

import type { Role } from '@/lib/game/types';
import { countBots } from '@/lib/server/room';
import { getServiceClient } from '@/lib/server/supabase';
import { ApiError, apiError, currentPlayer } from '@/lib/server/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  try {
    const roomId = new URL(req.url).searchParams.get('room_id');
    if (!roomId) throw new ApiError(400, 'room_id가 없다');

    const me = await currentPlayer(roomId);
    if (!me) {
      return Response.json({
        player: null,
        is_host: false,
        answered: false,
        voted: false,
        role: null,
        bot_count: await countBots(roomId),
      });
    }

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

    // 본인 역할 하나. lobby에서는 아직 배정 전이라 null이다.
    // ★ player_id로 한 행만 집는다. room_id로 긁으면 방 전체 정답이 나온다 (I1).
    const { data: mine } = await db
      .from('player_roles')
      .select('role')
      .eq('player_id', me.id)
      .maybeSingle();

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
      role: (mine?.role as Role | undefined) ?? null,
      // 그 방의 봇 총 수. 자리와 묶이지 않은 집계다 (SPEC §15-3-결정)
      bot_count: await countBots(roomId),
    });
  } catch (e) {
    return apiError(e);
  }
}
