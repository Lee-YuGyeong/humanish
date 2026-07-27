/**
 * 게임 시작. 소유: A (SPEC §5.1, §8, §13-1)
 *
 * POST /api/room/start  { room_id }  →  { room }
 *
 * 방장만 부를 수 있다. 순서가 중요하다.
 *   1. 빈 자리를 봇으로 채운다 (SPEC §17.4)
 *   2. 역할을 배정해 player_roles에 넣는다 — assignRoles는 TS라 DB가 못 부른다 (SPEC §8)
 *   3. advance_phase로 lobby → question
 *
 * 3번은 player_roles가 없으면 거절한다. 그래서 이 라우트를 거치지 않고는 시작할 수 없다.
 */

import { assignRoles } from '@/lib/game/rules';
import type { Role } from '@/lib/game/types';
import { advancePhase } from '@/lib/server/phase';
import { fillWithBots } from '@/lib/server/room';
import { getServiceClient } from '@/lib/server/supabase';
import { ApiError, apiError, readJson, requirePlayer } from '@/lib/server/auth';

interface Body {
  room_id?: string;
}

/**
 * TODO(B): lib/game/rules.ts의 assignRoles가 구현되면 이 함수와 아래 catch를 통째로 지운다.
 *
 * 규칙은 SPEC §8 그대로다. B를 기다리지 않고 게임을 돌리려고 임시로 둔다.
 * 여기 두는 이유: lib/game/은 B 소유라 A가 채우지 않는다 (I7).
 */
function fallbackAssignRoles(isBotBySeat: boolean[], seed: number): Role[] {
  const humanIndexes = isBotBySeat.flatMap((isBot, i) => (isBot ? [] : [i]));
  const spyIndex = humanIndexes.length >= 2 ? humanIndexes[seed % humanIndexes.length] : -1;

  return isBotBySeat.map((isBot, i) => {
    if (isBot) return 'ai';
    return i === spyIndex ? 'spy' : 'citizen';
  });
}

function resolveRoles(isBotBySeat: boolean[], seed: number): Role[] {
  try {
    return assignRoles(isBotBySeat, seed);
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes('미구현')) throw e;
    return fallbackAssignRoles(isBotBySeat, seed);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { room_id: roomId } = await readJson<Body>(req);
    if (!roomId) throw new ApiError(400, 'room_id가 없다');

    const me = await requirePlayer(roomId);
    const db = getServiceClient();

    const { data: room, error: roomErr } = await db
      .from('rooms')
      .select('id, phase, phase_seq, host_id')
      .eq('id', roomId)
      .single();
    if (roomErr) throw new ApiError(500, `방 조회 실패: ${roomErr.message}`);

    if (room.host_id !== me.id) throw new ApiError(403, '방장만 시작할 수 있다');
    if (room.phase !== 'lobby') throw new ApiError(409, '이미 시작된 방이다');

    // 1. 빈 자리를 봇으로. 몇 명 채웠는지는 응답에 싣지 않는다 (I1).
    await fillWithBots(roomId);

    // 2. 역할 배정. seat 순서로 줄 세워 배열의 자리와 플레이어를 맞춘다.
    const { data: players, error: playersErr } = await db
      .from('players')
      .select('id, seat, is_bot')
      .eq('room_id', roomId)
      .order('seat', { ascending: true });
    if (playersErr) throw new ApiError(500, `참가자 조회 실패: ${playersErr.message}`);

    const seed = Math.floor(Math.random() * 2 ** 31);
    const roles = resolveRoles(
      players.map((p) => p.is_bot as boolean),
      seed,
    );
    if (roles.length !== players.length) {
      throw new ApiError(500, `역할 배열 길이가 안 맞는다 (${roles.length} vs ${players.length})`);
    }

    const { error: rolesErr } = await db.from('player_roles').upsert(
      players.map((p, i) => ({ player_id: p.id, room_id: roomId, role: roles[i] })),
      { onConflict: 'player_id' },
    );
    if (rolesErr) throw new ApiError(500, `역할 저장 실패: ${rolesErr.message}`);

    // 3. lobby → question. 여기서 질문과 봇 답변이 만들어진다 (SPEC §5.3)
    const advanced = await advancePhase(roomId, room.phase_seq, me.id);
    if (!advanced) throw new ApiError(409, '다른 사람이 먼저 시작했다');

    const { data: after, error: afterErr } = await db
      .from('rooms')
      .select('id, code, phase, phase_seq, phase_ends_at, round, host_id, roster_seq')
      .eq('id', roomId)
      .single();
    if (afterErr) throw new ApiError(500, `방 조회 실패: ${afterErr.message}`);

    return Response.json({ room: after });
  } catch (e) {
    return apiError(e);
  }
}
