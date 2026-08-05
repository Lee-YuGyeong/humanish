/**
 * 워커 전용 — 끝난 월드 판을 전적으로 적는다. 소유: A
 *
 * POST /api/internal/world-match
 *   Authorization: Bearer <WORLD_SHARED_SECRET>
 *   body: { match_id, room_id, winner, seats: [{ id, role }] }
 *   → { ok: true, recorded: n }
 *
 * 보내는 쪽은 worker/src/match-report.ts (reveal 진입 틱에 한 번). 여기서 하는 일은
 * 둘뿐이다 — player id 를 계정(user_id)으로 되찾고, recordWorldMatch 에 넘긴다.
 * 승패·점수 규칙은 lib/server/match.ts 의 buildWorldMatchRows 가 갖고 있다.
 *
 * ┌─ I1 점검 ──────────────────────────────────────────────────────────────────┐
 * │ 들어오는 payload 에는 "누가 연기자였나"가 있지만 reveal 직후라 이미 방 전체에  │
 * │ 공개된 정보고, 받는 쪽이 서버다. **나가는 응답에는 숫자 하나뿐이다.**          │
 * │ world-room 과 같은 세 규칙: 비밀 없이는 404 · CORS 없음 · 고칠 때마다         │
 * │ "이게 브라우저로 갈 수 있나"를 먼저 묻는다.                                  │
 * └────────────────────────────────────────────────────────────────────────────┘
 */

import { timingSafeEqual } from '@/lib/mp/ticket';
import { apiError } from '@/lib/server/auth';
import { recordWorldMatch, type WorldMatchSeat } from '@/lib/server/match';
import { getServiceClient } from '@/lib/server/supabase';

export const dynamic = 'force-dynamic';

/** 비밀이 틀리거나 몸이 안 맞거나 — 밖에서는 구분되지 않는다 (world-room 과 동일). */
function notFound(): Response {
  return new Response(null, { status: 404 });
}

/** match_id 는 그대로 uuid 컬럼(match_results.room_id)에 들어간다. 모양부터 거른다. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 좌석 상한(10)보다 넉넉한 방어선. 이보다 크면 워커가 보낸 게 아니다. */
const MAX_SEATS = 16;

export async function POST(req: Request): Promise<Response> {
  try {
    const secret = process.env.WORLD_SHARED_SECRET;
    if (!secret) return notFound();

    const auth = req.headers.get('authorization') ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!timingSafeEqual(bearer, secret)) return notFound();

    const body = (await req.json().catch(() => null)) as {
      match_id?: unknown;
      room_id?: unknown;
      winner?: unknown;
      seats?: unknown;
    } | null;
    if (!body) return notFound();

    const matchId = typeof body.match_id === 'string' ? body.match_id : '';
    const winner = body.winner;
    if (!UUID_RE.test(matchId)) return notFound();
    if (winner !== 'citizen' && winner !== 'actor' && winner !== 'ai') return notFound();
    if (!Array.isArray(body.seats) || body.seats.length > MAX_SEATS) return notFound();

    const seats: { id: string; role: 'citizen' | 'actor' }[] = [];
    for (const raw of body.seats) {
      const seat = raw as { id?: unknown; role?: unknown };
      if (typeof seat.id !== 'string') return notFound();
      if (seat.role !== 'citizen' && seat.role !== 'actor') return notFound();
      seats.push({ id: seat.id, role: seat.role });
    }

    // player id → 계정. 못 찾은 좌석도 **사람 수에는 남긴다** (userId null 행은
    // buildWorldMatchRows 가 거른다) — 분모가 줄면 2인 판이 혼자 판으로 접힌다.
    const { data: players, error } = await getServiceClient()
      .from('players')
      .select('id, user_id, is_bot')
      .in(
        'id',
        seats.map((s) => s.id),
      );
    if (error) throw new Error(`좌석 조회 실패: ${error.message}`);

    const accounts = new Map<string, string | null>();
    for (const p of (players ?? []) as { id: string; user_id: string | null; is_bot: boolean }[]) {
      // 봇이 여기 오면 워커의 humanIds 가 깨진 것이다. 행을 만들지 않는 것으로 막는다
      // (봇에게는 user_id 가 없어서 어차피 걸러지지만, I1 은 두 겹으로 지킨다).
      accounts.set(p.id, p.is_bot ? null : p.user_id);
    }

    const matchSeats: WorldMatchSeat[] = seats.map((s) => ({
      userId: accounts.get(s.id) ?? null,
      role: s.role,
    }));

    await recordWorldMatch(matchId, winner, matchSeats);

    const recorded = matchSeats.filter((s) => s.userId).length;
    console.log(`[world-match] ${String(body.room_id)} → ${winner}, ${recorded}명 기록`);
    return Response.json({ ok: true, recorded }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return apiError(e);
  }
}
