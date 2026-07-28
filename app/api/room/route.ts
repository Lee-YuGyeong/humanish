/**
 * 방 만들기 · 대기 중인 방 목록. 소유: A (SPEC §13-1)
 *
 * POST /api/room  { capacity? }  →  { room, player }   (201)
 * GET  /api/room                 →  { rooms: { code, capacity, players, created_at }[] }
 *
 * 정원은 3~8에서 고르고 생략하면 5다. 범위 밖이면 400 (lib/server/room.ts).
 * 목록은 phase='lobby'인 방만 내려보낸다 — 이유는 listOpenRooms의 주석에 있다 (I1).
 *
 * 토큰은 응답 본문이 아니라 httpOnly 쿠키로 나간다 (SPEC §17.4).
 * 이후 모든 쓰기 라우트가 그 쿠키로 본인을 확인한다.
 */

import { createRoom, listOpenRooms } from '@/lib/server/room';
import { apiError, setPlayerCookie } from '@/lib/server/auth';

/** 목록이 캐시되면 방금 만든 방이 안 보인다. */
export const dynamic = 'force-dynamic';

interface Body {
  capacity?: number;
}

/**
 * 본문에서 정원만 꺼낸다.
 *
 * 본문 없이 POST하는 호출자가 있어서(정원을 기본값으로 두는 경우) readJson을 그대로
 * 쓰지 않는다 — 그건 본문이 JSON이 아니면 400을 던진다. 값 검증은 createRoom이 한다.
 */
async function readCapacity(req: Request): Promise<number | undefined> {
  if (req.headers.get('content-length') === '0') return undefined;
  try {
    return ((await req.json()) as Body).capacity;
  } catch {
    return undefined;
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const capacity = await readCapacity(req);
    const { room, player, token } = await createRoom(capacity);
    await setPlayerCookie(room.id, token);
    return Response.json({ room, player }, { status: 201 });
  } catch (e) {
    return apiError(e);
  }
}

export async function GET(): Promise<Response> {
  try {
    const rooms = await listOpenRooms();
    return Response.json({ rooms }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return apiError(e);
  }
}
