/**
 * 월드 게임 시작. 소유: A (SPEC §18, 2026-08-06 결정)
 *
 * POST /api/room/start-world  { room_id }  →  { room }
 *
 * 2D 시작(/api/room/start)과 달리 **페이즈를 건드리지 않는다** — 월드 판은 DB
 * 상태머신이 아니라 워커가 돌린다 (worker/src/room-do.ts). 여기가 하는 일은
 * startWorldSeats 호출 하나이고, 그 함수가 한 트랜잭션에서 둘을 같이 한다:
 *   1. 사람 + AI 를 1..N+1 로 다시 섞는다 (사람 셋이면 익명1~4).
 *   2. rooms.world_started_at 을 찍는다. 그 UPDATE 가 rooms Realtime 구독으로
 *      대기방 전원에게 전파되고, 대기방 화면이 /world 로 이동한다
 *      (components/room-lobby.tsx). buildWorldRoster 도 이 값을 보고 월드 AI 를
 *      지연 없이 **즉시** 세운다 (lib/server/world-ai.ts).
 *
 * 시작 조건은 2D 와 같다 — **사람 2~8명이고, 방장을 뺀 전원이 준비 완료**여야 한다
 * (lib/game/rules.ts 의 startBlock). 화면의 시작 버튼도 같은 함수를 본다.
 *
 * ┌─ 좌석 셔플이 여기 붙은 이유 (2026-08-08, 보류 해제) ───────────────────────┐
 * │ 2026-08-05 에는 "월드 좌석은 id 가 자리에 묶여 있어(stableUuid) 섞으면 명부  │
 * │ diff 가 깨진다"며 미뤄 두었다. 그 사이 두 가지가 새고 있었다:               │
 * │   · 대기방에서 본 정체가 그대로 이어졌다 (shuffle_seats 가 막던 바로 그것). │
 * │   · 그리고 더 나쁜 쪽 — AI 가 max(자리)+1 에 서므로 **언제나 방에서 제일 큰  │
 * │     번호**였다. 제일 큰 번호만 찍으면 100% 맞는 판이었다 (I1).              │
 * │ diff 걱정은 근거가 없었다. 셔플은 시작 신호보다 **먼저** 커밋되고 그 신호가  │
 * │ 있어야 아무도 /world 로 넘어오지 않는다 — 섞는 순간 월드는 비어 있다.       │
 * │ AI 자리는 시작 때 한 번 정해 world_ai_seats 에 적으므로 그 뒤로 안 움직인다  │
 * │ (stableUuid 도 그대로 안정적이다).                                         │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * 2D 시작이 하는 나머지는 여전히 하지 않는다:
 *   · fillWithBots 없음 — 월드 AI 는 DB 행이 없는 synthetic 이다 (world-ai.ts 머리말).
 *   · 역할 배정 없음 — 연기자는 워커의 startRound 가 뽑는다 (roundtable.ts).
 */

import { START_BLOCK_MESSAGE, startBlock } from '@/lib/game/rules';
import { ROOM_COLUMNS, startWorldSeats } from '@/lib/server/room';
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
     * 사람 2~8명 · 방장 뺀 전원 준비 완료 (2026-08-07 결정, lib/game/rules.ts).
     *
     * ★ **이미 시작된 방에서는 다시 보지 않는다.** 아래 멱등 분기가 그대로 성공을
     *   돌려줘야 한다 — 시작 뒤에 들어온 사람은 준비를 누른 적이 없어서, 여기서
     *   같이 검사하면 재전송 한 번이 409 가 되고 화면이 월드로 못 넘어간다.
     * ★ is_bot = false 만 센다 (I5). 봇을 세면 준비하지 않는 자리 때문에 영영 못 연다.
     * ★ host_id 를 같이 넘긴다. 방장은 준비 대신 이 버튼을 누르는 사람이라
     *   여기서 빠진다 — 안 넘기면 방장 자신 때문에 자기 요청이 409 가 된다.
     */
    if (!room.world_started_at) {
      const { data: humans, error: humansErr } = await db
        .from('players')
        .select('id, is_ready')
        .eq('room_id', roomId)
        .eq('is_bot', false);
      if (humansErr) throw new ApiError(500, `참가자 조회 실패: ${humansErr.message}`);

      const blocked = startBlock(humans as { id: string; is_ready: boolean }[], room.host_id);
      if (blocked) throw new ApiError(409, START_BLOCK_MESSAGE[blocked]);
    }

    /*
     * 섞기 + 시작 신호. 이미 시작된 방이면 아무것도 안 바꾸고 그대로 성공이다 —
     * 멱등 판정은 **DB 안에서** 방을 잠근 채 한다. 여기서 위 `room.world_started_at`
     * 으로 판단하면 두 요청이 나란히 통과해 판 중간에 번호가 다시 섞인다.
     *
     * ★ 반환값(AI 자리 번호)은 받아서 버린다. 응답에 실으면 그게 정답이다 (I1).
     */
    await startWorldSeats(roomId);

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
