/**
 * 서버 시각. 소유: A (SPEC §12.5, I2)
 *
 * 클라이언트는 접속할 때 이걸 한 번 받아 오프셋을 계산하고,
 * 모든 카운트다운과 visible_at 비교를 serverNow() = Date.now() + offset으로 한다.
 *
 * ★ 앱 서버의 new Date()를 주면 안 된다. 클라이언트가 이 값으로 맞춘 오프셋을
 *   **DB가 찍은 phase_ends_at**과 비교하기 때문이다. 두 시계는 어긋난다 —
 *   실제로 개발 기계에서 DB가 앱 서버보다 2.26초 앞서 있었고, 그만큼 모든
 *   카운트다운이 밀려 있었다. 기준 시계는 DB 하나다.
 *
 * 판정은 어차피 서버가 하므로 클라이언트 카운트다운은 표시용이다 (I2).
 */

import { getServiceClient } from '@/lib/server/supabase';
import { apiError } from '@/lib/server/auth';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const { data, error } = await getServiceClient().rpc('server_now');
    if (error) throw new Error(`server_now 실패: ${error.message}`);

    return Response.json(
      { now: new Date(data as string).toISOString() },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    return apiError(e);
  }
}
