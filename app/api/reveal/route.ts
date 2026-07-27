/**
 * 결과 공개. 소유: A (SPEC §5.3, §7.2, §13-7, §17.2)
 *
 * GET /api/reveal?room_id=...  →  { players[], votes[], scores, rule }
 *
 * ★ 이 라우트는 게임 전체에서 **유일하게 정체를 내보내는 곳이다.**
 *   player_roles는 RLS로 전면 차단돼 있고(정책 자체가 없다), is_bot은 뷰에서 빠져 있다.
 *   그 둘을 뚫는 통로가 여기 하나뿐이므로 조건을 두 겹으로 건다.
 *
 *     1. 방의 phase가 reveal 또는 replay일 때만  ← 이게 뚫리면 게임이 즉시 끝난다
 *     2. 요청자가 그 방의 플레이어일 때만        ← 남의 방 정답을 볼 이유가 없다
 *
 *   순서가 중요하다. 페이즈 검사를 먼저 통과시키고 나서 데이터를 읽는다.
 *
 * 점수는 여기서 계산한다. calcScores는 lib/game/rules.ts의 순수 함수라
 * DB(plpgsql)가 부를 수 없어서 reveal 훅에서 빼둔 것이다 (SPEC §17.2).
 */

import { calcScores } from '@/lib/game/rules';
import type { Role } from '@/lib/game/types';
import { getServiceClient } from '@/lib/server/supabase';
import { ApiError, apiError, requirePlayer } from '@/lib/server/auth';

export const dynamic = 'force-dynamic';

/**
 * TODO(B): lib/game/rules.ts의 calcScores가 구현되면 이 함수와 아래 catch를 지운다.
 *
 * ★ 이 규칙은 SPEC에 없다. 시그니처만 있고 채점 방식이 정해진 적이 없어서
 *   게임이 끝나는 느낌이 나도록 임시로 정한 것이다. 바꿀 거면 여기와
 *   SCORE_RULE 문구를 같이 고친다 — 화면에 그대로 뜬다.
 *
 *   시민  AI에게 투표했으면 +2   (AI를 찾는 게 목표)
 *   스파이 자신이 받은 표 × 2     (AI로 오해받는 게 목표)
 *   AI    표를 하나도 안 받으면 +3 (안 들키는 게 목표)
 */
export const SCORE_RULE = [
  '시민 — AI에게 투표했으면 +2',
  '스파이 — 자신이 받은 표 하나당 +2',
  'AI — 표를 하나도 안 받으면 +3',
];

function fallbackCalcScores(
  votes: { voterId: string; targetId: string }[],
  roles: Record<string, Role>,
): Record<string, number> {
  const score: Record<string, number> = {};
  for (const id of Object.keys(roles)) score[id] = 0;

  const received: Record<string, number> = {};
  for (const v of votes) received[v.targetId] = (received[v.targetId] ?? 0) + 1;

  for (const v of votes) {
    if (roles[v.voterId] === 'citizen' && roles[v.targetId] === 'ai') score[v.voterId] += 2;
  }
  for (const [id, role] of Object.entries(roles)) {
    if (role === 'spy') score[id] += (received[id] ?? 0) * 2;
    if (role === 'ai' && (received[id] ?? 0) === 0) score[id] += 3;
  }
  return score;
}

function resolveScores(
  votes: { voterId: string; targetId: string }[],
  roles: Record<string, Role>,
): Record<string, number> {
  try {
    return calcScores(votes, roles);
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes('미구현')) throw e;
    return fallbackCalcScores(votes, roles);
  }
}

export async function GET(req: Request): Promise<Response> {
  try {
    const roomId = new URL(req.url).searchParams.get('room_id');
    if (!roomId) throw new ApiError(400, 'room_id가 없다');

    const db = getServiceClient();

    // 1. 페이즈 검사가 먼저다
    const { data: room, error: roomErr } = await db
      .from('rooms')
      .select('id, phase')
      .eq('id', roomId)
      .single();
    if (roomErr) throw new ApiError(500, `방 조회 실패: ${roomErr.message}`);
    if (room.phase !== 'reveal' && room.phase !== 'replay') {
      throw new ApiError(409, '아직 공개할 때가 아니다');
    }

    // 2. 이 방 사람인지
    await requirePlayer(roomId);

    const [{ data: players }, { data: roleRows }, { data: voteRows }] = await Promise.all([
      db.from('players').select('id, nickname, seat, is_bot').eq('room_id', roomId).order('seat'),
      db.from('player_roles').select('player_id, role').eq('room_id', roomId),
      db.from('votes').select('voter_id, target_id, reason').eq('room_id', roomId),
    ]);

    const roles: Record<string, Role> = {};
    for (const r of roleRows ?? []) roles[r.player_id] = r.role as Role;

    const votes = (voteRows ?? []).map((v) => ({ voterId: v.voter_id, targetId: v.target_id }));
    const scores = resolveScores(votes, roles);

    const received: Record<string, number> = {};
    for (const v of votes) received[v.targetId] = (received[v.targetId] ?? 0) + 1;

    return Response.json({
      players: (players ?? []).map((p) => ({
        id: p.id,
        nickname: p.nickname,
        seat: p.seat,
        is_bot: p.is_bot, // ★ 여기서만 나간다. 위 두 검사를 통과한 뒤다
        role: roles[p.id] ?? null,
        votes_received: received[p.id] ?? 0,
        score: scores[p.id] ?? 0,
      })),
      votes: (voteRows ?? []).map((v) => ({
        voter_id: v.voter_id,
        target_id: v.target_id,
        reason: v.reason,
        correct: roles[v.target_id] === 'ai',
      })),
      rule: SCORE_RULE,
    });
  } catch (e) {
    return apiError(e);
  }
}
