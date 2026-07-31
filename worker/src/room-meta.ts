/**
 * 방 좌석 명단을 Next에서 가져온다. 소유: A
 *
 * ★ 이 응답에는 is_bot이 들어 있다 — **서버끼리만** 오간다 (I1의 예외).
 *   app/api/internal/world-room/route.ts 머리말의 세 가지 규칙과 짝이다.
 *   여기서 받은 is_bot은 봇 조종에만 쓰고, 클라이언트로 나가는 PlayerSnapshot에는
 *   사람과 봇을 가를 필드를 절대 넣지 않는다.
 *
 * 워커는 이 경로가 죽어도 캐시로 버틴다(room-do.ts의 ensureMeta). 그래서 여기서는
 * 실패를 던지지 않고 null을 돌려준다.
 */

import type { Env } from './bindings';

export interface SeatRow {
  id: string;
  seat: number;
  nickname: string;
  mask_id: string;
  /** ★ 서버 전용 */
  is_bot: boolean;
}

export interface RoomMeta {
  capacity: number;
  phase: string | null;
  seats: SeatRow[];
  /** 봇이 3D 공간에서 던지는 한마디 풀. 클라이언트로 절대 나가지 않는다 */
  botLines: string[];
  /**
   * 게임이 아직 안 돌아가는 방인가 (= 월드 AI 만 서 있다).
   * 대화 성향을 가른다 — 게임 중 봇은 아껴 말하고, 동행자는 잘 대꾸한다.
   */
  companionMode: boolean;
}

/** Next가 잠깐 느릴 때 워커 전체가 멈추지 않도록 상한을 둔다. */
const TIMEOUT_MS = 4_000;

export async function fetchRoomMeta(env: Env, roomId: string): Promise<RoomMeta | null> {
  const url = `${env.NEXT_ORIGIN.replace(/\/$/, '')}/api/internal/world-room?room_id=${encodeURIComponent(roomId)}`;

  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${env.WORLD_SHARED_SECRET}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[room-meta] ${res.status} ${roomId}`);
      return null;
    }

    const body = (await res.json()) as {
      capacity?: number;
      phase?: string | null;
      seats?: SeatRow[];
      bot_lines?: string[];
      companion_mode?: boolean;
    };
    if (typeof body.capacity !== 'number' || !Array.isArray(body.seats)) return null;

    return {
      capacity: body.capacity,
      phase: body.phase ?? null,
      seats: body.seats,
      botLines: Array.isArray(body.bot_lines) ? body.bot_lines : [],
      companionMode: body.companion_mode === true,
    };
  } catch (e) {
    console.warn(`[room-meta] 실패 ${roomId}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
