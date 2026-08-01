/**
 * 방 만들기 · 대기 중인 방 목록. 소유: A (SPEC §13-1)
 *
 * POST /api/room  { capacity?, name? }  →  { room, player }   (201)
 * GET  /api/room                        →  { rooms: { code, name, capacity, players, created_at, phase }[] }
 *
 * 정원은 3~8에서 고르고 생략하면 5다. 범위 밖이면 400 (lib/server/room.ts).
 * 제목은 1~20자. 생략하거나 공백뿐이면 이름 없는 방(null)이 되고 화면이 코드로 부른다.
 * 목록에는 시작한 방도 들어간다(phase로 구분). 대기 방이 앞, 게임 중인 방이 뒤다.
 * 상태에 따라 **세는 대상이 다르다** — 이유는 listOpenRooms의 주석에 있다 (I1, SPEC §17.6).
 *
 * 토큰은 응답 본문이 아니라 httpOnly 쿠키로 나간다 (SPEC §17.4).
 * 이후 모든 쓰기 라우트가 그 쿠키로 본인을 확인한다.
 */

import { createRoom, listOpenRooms } from '@/lib/server/room';
import { apiError, currentUser, setPlayerCookie } from '@/lib/server/auth';

/** 목록이 캐시되면 방금 만든 방이 안 보인다. */
export const dynamic = 'force-dynamic';

interface Body {
  capacity?: number;
  name?: unknown;
}

/**
 * 본문에서 정원과 제목을 꺼낸다.
 *
 * 본문 없이 POST하는 호출자가 있어서(정원을 기본값으로 두는 경우) readJson을 그대로
 * 쓰지 않는다 — 그건 본문이 JSON이 아니면 400을 던진다. 값 검증은 createRoom이 한다
 * (정원 범위 · 제목 길이와 정화 모두 lib/server/room.ts).
 */
async function readBody(req: Request): Promise<Body> {
  if (req.headers.get('content-length') === '0') return {};
  try {
    return (await req.json()) as Body;
  } catch {
    return {};
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { capacity, name } = await readBody(req);
    // 계정은 쿠키 세션에서 되찾는다. 본문의 값을 쓰지 않는다 (SPEC §15-2-결정, I9).
    const user = await currentUser();
    const { room, player, token } = await createRoom(capacity, name, user?.id ?? null);
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
