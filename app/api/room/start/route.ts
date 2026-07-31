/**
 * 게임 시작. 소유: A (SPEC §5.1, §8, §13-1)
 *
 * POST /api/room/start  { room_id }  →  { room }
 *
 * 방장만 부를 수 있다. 순서가 중요하다.
 *   1. 빈 자리를 봇으로 채운다 (SPEC §17.4)
 *   2. 전원의 자리·닉네임·가면을 다시 섞는다 (SPEC §15-3-결정)
 *   3. 역할을 배정해 player_roles에 넣는다 — assignRoles는 TS라 DB가 못 부른다 (SPEC §8)
 *   4. advance_phase로 lobby → question
 *
 * 4번은 player_roles가 없으면 거절한다. 그래서 이 라우트를 거치지 않고는 시작할 수 없다.
 */

import { assignRoles } from '@/lib/game/rules';
import { advancePhase } from '@/lib/server/phase';
import { MIN_HUMANS_TO_START, fillWithBots, shuffleSeats } from '@/lib/server/room';
import { getServiceClient } from '@/lib/server/supabase';
import { ApiError, apiError, readJson, requirePlayer } from '@/lib/server/auth';

interface Body {
  room_id?: string;
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

    // 0. 사람이 둘 이상인가 (SPEC §8, §17.6).
    //
    //    ★ fillWithBots **앞**이어야 한다. 뒤에 두면 거절하기 전에 봇이 이미 앉아버리고,
    //      그 방은 lobby인데 정원이 찬 이상한 상태로 남는다.
    //
    //    혼자 시작하면 스파이가 배정되지 않고(사람 2명 이상 조건) 나머지가 전부 봇이라
    //    아무나 찍어도 정답이다. 게임의 절반(스파이)과 나머지 절반(추리)이 같이 죽는다.
    const { count: humans, error: humansErr } = await db
      .from('players')
      .select('id', { count: 'exact', head: true })
      .eq('room_id', roomId)
      .eq('is_bot', false);
    if (humansErr) throw new ApiError(500, `참가자 수 조회 실패: ${humansErr.message}`);
    if ((humans ?? 0) < MIN_HUMANS_TO_START) {
      throw new ApiError(409, `사람이 ${MIN_HUMANS_TO_START}명 이상이어야 시작할 수 있다`);
    }

    // 1. 빈 자리를 봇으로.
    await fillWithBots(roomId);

    // 2. 전원의 자리·닉네임·가면을 다시 섞는다 (SPEC §15-3-결정).
    //
    //    ★ 반드시 fillWithBots **뒤**, 아래 참가자 조회 **앞**이어야 한다.
    //      뒤에 두면 역할이 옛 seat 기준으로 배정돼 사람과 역할이 어긋나고,
    //      앞에 두면 봇이 아직 없어서 섞을 대상이 사람뿐이라 아무 효과가 없다.
    //
    //    이게 없으면 로비를 지켜본 사람이 "누가 언제 들어왔는지"를 그대로 들고
    //    게임에 들어간다. 남은 자리가 곧 봇이라 봇 수 공개가 제약이 아니라 답이 된다.
    await shuffleSeats(roomId);

    // 3. 역할 배정. seat 순서로 줄 세워 배열의 자리와 플레이어를 맞춘다.
    const { data: players, error: playersErr } = await db
      .from('players')
      .select('id, seat, is_bot')
      .eq('room_id', roomId)
      .order('seat', { ascending: true });
    if (playersErr) throw new ApiError(500, `참가자 조회 실패: ${playersErr.message}`);

    const seed = Math.floor(Math.random() * 2 ** 31);
    const roles = assignRoles(
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

    // 4. lobby → question. 여기서 질문과 봇 답변이 만들어진다 (SPEC §5.3)
    const advanced = await advancePhase(roomId, room.phase_seq, me.id);
    if (!advanced) throw new ApiError(409, '다른 사람이 먼저 시작했다');

    const { data: after, error: afterErr } = await db
      .from('rooms')
      .select('id, code, capacity, phase, phase_seq, phase_ends_at, round, host_id, roster_seq')
      .eq('id', roomId)
      .single();
    if (afterErr) throw new ApiError(500, `방 조회 실패: ${afterErr.message}`);

    return Response.json({ room: after });
  } catch (e) {
    return apiError(e);
  }
}
