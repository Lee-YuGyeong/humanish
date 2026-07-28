/**
 * 워커 진입점 — 라우팅만 한다. 소유: A
 *
 *   wss://<worker>/rooms/<room_id>/ws?t=<티켓>&v=<프로토콜버전>   방 접속
 *   https://<worker>/rooms/<room_id>/info                        로비용 요약
 *   https://<worker>/health                                      배포 확인
 *
 * room_id는 rooms.id(uuid)다. **방 코드(4자)를 쓰지 않는다** — 코드는 추측 가능하고
 * 방이 정리되면 재사용된다 (SPEC §6.3, §16.4).
 *
 * idFromName(room_id)가 같으면 전 세계 어디서 접속해도 같은 DO 인스턴스로 모인다.
 * 방 목록 테이블도, 룸 서버 오케스트레이션도 필요 없다.
 */

import { RoomDO } from './room-do';
import type { Env } from './bindings';

export { RoomDO };
export type { Env };

/** uuid 형태만 받는다. 아무 문자열이나 받으면 DO가 무한히 생성된다. */
const ROOM_PATH =
  /^\/rooms\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(ws|info)$/i;

/** 브라우저는 WebSocket에 CORS를 적용하지 않는다. /info(일반 fetch)에만 필요하다. */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (url.pathname === '/health') {
      return new Response('ok', { headers: CORS });
    }

    const match = ROOM_PATH.exec(url.pathname);
    if (!match) return new Response('not found', { status: 404, headers: CORS });

    // 대소문자가 다르면 다른 DO가 된다. 항상 소문자로 맞춘다 (DO 쪽도 같이 내린다).
    const roomId = match[1].toLowerCase();
    const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));

    // 요청을 **그대로** 넘긴다. Upgrade 헤더가 붙은 Request는 다시 만들 수 없다.
    return stub.fetch(request);
  },
};
