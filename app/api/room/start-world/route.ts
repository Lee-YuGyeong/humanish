/**
 * 월드 게임 시작. 소유: A (SPEC §18, 2026-08-06 결정)
 *
 * POST /api/room/start-world  { room_id }  →  { room }
 *
 * 2D 시작(/api/room/start)과 달리 **페이즈를 건드리지 않는다** — 월드 판은 DB
 * 상태머신이 아니라 워커가 돌린다 (worker/src/room-do.ts). 여기가 하는 일은
 * 시작 신호 하나다:
 *   1. rooms.world_started_at 을 찍는다. 그 UPDATE 가 rooms Realtime 구독으로
 *      대기방 전원에게 전파되고, 대기방 화면이 /world 로 이동한다
 *      (components/room-lobby.tsx).
 *   2. buildWorldRoster 가 이 값을 보고 빈 좌석을 월드 AI 로 **즉시** 채운다
 *      (lib/server/world-ai.ts — 시작 전에는 지연 합류).
 *
 * 시작 조건은 2D 와 같다 — **사람 2~8명이 전부 준비 완료**여야 한다
 * (lib/game/rules.ts 의 startBlock). 화면의 시작 버튼도 같은 함수를 본다.
 *
 * 2D 시작이 하는 나머지는 전부 하지 않는다:
 *   · fillWithBots 없음 — 월드 AI 는 DB 행이 없는 synthetic 이다 (world-ai.ts 머리말).
 *   · 역할 배정 없음 — 연기자는 워커의 startRound 가 뽑는다 (roundtable.ts).
 *   · shuffleSeats 없음 — 월드 좌석은 id 가 자리에 묶여 있어(stableUuid) 섞으면
 *     명부 diff 가 깨진다. 대기방 관찰이 판으로 이어지는 문제는 좌석 셔플 재논의와
 *     함께 다룬다 (보류 — 2026-08-05).
 */

import { START_BLOCK_MESSAGE, startBlock } from '@/lib/game/rules';
import { ROOM_COLUMNS } from '@/lib/server/room';
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
      .select('id, phase, host_id, world_started_at')
      .eq('id', roomId)
      .single();
    if (roomErr) throw new ApiError(500, `방 조회 실패: ${roomErr.message}`);

    if (room.host_id !== me.id) throw new ApiError(403, '방장만 시작할 수 있다');
    // 2D 상태머신이 이미 돌기 시작한 방이다. 월드를 겹쳐 열면 두 게임이 된다.
    if (room.phase !== 'lobby') throw new ApiError(409, '이미 시작된 방이다');

    /*
     * 사람 2~8명 · 전원 준비 완료 (2026-08-06 결정, lib/game/rules.ts).
     *
     * ★ **이미 시작된 방에서는 다시 보지 않는다.** 아래 멱등 분기가 그대로 성공을
     *   돌려줘야 한다 — 시작 뒤에 들어온 사람은 준비를 누른 적이 없어서, 여기서
     *   같이 검사하면 재전송 한 번이 409 가 되고 화면이 월드로 못 넘어간다.
     * ★ is_bot = false 만 센다 (I5). 봇을 세면 준비하지 않는 자리 때문에 영영 못 연다.
     */
    if (!room.world_started_at) {
      const { data: humans, error: humansErr } = await db
        .from('players')
        .select('is_ready')
        .eq('room_id', roomId)
        .eq('is_bot', false);
      if (humansErr) throw new ApiError(500, `참가자 조회 실패: ${humansErr.message}`);

      const blocked = startBlock(humans as { is_ready: boolean }[]);
      if (blocked) throw new ApiError(409, START_BLOCK_MESSAGE[blocked]);
    }

    /*
     * 이미 찍혀 있으면 그대로 성공이다 (멱등). 연타·재전송이 와도 시각이 두 번
     * 바뀌지 않게 `is null` 조건으로 첫 요청만 쓴다 — 시각이 흔들리면
     * 월드 AI 채움 기준(world-ai.ts)이 조회마다 달라질 수 있다.
     */
    if (!room.world_started_at) {
      const { error: startErr } = await db
        .from('rooms')
        .update({ world_started_at: new Date().toISOString() })
        .eq('id', roomId)
        .is('world_started_at', null);
      if (startErr) throw new ApiError(500, `시작 기록 실패: ${startErr.message}`);
    }

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
