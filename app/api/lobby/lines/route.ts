/**
 * 대기방에서 누를 수 있는 문구 목록. 소유: A (SPEC §15-3-결정)
 *
 * GET /api/lobby/lines  →  { lines: [{ id, text }], cooldown_sec, max_lines }
 *
 * 화면은 이 목록으로 버튼을 그린다. **버튼 문구를 화면 쪽에 복붙하지 않는다** —
 * 그 순간 화이트리스트가 두 군데로 갈리고, 서버가 모르는 문구를 누르면 409만 뜬다.
 * 목록을 나중에 DB로 옮기더라도 이 라우트의 모양은 그대로다.
 *
 * 방마다 다르지 않고 로그인도 필요 없다. 정적으로 굳어도 되는 유일한 게임 라우트다.
 */

import { LOBBY_LINES, LOBBY_LINE_COOLDOWN_SEC, LOBBY_LINE_MAX } from '@/lib/server/lobby-lines';

export async function GET(): Promise<Response> {
  return Response.json(
    {
      lines: LOBBY_LINES,
      cooldown_sec: LOBBY_LINE_COOLDOWN_SEC,
      max_lines: LOBBY_LINE_MAX,
    },
    { headers: { 'cache-control': 'public, max-age=300' } },
  );
}
