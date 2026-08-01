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
 *
 * ★ **전적도 여기서 적힌다** (SPEC §15-2-결정 「아직 안 한 것」). 점수가 나오는
 *   자리가 여기 하나뿐이라 같은 이유로 여기에 붙었다. lib/server/match.ts 참고 —
 *   한 판은 한 번만 적히고, 실패해도 결과 화면은 그대로 뜬다.
 */

import { SCORE_RULE, calcScores, humanVotesReceived } from '@/lib/game/rules';
import type { Role } from '@/lib/game/types';
import { recordMatch } from '@/lib/server/match';
import { getServiceClient } from '@/lib/server/supabase';
import { ApiError, apiError, requirePlayer } from '@/lib/server/auth';

export const dynamic = 'force-dynamic';

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
      /*
       * ★ user_id 를 함께 읽지만 **응답에는 넣지 않는다** (I1, §15-2-결정).
       *   봇에게는 계정이 없어서 user_id 가 null 인 자리가 곧 봇 명단이다.
       *   아래 map 이 내보낼 필드를 하나씩 적는 이유가 이것이다 — 전개(...p)로
       *   바꾸는 순간 샌다. 이 값은 전적을 적는 데만 쓰고 함수 안에서 끝난다.
       */
      db
        .from('players')
        .select('id, nickname, seat, is_bot, user_id')
        .eq('room_id', roomId)
        .order('seat'),
      db.from('player_roles').select('player_id, role').eq('room_id', roomId),
      db.from('votes').select('voter_id, target_id, reason').eq('room_id', roomId),
    ]);

    const roles: Record<string, Role> = {};
    for (const r of roleRows ?? []) roles[r.player_id] = r.role as Role;

    const votes = (voteRows ?? []).map((v) => ({ voterId: v.voter_id, targetId: v.target_id }));
    const scores = calcScores(votes, roles);

    const received: Record<string, number> = {};
    for (const v of votes) received[v.targetId] = (received[v.targetId] ?? 0) + 1;

    // ★ 점수는 **사람 표만** 센다 (SCORE_RULE 참고). 그래서 받은 표 수를 두 가지로 준다 —
    //   전체(votes_received)만 주면 결과 화면이 "3표 받았는데 왜 0점?"이 되고,
    //   사람 표(human_votes_received)만 주면 봇이 몇 표 던졌는지가 안 보인다.
    const humanReceived = humanVotesReceived(votes, roles);

    /*
     * 전적을 적는다 (SPEC §15-2-결정). 사람이 2명 미만인 방은 recordMatch 가 거른다.
     * 같은 판을 여러 사람이 열어도 기본키가 두 번째부터 무시한다.
     *
     * ★ **응답 뒤로 미루지 않는다.** 배포처는 Cloudflare Workers 인데, 거기서는
     *   응답을 돌려준 순간 요청 컨텍스트가 끝나고 붙들지 않은 약속은 그냥 죽는다
     *   (waitUntil 없이). 로컬 Node 에서는 되고 배포본에서만 전적이 안 쌓이는 —
     *   화면에는 아무 에러도 안 뜨는 종류의 고장이 된다. 자리 8개짜리 upsert 하나라
     *   기다려도 결과 화면이 늦어지지 않는다.
     *
     * ★ 대신 실패를 삼킨다. 전적은 곁다리고 결과 화면은 게임의 마지막 장면이라,
     *   기록이 안 됐다고 정답 공개가 500이 되면 안 된다.
     */
    await recordMatch(
      roomId,
      (players ?? []).map((p) => ({
        userId: p.user_id ?? null,
        isBot: p.is_bot,
        role: roles[p.id] ?? null,
        score: scores[p.id] ?? 0,
      })),
    ).catch((e: unknown) => {
      console.error('[reveal] 전적 기록 실패', e);
    });

    return Response.json({
      players: (players ?? []).map((p) => ({
        id: p.id,
        nickname: p.nickname,
        seat: p.seat,
        is_bot: p.is_bot, // ★ 여기서만 나간다. 위 두 검사를 통과한 뒤다
        role: roles[p.id] ?? null,
        votes_received: received[p.id] ?? 0,
        /** 그중 사람이 던진 표. 점수는 이쪽만 본다 */
        human_votes_received: humanReceived[p.id] ?? 0,
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
