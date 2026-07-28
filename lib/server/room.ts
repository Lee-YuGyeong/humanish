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

/**
 * 방 정원의 범위. supabase/functions/room.sql의 default_room_capacity()·room_capacity(),
 * rooms.capacity check, players.seat check와 같아야 한다.
 *
 * 하한이 3인 이유: 사람이 2명 이상일 때만 스파이가 생기고(SPEC §8), 그보다 작으면
 * 투표가 의미를 잃는다. 정원 2인 방은 봇 1 + 사람 1이라 고를 것이 하나뿐이다.
 * 상한이 8인 이유: 좌석 화면이 8칸 기준으로 그려져 있다.
 */
export const MIN_ROOM_CAPACITY = 3;
export const MAX_ROOM_CAPACITY = 8;
/** 아무것도 고르지 않았을 때의 정원. SQL의 default_room_capacity()와 같은 값이다. */
export const DEFAULT_ROOM_CAPACITY = 5;

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

/**
 * Room 하나를 통째로 읽는 컬럼 목록. 화면이 Room 타입으로 받는 곳은 전부 이걸 쓴다.
 * 여기서 capacity를 빠뜨리면 room.capacity가 undefined가 되어 좌석 그리드가 0칸이 된다.
 */
const ROOM_COLUMNS = 'id, code, capacity, phase, phase_seq, phase_ends_at, round, host_id, roster_seq';

