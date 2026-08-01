/**
 * 대기방에서 부를 이름. 소유: A (SPEC §15-2-결정)
 *
 * POST /api/lobby/name  { room_id, name }  →  { ok }
 *
 * ★ **로그인이 필요 없다.** 계정이 있으면 앉을 때 지어둔 이름이 이미 베껴져 있고,
 *   없는 사람은 여기서 그 방에서만 쓸 이름을 친다. 대기방에 절반이 '익명N' 인
 *   상태를 없애는 것이 이 라우트의 존재 이유다.
 *
 *   계정 이름(app/api/profile)과 다른 값이다 — 그쪽은 전체 유니크에 랭킹·친구까지
 *   따라가고, 이쪽은 **이 방 이 판**에서만 산다. 게임이 시작되면 지워진다.
 *
 * ★ player_id 를 받지 않는다. 쿠키의 토큰으로 되찾는다 (I9, SPEC §17.4).
 *   받으면 남의 자리 이름을 바꿀 수 있다.
 */

import { ApiError, apiError, readJson, requirePlayer } from '@/lib/server/auth';
import { setLobbyName } from '@/lib/server/lobby';
import { normalizeDisplayName } from '@/app/api/profile/route';

interface Body {
  room_id?: string;
  /** null 이나 빈 문자열이면 지운다 — '익명N' 으로 돌아간다 */
  name?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { room_id: roomId, name } = await readJson<Body>(req);
    if (!roomId) throw new ApiError(400, 'room_id가 없다');

    /*
     * ★ 계정 이름과 **같은 정화 규칙**을 쓴다 (normalizeDisplayName).
     *   제로폭 공백 하나로 눈에 같아 보이는 이름을 만들 수 있는데, 대기방은
     *   그게 남을 흉내 내는 자리다. 방 안 유니크가 실제로 뜻을 가지려면
     *   여기서 털어야 한다.
     *
     *   빈 값은 "지운다"로 읽는다 — 이름을 되돌릴 방법이 있어야 한다.
     */
    const cleaned =
      name === null || name === undefined || (typeof name === 'string' && !name.trim())
        ? null
        : normalizeDisplayName(name);

    const me = await requirePlayer(roomId);
    await setLobbyName(roomId, me.id, cleaned);

    return Response.json({ ok: true });
  } catch (e) {
    return apiError(e);
  }
}
