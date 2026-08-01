/**
 * 내 전적. 소유: A (SPEC §15-2-결정 「아직 안 한 것」)
 *
 * GET /api/profile/stats  →  ProfileStats (lib/server/stats.ts)
 *
 * 로비 왼쪽 기둥의 레벨 · EXP · 승률 · 판수 · 최근 게임이 전부 이 하나에서 온다.
 * 원래 그 자리는 목 데이터였다 (app/main/mock-lobby.ts 의 recentGames — 지웠다).
 *
 * ★ **내 것만 나간다.** user_id 는 본문이나 쿼리에서 받지 않고 쿠키 세션에서
 *   되찾는다 (I9). 인자로 받으면 남의 전적을 세는 창구가 된다 — 그러면 한 방의
 *   행 수로 그 방에 사람이 몇이었는지가 나오고, 정원에서 빼면 봇 수가 나온다 (I1).
 *
 * ★ 익명 계정에도 전적은 있을 수 있다 (players.user_id 는 로그인 여부와 무관하게
 *   찍힌다). 이름이 없을 뿐이라 여기서 프로필을 요구하지 않는다.
 */

import { apiError, requireUser } from '@/lib/server/auth';
import { readMatchStats } from '@/lib/server/match';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const user = await requireUser();
    return Response.json(await readMatchStats(user.id));
  } catch (e) {
    return apiError(e);
  }
}