async function fetchRoom(roomId: string): Promise<Room> {
  const { data, error } = await getServiceClient()
    .from('rooms')
    .select(ROOM_COLUMNS)
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
 *
 * @param capacity 3~8. 생략하면 SQL 쪽 기본값(DEFAULT_ROOM_CAPACITY)이 들어간다.
 */
export async function createRoom(capacity?: number): Promise<JoinResult> {
  const db = getServiceClient();

  // 범위는 rooms.capacity check로도 막히지만 그건 23514라 500으로 보인다.
  // 사용자가 고른 값이 틀린 것이니 400으로 돌려준다.
  if (capacity !== undefined) {
    if (!Number.isInteger(capacity) || capacity < MIN_ROOM_CAPACITY || capacity > MAX_ROOM_CAPACITY) {
      throw new ApiError(400, `정원은 ${MIN_ROOM_CAPACITY}~${MAX_ROOM_CAPACITY} 사이의 정수다`);
    }
  }

  for (let attempt = 1; attempt <= CODE_RETRY_LIMIT; attempt += 1) {
    const code = generateRoomCode();
    // p_capacity가 null이면 SQL이 default_room_capacity()를 쓴다.
    const { data, error } = await db.rpc('create_room', { p_code: code, p_capacity: capacity ?? null });

    if (!error) {
      const row = (data as SeatRow[])[0];
      return toResult(row, await fetchRoom(row.room_id));
    }
    // SQL이 raise한 것은 사용자에게 그대로 보여줘도 되는 문장이다 (room.sql 참고)
    if (error.code === 'P0001') throw new ApiError(400, error.message);
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
 * **채우는 "시점"은 여전히 시작 버튼이다 (SPEC §15-3).** lobby에서 미리 채우려면
 * 사람이 들어올 때 봇 자리를 넘겨받는 처리가 더 필요해서 열어뒀다.
 *
 * 그래서 **바로 뒤에 shuffleSeats가 붙는다.** 채우기만 하면 로비를 지켜본 사람이
 * "남은 자리 = 봇"을 그대로 안다. 둘은 한 쌍으로 움직인다 (§15-3-결정).
 *
 * @returns 채운 봇 수 (서버 전용)
 */
export async function fillWithBots(roomId: string): Promise<number> {
  const { data, error } = await getServiceClient().rpc('fill_with_bots', { p_room_id: roomId });
  if (error) throw new ApiError(500, `봇 채우기 실패: ${error.message}`);
  return typeof data === 'number' ? data : 0;
}

/**
 * 전원의 자리·닉네임·가면을 무작위 순열로 다시 배정한다 (SPEC §15-3-결정).
 *
 * 대기실에서 본 정체가 게임까지 이어지는 것을 끊는다. **fillWithBots 바로 뒤,
 * 역할 배정 앞에서 부른다** — 순서가 어긋나면 효과가 없거나 역할이 엉킨다.
 * 이유는 supabase/functions/room.sql 의 shuffle_seats 주석에 있다.
 *
 * @returns 다시 배정한 인원 수 (서버 전용)
 */
export async function shuffleSeats(roomId: string): Promise<number> {
  const { data, error } = await getServiceClient().rpc('shuffle_seats', { p_room_id: roomId });
  if (error) throw new ApiError(500, `자리 재배치 실패: ${error.message}`);
  return typeof data === 'number' ? data : 0;
}

/**
 * 그 방의 봇 **총 수**. 0일 수 있다 — 사람이 정원을 다 채운 방이다.
 *
 * ★ 이 값은 공개해도 된다 (SPEC §15-3-결정). 자리와 묶이지 않은 집계라 누구도
 *   특정하지 못한다. **자리별 정보를 곁들이지 않는다** — seat 목록이나 "봇이 앉은
 *   자리"를 함께 내보내는 순간 §15-3이 허용한 범위를 넘어 I1 위반이 된다.
 */
export async function countBots(roomId: string): Promise<number> {
  const { count, error } = await getServiceClient()
    .from('players')
    .select('id', { count: 'exact', head: true })
    .eq('room_id', roomId)
    .eq('is_bot', true);
  if (error) throw new ApiError(500, `봇 수 조회 실패: ${error.message}`);
  return count ?? 0;
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
    .select(ROOM_COLUMNS)
    .eq('code', normalized)
    .maybeSingle();

  if (error) throw new ApiError(500, `방 조회 실패: ${error.message}`);
  if (!data) throw new ApiError(404, `그런 방이 없다: ${normalized}`);
  return data as Room;
}

/** 대기 중인 방 목록의 한 줄. room_id는 넣지 않는다 — 입장은 code로 한다. */
export interface OpenRoom {
  code: string;
  capacity: number;
  /** 지금 앉아 있는 사람 수. lobby라 전부 사람이다 (아래 주석 참고). */
  players: number;
  created_at: string;
}

/** 목록에 한 번에 싣는 방 수. 더 오래된 방은 코드를 직접 입력해 들어간다. */
const OPEN_ROOM_LIMIT = 50;

/**
 * 아직 시작하지 않은(lobby) 방 목록. 화면의 "방 골라 들어가기"가 쓴다.
 *
 * ★ 왜 서버를 거치나: players 테이블은 anon에게 revoke돼 있고(I1), public_players로
 *   방 여러 개를 한꺼번에 세는 건 방 필터 없는 쿼리라 I10 위반이다. 그래서 service role
 *   서버가 세어서 숫자만 내려보낸다.
 *
 * ★ 왜 lobby만: fill_with_bots는 시작 버튼에서 돈다(SPEC §17.4). lobby 단계의 참가자는
 *   전부 사람이라 인원수로 봇을 유추할 수 없다. 시작한 방까지 목록에 올리면, 그 방의
 *   사람 수를 알던 사람이 정원에서 빼서 봇 수를 계산할 수 있다 (I1).
 *   시작한 방은 join_room이 어차피 거절하므로 목록에 있을 이유도 없다.
 */
export async function listOpenRooms(): Promise<OpenRoom[]> {
  const db = getServiceClient();

  const { data: rooms, error } = await db
    .from('rooms')
    .select('id, code, capacity, created_at')
    .eq('phase', 'lobby')
    .order('created_at', { ascending: false })
    .limit(OPEN_ROOM_LIMIT);

  if (error) throw new ApiError(500, `방 목록 조회 실패: ${error.message}`);
  if (!rooms || rooms.length === 0) return [];

  const ids = rooms.map((r) => r.id as string);
  // 방마다 한 번씩 세면 왕복이 50번이다. 목록에 올린 방으로 범위를 좁혀 한 번에 읽고
  // 메모리에서 센다. is_bot은 세는 조건으로만 쓰고 값은 밖으로 내보내지 않는다 (I1).
  //
  // ★ 사람만 센다. "lobby면 아직 봇이 없다"는 것만으로는 부족하다 —
  //   /api/room/start는 fillWithBots를 먼저 커밋하고 몇 번의 왕복 뒤에
  //   advance_phase를 부른다. 그 사이 방은 아직 lobby인데 봇은 이미 앉아 있어서,
  //   3초 폴링이 하필 그 틈에 걸리면 카드가 '2 / 5'에서 '5 / 5'로 바뀌는 게 보이고
  //   그 차이가 곧 봇 수다. 조건 하나로 그 창을 없앤다.
  const { data: seats, error: seatErr } = await db
    .from('players')
    .select('room_id')
    .eq('is_bot', false)
    .in('room_id', ids);

  if (seatErr) throw new ApiError(500, `참가자 수 조회 실패: ${seatErr.message}`);

  const counts = new Map<string, number>();
  for (const s of seats ?? []) {
    const roomId = s.room_id as string;
    counts.set(roomId, (counts.get(roomId) ?? 0) + 1);
  }

  return rooms.map((r) => ({
    code: r.code as string,
    capacity: r.capacity as number,
    players: counts.get(r.id as string) ?? 0,
    created_at: r.created_at as string,
  }));
}
