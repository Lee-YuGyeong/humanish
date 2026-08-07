/**
 * 게임 시작. 소유: A (SPEC §5.1, §8, §13-1)
 *
 * POST /api/room/start  { room_id }  →  { room }
 *
 * 방장만 부를 수 있다. 시작 조건은 **사람 2~8명이고, 방장을 뺀 전원이 준비 완료**다
 * (lib/game/rules.ts 의 startBlock — 화면의 시작 버튼도 같은 함수를 본다).
 *
 * 그다음 순서가 중요하다.
 *   1. AI 자리를 하나 만든다 (SPEC §17.4, 2026-08-06 — 딱 1대다)
 *   2. 전원의 자리·닉네임·가면을 다시 섞는다 (SPEC §15-3-결정)
 *   3. 역할을 배정해 player_roles에 넣는다 — assignRoles는 TS라 DB가 못 부른다 (SPEC §8)
 *   4. advance_phase로 lobby → question
 *
 * 4번은 player_roles가 없으면 거절한다. 그래서 이 라우트를 거치지 않고는 시작할 수 없다.
 */

import { START_BLOCK_MESSAGE, assignRoles, startBlock } from '@/lib/game/rules';
import { advancePhase } from '@/lib/server/phase';
import { ROOM_COLUMNS, fillWithBots, shuffleSeats } from '@/lib/server/room';
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
      .select('id, phase, phase_seq, host_id, world_started_at')
      .eq('id', roomId)
      .single();
    if (roomErr) throw new ApiError(500, `방 조회 실패: ${roomErr.message}`);

    if (room.host_id !== me.id) throw new ApiError(403, '방장만 시작할 수 있다');
    if (room.phase !== 'lobby') throw new ApiError(409, '이미 시작된 방이다');
    // 월드로 시작된 방은 phase 가 lobby 에 남는다 (start-world 머리말). 여기서
    // 2D 상태머신을 겹쳐 돌리면 월드 판 위로 question 전환이 덮친다.
    if (room.world_started_at) throw new ApiError(409, '월드로 시작된 방이다');

    // 0. 사람 2~8명 · 방장 뺀 전원 준비 완료인가 (2026-08-07 결정, lib/game/rules.ts).
    //
    //    ★ 방장은 준비를 누르지 않는다 — 이 라우트를 부르는 것이 그 자리다.
    //      host_id 를 같이 넘겨서 빼지 않으면 방장 자신 때문에 자기 요청이 409 가 된다.
    //    ★ fillWithBots **앞**이어야 한다. 뒤에 두면 거절하기 전에 봇이 이미 앉아버리고,
    //      그 방은 lobby인데 자리가 하나 늘어난 이상한 상태로 남는다.
    //    ★ 준비 상태는 **여기서만** 볼 수 있다. 바로 아래 shuffleSeats 가 is_ready 를
    //      지우므로(§15-3-결정) advance_phase 는 이 조건을 다시 검사하지 못한다.
    //
    //    혼자 시작하면 연기자가 배정되지 않고(사람 2명 이상 조건) 나머지가 AI라
    //    아무나 찍어도 정답이다. 게임의 절반(연기)과 나머지 절반(추리)이 같이 죽는다.
    //    is_bot = false 만 센다 (I5) — 봇을 세면 준비하지 않는 자리 때문에 영영 못 연다.
    const { data: humans, error: humansErr } = await db
      .from('players')
      .select('id, is_ready')
      .eq('room_id', roomId)
      .eq('is_bot', false);
    if (humansErr) throw new ApiError(500, `참가자 조회 실패: ${humansErr.message}`);

    const blocked = startBlock(humans as { id: string; is_ready: boolean }[], room.host_id);
    if (blocked) throw new ApiError(409, START_BLOCK_MESSAGE[blocked]);

    // 1. AI 자리 하나 (딱 1대 — supabase/functions/room.sql 의 fill_with_bots).
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
      .select(ROOM_COLUMNS)
      .eq('id', roomId)
      .single();
    if (afterErr) throw new ApiError(500, `방 조회 실패: ${afterErr.message}`);

    return Response.json({ room: after });
  } catch (e) {
    return apiError(e);
  }
}
