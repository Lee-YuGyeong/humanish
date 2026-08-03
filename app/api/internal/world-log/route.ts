/**
 * 월드 AI가 한 말을 되읽는다 — **개발 서버 전용**. 소유: A
 *
 * GET /api/internal/world-log?limit=200&room=<uuid>&dropped=1
 *   → { ok, rows: [...] }
 *
 * ┌─ 왜 인증이 아니라 개발 전용인가 ──────────────────────────────────────────┐
 * │ 여기 나가는 건 "어느 방의 어느 자리가 몇 시에 뭐라고 말했나"다. 배포본에서   │
 * │ 이게 열리면 채팅과 대조해 봇을 즉시 특정할 수 있다 (I1) — 공유 비밀을 걸어도  │
 * │ 새는 경로가 하나 더 생기는 건 그대로다. 그래서 프로덕션에서는 **경로 자체가   │
 * │ 없다.** /api/agent 의 ?models=1 과 같은 규약이다.                          │
 * │                                                                          │
 * │ 로컬 개발 서버는 .env.local 로 진짜 Supabase 에 붙으므로, 배포된 월드가 남긴  │
 * │ 기록도 여기서 그대로 읽힌다.                                              │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * CORS 헤더는 주지 않는다. 브라우저 주소창으로 직접 여는 용도다.
 */

import { apiError } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/supabase';

export const dynamic = 'force-dynamic';

const MAX_LIMIT = 500;

export async function GET(req: Request): Promise<Response> {
  try {
    if (process.env.NODE_ENV === 'production') return new Response(null, { status: 404 });

    const url = new URL(req.url);
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, MAX_LIMIT);
    const room = url.searchParams.get('room');
    // 기본값은 **실제로 나간 말만**이다. 버려진 것까지 보려면 dropped=1.
    const withDropped = url.searchParams.get('dropped') === '1';

    let query = getServiceClient()
      .from('world_agent_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (room) query = query.eq('room_id', room);
    if (!withDropped) query = query.is('dropped', null);

    const { data, error } = await query;
    if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

    return Response.json(
      { ok: true, count: data?.length ?? 0, rows: data ?? [] },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    return apiError(e);
  }
}
