/**
 * 서버 시각. 소유: A (SPEC §12.5)
 *
 * 클라이언트는 접속할 때 이걸 한 번 받아 오프셋을 계산하고,
 * 모든 카운트다운과 visible_at 비교를 serverNow() = Date.now() + offset으로 한다.
 *
 * 판정은 어차피 서버가 하므로 클라이언트 카운트다운은 표시용이다 (I2).
 * 이게 없으면 시계가 3초 빠른 사람만 화면이 먼저 넘어간다.
 */

export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json(
    { now: new Date().toISOString() },
    { headers: { 'cache-control': 'no-store' } },
  );
}
