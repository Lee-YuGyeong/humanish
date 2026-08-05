/**
 * 끝난 판을 Next 에 알려 전적으로 적게 한다. 소유: A
 *
 * POST {NEXT_ORIGIN}/api/internal/world-match
 *   Authorization: Bearer <WORLD_SHARED_SECRET>
 *   body: { match_id, room_id, winner, seats: [{ id, role }] }
 *
 * ★ seats 에는 **사람 좌석의 연기자 여부**가 실려 있다 — 서버끼리만 오간다
 *   (room-meta.ts 의 is_bot 과 같은 I1 예외). 다만 이 payload 는 reveal 직후에만
 *   나가므로 그 시점엔 어차피 방 전체에 공개된 정보다 (revealSnapshot).
 *
 * ★ 전적은 곁다리다 (SPEC §15-2-결정 — "기록이 실패해도 reveal 응답은 그대로
 *   나간다"). 여기서도 같은 규칙: 실패는 로그만 남기고 삼킨다. 판 진행(reveal
 *   브로드캐스트)이 이 왕복을 기다리지 않는다.
 */

import type { RoundRole, RoundWinner } from '../../lib/mp/protocol';
import type { Env } from './bindings';

export interface MatchReport {
  /** 판의 전적 키 (RoundState.matchId). match_results 의 room_id 자리에 들어간다 */
  matchId: string;
  /** 실제 방. 전적에는 안 적히고 서버 로그 대조용이다 */
  roomId: string;
  winner: RoundWinner;
  /** 판 시작 시점의 **사람** 좌석 전부. 봇은 계정이 없어 애초에 안 보낸다 */
  seats: { id: string; role: Exclude<RoundRole, 'ai'> }[];
}

/** Next가 잠깐 느릴 때 워커 전체가 멈추지 않도록 상한을 둔다 (room-meta 와 동일). */
const TIMEOUT_MS = 4_000;

export async function postMatchReport(env: Env, report: MatchReport): Promise<void> {
  const url = `${env.NEXT_ORIGIN.replace(/\/$/, '')}/api/internal/world-match`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.WORLD_SHARED_SECRET}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        match_id: report.matchId,
        room_id: report.roomId,
        winner: report.winner,
        seats: report.seats,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) console.warn(`[match-report] ${res.status} ${report.roomId}`);
  } catch (e) {
    console.warn(
      `[match-report] 실패 ${report.roomId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
