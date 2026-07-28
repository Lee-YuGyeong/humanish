/**
 * 워커 전용 — 방의 좌석 명단. 소유: A
 *
 * GET /api/internal/world-room?room_id=...
 *   Authorization: Bearer <WORLD_SHARED_SECRET>
 *   → { capacity, phase, seats: [{ id, seat, nickname, mask_id, is_bot }], bot_lines }
 *
 * ┌─ ★★ 이 경로는 is_bot을 내보내는 유일한 곳이다 (I1의 예외) ─────────────────┐
 * │ 받는 쪽이 **서버(Cloudflare Worker)**이고 브라우저가 아니기 때문에만 성립한다.  │
 * │ 워커는 이 값으로 봇 아바타를 조종할 뿐, 클라이언트로 내보내는 PlayerSnapshot에는 │
 * │ 사람과 봇을 가를 필드가 한 조각도 들어가지 않는다 (lib/mp/protocol.ts).        │
 * │                                                                            │
 * │ 그래서 세 가지를 지킨다.                                                     │
 * │  1. 공유 비밀 없이는 404. "있는데 못 들어간다"는 것조차 알리지 않는다.          │
 * │  2. CORS 헤더를 **주지 않는다.** 브라우저는 응답을 읽을 수 없다.               │
 * │  3. 이 파일을 고칠 때는 반드시 "이게 브라우저로 갈 수 있나"를 먼저 묻는다.      │
 * └────────────────────────────────────────────────────────────────────────────┘
 */

import { timingSafeEqual } from '@/lib/mp/ticket';
import { apiError } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/supabase';

export const dynamic = 'force-dynamic';

/** 비밀이 틀리거나 방이 없거나 — 밖에서는 구분되지 않는다. */
function notFound(): Response {
  return new Response(null, { status: 404 });
}

interface SeatRow {
  id: string;
  seat: number;
  nickname: string;
  is_bot: boolean;
}

export async function GET(req: Request): Promise<Response> {
  try {
    const secret = process.env.WORLD_SHARED_SECRET;
    if (!secret) return notFound();

    const auth = req.headers.get('authorization') ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!timingSafeEqual(bearer, secret)) return notFound();

    const roomId = new URL(req.url).searchParams.get('room_id');
    if (!roomId) return notFound();

    const db = getServiceClient();

    const { data: room } = await db
      .from('rooms')
      .select('id, capacity, phase')
      .eq('id', roomId)
      .maybeSingle();
    if (!room) return notFound();

    // 방 스코프를 반드시 건다 (I10).
    const { data: players } = await db
      .from('players')
      .select('id, seat, nickname, is_bot')
      .eq('room_id', roomId)
      .order('seat', { ascending: true });

    // 봇이 3D 공간에서 던지는 한마디. 문구 풀은 클라이언트에 절대 내려가지 않는다
    // (풀과 대조하면 봇이 즉시 특정된다 — supabase/schema.sql 참고).
    const { data: lines } = await db
      .from('bot_line_pool')
      .select('text')
      .eq('phase', 'chat')
      .limit(80);

    const seats = ((players ?? []) as SeatRow[]).map((p) => ({
      id: p.id,
      seat: p.seat,
      nickname: p.nickname,
      mask_id: `mask-${String(p.seat).padStart(2, '0')}`,
      is_bot: p.is_bot,
    }));

    return Response.json(
      {
        capacity: room.capacity,
        phase: room.phase,
        seats,
        bot_lines: ((lines ?? []) as { text: string }[]).map((l) => l.text),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    return apiError(e);
  }
}
