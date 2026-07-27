/**
 * 방 생성 · 입장. 소유: A (SPEC §2, §13-1)
 *
 * 모든 쓰기는 service role로 수행한다 (supabase/policies.sql 전제 참고, I9).
 * 좌석 배정은 경쟁 조건이 있어 SQL 함수 안에서 원자적으로 한다
 * (`supabase/functions/room.sql`).
 */

import { getServiceClient } from '@/lib/server/supabase';
import { ApiError } from '@/lib/server/auth';
import type { PublicPlayer, Room } from '@/lib/game/types';

/** 방 정원. supabase/functions/room.sql의 room_capacity(), players.seat 제약과 같아야 한다. */
export const ROOM_CAPACITY = 5;

/** 4자 대문자 코드. I·O·0·1처럼 헷갈리는 글자는 뺀다. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/** 코드 충돌 시 재시도 횟수 (SPEC §16.4). 24^4 = 331,776가지라 충돌이 실제로 난다. */
export const CODE_RETRY_LIMIT = 5;

export function generateRoomCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  // 256 % 24 = 16이라 앞 16글자가 약간 더 자주 나온다. 방 코드에는 무해한 정도다.
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** SQL 함수들이 돌려주는 모양 (room.sql의 returns table). */
interface SeatRow {
  room_id: string;
  player_id: string;
  player_token: string;
  seat: number;
  nickname: string;
}

/** 입장 결과. token은 쿠키로만 나가고 응답 본문에는 실지 않는다 (SPEC §17.4). */
export interface JoinResult {
  room: Room;
  player: PublicPlayer;
  token: string;
}

/** 코드 unique 위반 */
const UNIQUE_VIOLATION = '23505';

async function fetchRoom(roomId: string): Promise<Room> {
  const { data, error } = await getServiceClient()
    .from('rooms')
    .select('id, code, phase, phase_seq, phase_ends_at, round, host_id, roster_seq')
    .eq('id', roomId)
    .single();

  if (error) throw new ApiError(500, `방 조회 실패: ${error.message}`);
  return data as Room;
}

function toResult(row: SeatRow, room: Room): JoinResult {
  return {
    room,
    player: {
      id: row.player_id,
      room_id: row.room_id,
      nickname: row.nickname,
      mask_id: `mask-${String(row.seat).padStart(2, '0')}`,
      seat: row.seat,
      connected: true,
    },
    token: row.player_token,
  };
}

/**
 * 방을 만들고 만든 사람을 방장으로 앉힌다.
 * 코드가 겹치면 다른 코드로 CODE_RETRY_LIMIT회까지 다시 시도한다 (SPEC §16.4, §14.4).
 */
export async function createRoom(): Promise<JoinResult> {
  const db = getServiceClient();

  for (let attempt = 1; attempt <= CODE_RETRY_LIMIT; attempt += 1) {
    const code = generateRoomCode();
    const { data, error } = await db.rpc('create_room', { p_code: code });

    if (!error) {
      const row = (data as SeatRow[])[0];
      return toResult(row, await fetchRoom(row.room_id));
    }
    // 코드가 겹쳤을 때만 다시 돈다. 다른 에러는 그대로 올린다.
    if (error.code !== UNIQUE_VIOLATION) {
      throw new ApiError(500, `방 생성 실패: ${error.message}`);
    }
  }

  throw new ApiError(503, `방 코드를 ${CODE_RETRY_LIMIT}번 뽑았는데 전부 겹쳤다. 잠시 후 다시 시도할 것`);
}

/**
 * 코드로 방을 찾아 빈 자리에 앉힌다.
 * 정원 초과나 이미 시작된 방이면 SQL 쪽에서 거절한다.
 */
export async function joinRoom(code: string): Promise<JoinResult> {
  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(normalized)) {
    throw new ApiError(400, '방 코드는 알파벳 4자다');
  }

  const { data, error } = await getServiceClient().rpc('join_room', { p_code: normalized });

  if (error) {
    // SQL이 raise한 것은 사용자에게 그대로 보여줘도 되는 문장이다 (room.sql 참고)
    if (error.code === 'P0002') throw new ApiError(404, error.message);
    if (error.code === 'P0001') throw new ApiError(409, error.message);
    throw new ApiError(500, `입장 실패: ${error.message}`);
  }

  const row = (data as SeatRow[])[0];
  return toResult(row, await fetchRoom(row.room_id));
}

/**
 * 빈 자리를 봇으로 채운다. lobby → question 직전에 한 번 부른다.
 *
 * **몇 명을 채웠는지는 클라이언트에 절대 알리지 않는다 (I1).** 반환값은 서버 로그용이다.
 * 자리는 무작위로 고른다 — 순서대로 채우면 봇이 늘 뒷자리에 몰려 seat만 보고 골라낼 수
 * 있다 (SPEC §17.4). created_at도 같은 이유로 public_players 뷰에서 뺐다 (§7.2).
 *
 * **채우는 "시점"은 아직 미결정이다 (SPEC §15-3).** 지금은 시작 버튼을 누른 순간이라,
 * lobby 인원이 2명이었다가 5명이 되는 걸로 봇이 3명임을 알 수 있다. lobby에서 미리
 * 채우려면 사람이 들어올 때 봇 자리를 넘겨받는 처리가 더 필요하다.
 *
 * @returns 채운 봇 수 (서버 전용)
 */
export async function fillWithBots(roomId: string): Promise<number> {
  const { data, error } = await getServiceClient().rpc('fill_with_bots', { p_room_id: roomId });
  if (error) throw new ApiError(500, `봇 채우기 실패: ${error.message}`);
  return typeof data === 'number' ? data : 0;
}

/**
 * 끝난 방 정리 (SPEC §16.4). **평소에는 pg_cron이 매시 정각에 DB 안에서 직접 부른다**
 * (`supabase/functions/advance_phase.sql`의 `cron.schedule('room-cleanup', ...)`).
 * 안 하면 코드가 계속 점유되고 워치독 스캔 대상으로도 남는다.
 *
 * replay 방은 아직 지우지 않는다 — replay가 같은 방 재시작인지 새 방인지가
 * 미결정이라(SPEC §15-5), 지금 지우면 재시작이 깨진다.
 *
 * @returns 지운 방 수
 */
export async function cleanupStaleRooms(): Promise<number> {
  const { data, error } = await getServiceClient().rpc('cleanup_stale_rooms', {});
  if (error) throw new ApiError(500, `cleanup_stale_rooms 실패: ${error.message}`);
  return typeof data === 'number' ? data : 0;
}

/** 방 코드로 방을 찾는다. 없으면 404. 화면이 방 id를 알아내는 통로다. */
export async function findRoomByCode(code: string): Promise<Room> {
  const normalized = code.trim().toUpperCase();
  const { data, error } = await getServiceClient()
    .from('rooms')
    .select('id, code, phase, phase_seq, phase_ends_at, round, host_id, roster_seq')
    .eq('code', normalized)
    .maybeSingle();

  if (error) throw new ApiError(500, `방 조회 실패: ${error.message}`);
  if (!data) throw new ApiError(404, `그런 방이 없다: ${normalized}`);
  return data as Room;
}
