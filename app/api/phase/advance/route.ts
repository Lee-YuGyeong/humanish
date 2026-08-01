/**
 * 페이즈 전환. 소유: A (SPEC §5.2, §12.1, §17.4)
 *
 * POST /api/phase/advance  { room_id, expected_seq }  →  { advanced, room }
 *
 * 호출자는 세 종류지만(SPEC §5.2) 이 라우트를 타는 건 앞의 둘이다.
 *   1. phase_ends_at 만료를 감지한 클라이언트 타이머
 *   2. visibilitychange로 돌아온 클라이언트 (SPEC §12.1)
 *   3. pg_cron sweep — 이건 DB 안에서 직접 돈다. 여기를 지나지 않는다.
 *
 * ★ RPC를 클라이언트에게 직접 열지 않는 이유 (SPEC §5.2):
 *   lobby → question은 방장만 할 수 있는데, actor_id를 인자로 받으면 호출자가
 *   아무 값이나 적을 수 있다. host_id는 rooms로 누구나 읽는다. 그래서 여기서
 *   쿠키의 토큰으로 player_id를 되찾아 넘긴다.
 *
 * expected_seq가 어긋나면 에러가 아니라 advanced:false다. 5명이 동시에 눌러도
 * 첫 호출만 성공하는 게 정상 동작이기 때문이다 (I6).
 */

import { advancePhase } from '@/lib/server/phase';
import { ROOM_COLUMNS } from '@/lib/server/room';
import { getServiceClient } from '@/lib/server/supabase';
import { ApiError, apiError, readJson, requirePlayer } from '@/lib/server/auth';

interface Body {
  room_id?: string;
  expected_seq?: number;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { room_id: roomId, expected_seq: expectedSeq } = await readJson<Body>(req);
    if (!roomId) throw new ApiError(400, 'room_id가 없다');
    if (typeof expectedSeq !== 'number') {
      throw new ApiError(400, 'expected_seq가 없다 — 낙관적 잠금 키다 (I6)');
    }

    const me = await requirePlayer(roomId);
    const advanced = await advancePhase(roomId, expectedSeq, me.id);

    const { data: room, error } = await getServiceClient()
      .from('rooms')
      .select(ROOM_COLUMNS)
      .eq('id', roomId)
      .single();
    if (error) throw new ApiError(500, `방 조회 실패: ${error.message}`);

    return Response.json({ advanced, room });
  } catch (e) {
    return apiError(e);
  }
}
