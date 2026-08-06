/**
 * 내 전체 게임 기록, 쪽 단위. 소유: A (SPEC §15-2-결정)
 *
 * GET /api/profile/matches?before=<ISO>  →  MatchHistoryPage (lib/game/types.ts)
 *
 * 기록 화면(/account/history)이 부른다. 로비의 /api/profile/stats 가 최근 다섯
 * 줄만 주는 것과 달리 여기는 끝까지 넘겨 가며 읽는다 — 쪽 크기와 커서 규칙은
 * lib/server/match.ts 의 readMatchHistory 에 있다.
 *
 * ★ /api/profile/stats 와 같은 규칙 — **내 것만 나간다.** user_id 는 쿼리로 받지
 *   않고 쿠키 세션에서 되찾는다 (I9). 인자로 받으면 남의 전적을 세는 창구가 된다:
 *   한 방의 행 수 = 그 방의 사람 수이고, 정원에서 빼면 봇 수가 나온다 (I1).
 */

import { apiError, requireUser } from '@/lib/server/auth';
import { readMatchHistory } from '@/lib/server/match';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  try {
    const user = await requireUser();
    const raw = new URL(req.url).searchParams.get('before');
    // 커서는 서버가 내려보낸 created_at 그대로 돌아온다. 못 읽는 값이면 무시하고
    // 첫 쪽을 준다 — 잘못된 커서로 500 을 내면 기록 화면 전체가 죽는다.
    const before = raw && Number.isFinite(new Date(raw).getTime()) ? raw : null;
    return Response.json(await readMatchHistory(user.id, before));
  } catch (e) {
    return apiError(e);
  }
}
