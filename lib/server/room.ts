/**
 * 방 생성 · 입장. 소유: A (SPEC §2, §13-1)
 *
 * 모든 쓰기는 service role로 수행한다 (supabase/policies.sql 전제 참고, I9).
 * 좌석 배정은 경쟁 조건이 있어 SQL 함수 안에서 원자적으로 한다
 * (`supabase/functions/room.sql`).
 */

import { getServiceClient } from '@/lib/server/supabase';
import { ApiError } from '@/lib/server/auth';
import type { Phase, PublicPlayer, Room } from '@/lib/game/types';

/*
 * 정원 범위(MIN/MAX/DEFAULT_ROOM_CAPACITY)는 2026-08-06 에 없앴다.
 * **방마다 고르지 않는다** — 사람 정원은 전부 8이고, 그 값은 SQL 의
 * default_room_capacity() 하나에서 온다 (supabase/functions/room.sql).
 * 화면이 알아야 할 수는 lib/game/rules.ts 의 MAX_HUMANS_PER_ROOM 이다 —
 * 그쪽은 순수 모듈이라 클라이언트도 그대로 읽는다(여기는 service role 키를 쥐고
 * 있어 못 간다). 정원 복사본이 화면마다 흩어져 있던 문제가 같이 사라졌다.
 */

/**
 * 방 제목 길이 상한. rooms.name 체크 제약(1~20)과 같아야 한다.
 *
 * ★ 여기서 세는 것은 JS 문자열 길이(UTF-16 단위)이고 Postgres는 코드포인트를 센다.
 *   이모지처럼 서로게이트 쌍인 글자는 JS에서 2, PG에서 1이라 **여기가 항상 더 엄격하다.**
 *   즉 여기를 통과하면 제약에는 절대 안 걸린다. 반대였다면 23514가 500으로 튀었을 것이다.
 */
export const MAX_ROOM_NAME_LEN = 20;

/**
 * 방 제목을 다듬는다. 순수 함수다 (tests/lib/server/room-name.test.ts).
 *
 * ┌─ 왜 그냥 trim 이 아닌가 ───────────────────────────────────────────────────┐
 * │ 방 제목은 **남이 만든 문자열이 내 화면의 목록에 섞여 들어오는 유일한 통로**  │
 * │ 다. 그래서 보이지 않는 글자를 턴다.                                        │
 * │                                                                           │
 * │  · \p{Cc} 제어문자 — 줄바꿈·탭. 한 줄짜리 자리에 두 줄이 들어오면 목록의    │
 * │    줄 높이가 방마다 달라진다. **지우지 않고 공백으로 바꾼다** — 아래 참고.   │
 * │  · \p{Cf} 서식문자 — 이쪽이 진짜 이유다. U+202E(RLO) 하나면 제목이 거꾸로   │
 * │    렌더되고, U+200B(ZWSP)를 끼우면 눈으로 똑같은 제목을 얼마든지 만들 수    │
 * │    있다. 남을 사칭하는 방을 만드는 가장 싼 방법이다. 이건 **지운다** —      │
 * │    글자 사이에 끼우라고 있는 것이라 공백으로 바꾸면 없던 띄어쓰기가 생긴다. │
 * │                                                                           │
 * │ 대가: 이모지 결합(👨‍👩‍👦)이 낱개로 흩어진다. 20자짜리 방 제목에서 치를 만한  │
 * │ 값이라고 봤다.                                                            │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * @returns 이름이 없으면 null. **빈 문자열은 절대 돌려주지 않는다** — 그 두 가지가
 *          다 존재하면 "이름이 있는데 안 보이는" 방이 생긴다 (lib/game/types.ts).
 * @throws  ApiError(400) 길이가 넘칠 때. 화면은 maxLength로 이미 막지만 그건 브라우저뿐이다.
 */
export function normalizeRoomName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  const cleaned = raw
    /*
     * ★ 제일 먼저 NFC 로 합친다. 길이를 **재기 전에** 해야 한다.
     *
     * 한글은 같은 글자를 두 가지로 적을 수 있다. 키보드로 친 '한'은 합쳐진 한 글자
     * (U+D55C)지만, 맥에서 복사해 온 '한'은 자모가 풀린 세 글자(ㅎ+ㅏ+ㄴ)다. 눈에는
     * 똑같고 length 만 3배다 — '초보 환영합니다'가 8자가 아니라 18자로 세어진다.
     * 합치지 않으면 **열 글자짜리 제목을 붙여넣었을 뿐인데 "20자까지다"로 거절당한다.**
     *
     * 저장 모양이 하나로 정해지는 것도 여기서 같이 얻는다. 목록의 제목 검색이
     * 눈에 같아 보이는 둘을 실제로 같게 견줄 수 있는 근거다 (app/main/lobby.tsx의
     * foldForSearch — 찾는 말에도 똑같이 NFC 를 건다).
     */
    .normalize('NFC')
    // ★ 두 부류를 **같이 지우면 안 된다.** 서식문자는 지우는 게 맞지만(글자 사이를
    //   메우라고 있는 것이라), 제어문자까지 지우면 '초보\n방' 이 '초보방' 이 되어
    //   원래 없던 단어가 만들어진다. 제어문자는 자리를 차지하던 글자이므로 공백을
    //   남긴다 — 그 뒤 아래 줄이 어차피 한 칸으로 접는다.
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{Cc}/gu, ' ')
    // 남은 공백은 한 칸으로 접는다. \s 는 U+3000(전각 공백)도 잡는다 —
    // 그게 없으면 전각 공백만으로 "빈 것처럼 보이는 제목"을 만들 수 있다.
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return null;
  if (cleaned.length > MAX_ROOM_NAME_LEN) {
    throw new ApiError(400, `방 제목은 ${MAX_ROOM_NAME_LEN}자까지다`);
  }
  return cleaned;
}

/**
 * 방 제목 → 입장 코드 (2026-08-05 결정 — **이름이 곧 코드다**). 순수 함수다.
 *
 * 방장이 지은 이름 그대로 들어가게 한다 — 예전엔 이름 따로, 랜덤 4자 코드 따로라
 * "이름을 지었는데 코드가 자기 마음대로"였다. 이름 없는 방만 랜덤 코드를 받는다.
 *
 * 공백을 전부 지우고 대문자로 접는 이유: 입장 정규화(normalizeCode)와 입력칸들이
 * 이미 그 모양이라, 저장을 같은 모양으로 해야 어떻게 쳐도 맞는다. '초보 방'과
 * '초보방'이 같은 코드가 되는 건 의도다 — 눈으로 구분 안 되는 두 방이 나란히
 * 서느니 "이미 있다"로 거절되는 쪽이 낫다.
 */
export function codeFromName(name: string): string {
  return name.replace(/\s+/g, '').toUpperCase();
}

/**
 * 입장 코드 정규화. codeFromName 과 **같은 모양**이어야 한다 — 여기가 어긋나면
 * 목록에는 보이는데 쳐서는 못 들어가는 방이 생긴다.
 */
function normalizeCode(code: string): string {
  return code.normalize('NFC').replace(/\s+/g, '').toUpperCase();
}

/*
 * 시작 조건(사람 2~8명 + 방장 뺀 전원 준비)은 lib/game/rules.ts 의 startBlock 하나다.
 * 화면의 시작 버튼과 시작 라우트가 **같은 함수**를 본다 — 여기 상수로 두면
 * 클라이언트가 못 읽어서 화면 쪽에 복사본이 생긴다.
 * advance_phase 의 lobby 분기에도 "사람 2명" 검사가 남아 있다(두 겹). 준비 상태는
 * 거기서 못 본다 — shuffle_seats 가 is_ready 를 지운 뒤에 불리기 때문이다.
 */

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
 *
 * ★ 라우트에서 목록을 손으로 다시 적지 않는다 — 그때마다 한 컬럼씩 빠진다.
 *   실제로 name 이 그렇게 빠져 있었다: 방을 시작하거나 페이즈를 넘긴 응답만
 *   제목 없는 Room 이었다. 그래서 export 한다 (app/api/room/start, app/api/phase/advance).
 */
export const ROOM_COLUMNS =
  'id, code, name, capacity, phase, phase_seq, phase_ends_at, round, host_id, roster_seq, nominated_player_id, revote_candidates, world_started_at';

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
      // 갓 앉은 자리라 대기방 값은 비어 있다 (SPEC §15-3-결정).
      is_ready: false,
      lobby_line: null,
      lobby_line_at: null,
      /*
       * ★ 이름은 여기서 채우지 않는다 (SPEC §15-2-결정).
       *
       *   SQL 은 앉는 순간 profiles 에서 lobby_name 을 베껴 오지만, RPC 의
       *   returns table 에는 그 컬럼이 없다. 굳이 넣지 않는 이유는 **화면이 이
       *   값을 안 보기 때문**이다 — 대기방 좌석은 public_players(roster)에서
       *   읽는다(components/room-lobby.tsx 의 mine · bySeat). 여기에 넣으면
       *   같은 값이 두 군데 살면서 어긋날 수 있다.
       *
       *   반환 타입을 바꾸려면 함수를 drop 해야 하고, 그건 이미 올라간 배포 DB 를
       *   한 번 더 건드리는 일이다. 보이지도 않는 값 때문에 할 일이 아니다.
       */
      lobby_name: null,
    },
    token: row.player_token,
  };
}

/**
 * 방을 만들고 만든 사람을 방장으로 앉힌다.
 * 코드가 겹치면 다른 코드로 CODE_RETRY_LIMIT회까지 다시 시도한다 (SPEC §16.4, §14.4).
 *
 * ★ 정원은 인자로 받지 않는다 (2026-08-06 결정). p_capacity 에 null 을 주면 SQL 이
 *   default_room_capacity()(=사람 8)를 쓴다 — 방마다 다른 정원이 사라졌으므로
 *   "고른 값이 범위 밖" 이라는 갈래도 같이 사라졌다.
 *
 * @param name     방 제목. 생략하거나 공백뿐이면 이름 없는 방이 된다(null).
 * @param userId   만든 사람의 계정 (SPEC §15-2-결정). **라우트가 쿠키 세션에서
 *                 되찾은 값이어야 한다** — 클라이언트가 보낸 값을 그대로 넘기면
 *                 남의 계정으로 전적을 쌓을 수 있다 (I9).
 *                 null이어도 방은 만들어진다. 계정은 입장 조건이 아니다.
 */
export async function createRoom(
  name?: unknown,
  userId?: string | null,
): Promise<JoinResult> {
  const db = getServiceClient();

  // 코드 재시도 루프 **밖에서** 한 번만 다듬는다. 안에서 하면 같은 400을 5번 던진다.
  const roomName = normalizeRoomName(name);

  /*
   * 이름이 있으면 코드는 이름에서 나온다 (codeFromName — 이름이 곧 코드다).
   * 재시도가 없다 — 겹치는 건 우연이 아니라 **같은 이름이 이미 있다**는 뜻이므로,
   * 다른 코드를 뽑을 게 아니라 만든 사람에게 알리고 거절한다 (2026-08-05 결정).
   */
  if (roomName) {
    const { data, error } = await db.rpc('create_room', {
      p_code: codeFromName(roomName),
      p_capacity: null,
      p_name: roomName,
      p_user_id: userId ?? null,
    });
    if (!error) {
      const row = (data as SeatRow[])[0];
      return toResult(row, await fetchRoom(row.room_id));
    }
    if (error.code === UNIQUE_VIOLATION) {
      throw new ApiError(409, '이미 같은 이름의 방이 있다. 다른 이름을 붙일 것');
    }
    if (error.code === 'P0001') throw new ApiError(400, error.message);
    throw new ApiError(500, `방 생성 실패: ${error.message}`);
  }

  for (let attempt = 1; attempt <= CODE_RETRY_LIMIT; attempt += 1) {
    const code = generateRoomCode();
    // p_capacity가 null이면 SQL이 default_room_capacity()를 쓴다.
    const { data, error } = await db.rpc('create_room', {
      p_code: code,
      p_capacity: null,
      p_name: roomName,
      p_user_id: userId ?? null,
    });

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
 *
 * @param userId 들어온 사람의 계정. createRoom의 userId와 같은 규칙이다 —
 *               라우트가 쿠키 세션에서 되찾아 넘긴다 (SPEC §15-2-결정, I9).
 */
export async function joinRoom(code: string, userId?: string | null): Promise<JoinResult> {
  // 코드는 이제 방 이름일 수 있다 (codeFromName) — "알파벳 4자" 검사를 버렸다.
  // 모양 검사는 길이 하나면 된다: 존재하지 않는 코드는 어차피 P0002(404)로 떨어진다.
  const normalized = normalizeCode(code);
  if (!normalized || normalized.length > MAX_ROOM_NAME_LEN) {
    throw new ApiError(400, '방 이름(코드)이 비었거나 너무 길다');
  }

  const { data, error } = await getServiceClient().rpc('join_room', {
    p_code: normalized,
    p_user_id: userId ?? null,
  });

  if (error) {
    // SQL이 raise한 것은 사용자에게 그대로 보여줘도 되는 문장이다 (room.sql 참고)
    if (error.code === 'P0002') throw new ApiError(404, error.message);
    if (error.code === 'P0001') throw new ApiError(409, error.message);
    throw new ApiError(500, `입장 실패: ${error.message}`);
  }

  const row = (data as SeatRow[])[0];
  return toResult(row, await fetchRoom(row.room_id));
}

/** 나가기 결과. 방이 통째로 사라졌는지가 화면이 알아야 할 전부다. */
export interface LeaveResult {
  /** true면 그 방은 이제 없다. 마지막 사람이 나갔다는 뜻이다. */
  roomDeleted: boolean;
}

/**
 * 자리를 빼고, 사람이 하나도 안 남으면 방을 지운다.
 *
 * 세는 것과 지우는 것은 SQL 한 함수 안에서 한다 (`supabase/functions/room.sql`의
 * leave_room). 여기서 "나가기 → 세기 → 지우기"를 세 번 왕복으로 하면 두 사람이
 * 동시에 나갈 때 서로 상대를 세서 **빈 방이 그대로 남는다.**
 *
 * ★ 게임 중에는 거절한다 (409). 이탈 처리는 SPEC §15-4 미결정이다 — 행을 지우면
 *   answers·votes 가 cascade 로 같이 사라져 집계가 어긋나고, 빈자리를 봇이
 *   이어받을지도 아직 정하지 않았다.
 */
export async function leaveRoom(roomId: string, playerId: string): Promise<LeaveResult> {
  const { data, error } = await getServiceClient().rpc('leave_room', {
    p_room_id: roomId,
    p_player_id: playerId,
  });

  if (error) {
    // SQL이 raise한 것은 사용자에게 그대로 보여줘도 되는 문장이다 (room.sql 참고)
    if (error.code === 'P0001') throw new ApiError(409, error.message);
    throw new ApiError(500, `나가기 실패: ${error.message}`);
  }

  const row = (data as { room_deleted: boolean }[] | null)?.[0];
  return { roomDeleted: row?.room_deleted === true };
}

/**
 * 강퇴 — 방장이 대기방에서 한 사람을 내보낸다 (2026-08-07).
 *
 * ★ **방장인지는 SQL 안에서 본다.** 여기서 rooms.host_id 를 읽어 비교한 뒤
 *   지우면, 읽은 시점과 지우는 시점 사이에 방장이 바뀔 수 있다(방장이 나가면
 *   다음 사람에게 넘어간다). 방을 잠근 채 같은 트랜잭션에서 확인해야 그 틈이 없다.
 *   그래서 이 함수는 판정을 하지 않고 인자만 넘긴다 (supabase/functions/room.sql).
 *
 * @returns kicked=false 는 **에러가 아니다** — 이미 나간 사람을 또 내보낸 것이다.
 */
export async function kickPlayer(
  roomId: string,
  actorId: string,
  targetId: string,
): Promise<{ kicked: boolean }> {
  const { data, error } = await getServiceClient().rpc('kick_player', {
    p_room_id: roomId,
    p_actor_id: actorId,
    p_target_id: targetId,
  });

  if (error) {
    // SQL이 raise한 것은 사용자에게 그대로 보여줘도 되는 문장이다 (room.sql 참고)
    if (error.code === 'P0001') throw new ApiError(409, error.message);
    throw new ApiError(500, `내보내기 실패: ${error.message}`);
  }

  const row = (data as { kicked: boolean }[] | null)?.[0];
  return { kicked: row?.kicked === true };
}

/**
 * AI 자리를 만든다 — **딱 1대다** (2026-08-06 결정). lobby → question 직전에 한 번 부른다.
 *
 * 자리 수는 사람 수 + 1 이 된다. 빈 자리를 정원까지 전부 채우던 시절의 이름을
 * 그대로 쓰는 이유는 SQL 함수 이름(fill_with_bots)이 그것이기 때문이다.
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
  const normalized = normalizeCode(code);
  const { data, error } = await getServiceClient()
    .from('rooms')
    .select(ROOM_COLUMNS)
    .eq('code', normalized)
    .maybeSingle();

  if (error) throw new ApiError(500, `방 조회 실패: ${error.message}`);
  if (!data) throw new ApiError(404, `그런 방이 없다: ${normalized}`);
  return data as Room;
}

/** 방 목록의 한 줄. room_id는 넣지 않는다 — 입장은 code로 한다. */
export interface OpenRoom {
  code: string;
  /** 방 제목. 없으면 null — 화면이 코드로 대신 부른다 (lib/game/types.ts의 Room.name). */
  name: string | null;
  capacity: number;
  /**
   * 그 방에 앉아 있는 수.
   *
   * ★ 세는 대상이 상태에 따라 다르다 — lobby는 **사람만**, 시작한 방은 **봇까지 전부**.
   *   왜 그래야 하는지는 아래 listOpenRooms 주석에 있다 (I1). 한쪽으로 통일하면
   *   둘 중 하나가 반드시 샌다.
   */
  players: number;
  created_at: string;
  /**
   * 'lobby'면 대기 중, 그 밖은 전부 게임 중.
   *
   * 방 하나의 상태일 뿐 **자리와 묶이지 않는다** — 어느 자리가 봇인지와 무관하다 (I1).
   */
  phase: Phase;
}

/**
 * 목록에 한 번에 싣는 방 수. 더 오래된 방은 코드를 직접 입력해 들어간다.
 *
 * 대기 방과 게임 중인 방을 따로 센다. 하나로 묶어 최근 50개만 가져오면, 게임이 몰린
 * 시간대에 **들어갈 수 있는 방이 목록에서 통째로 밀려난다** — 목록의 목적이 사라진다.
 */
const WAITING_ROOM_LIMIT = 50;
const PLAYING_ROOM_LIMIT = 20;

/**
 * 방 목록. 화면의 "방 골라 들어가기"가 쓴다.
 *
 * ★ 왜 서버를 거치나: players 테이블은 anon에게 revoke돼 있고(I1), public_players로
 *   방 여러 개를 한꺼번에 세는 건 방 필터 없는 쿼리라 I10 위반이다. 그래서 service role
 *   서버가 세어서 숫자만 내려보낸다.
 *
 * ┌─ ★ 시작한 방도 싣는다. 대신 세는 방법을 바꾼다 ───────────────────────────┐
 * │ 예전에는 lobby인 방만 내려보냈다. 이유는 "정원 − 표시 인원 = 봇 수"가       │
 * │ 새기 때문이었다 (SPEC §17.6).                                              │
 * │                                                                           │
 * │ **그 구멍은 2026-08-06 에 규칙 자체가 없앴다.** AI 는 어느 방이든 1대이고   │
 * │ 그 수는 공개다 (§15-3 — 수는 공개, 자리는 비밀). 역산해서 알아낼 것이 없다. │
 * │                                                                           │
 * │ 그래도 세는 방법은 그대로 둔다. 시작한 방은 **앉아 있는 전부**(AI 포함),    │
 * │ lobby 는 **사람만**이다. 이유가 새는 것에서 정확함으로 바뀌었을 뿐이다 —    │
 * │ 시작한 방의 '3/8' 은 실제로 세 자리가 찼다는 뜻이고, lobby 에서 봇을 세면   │
 * │ /api/room/start 가 fillWithBots 를 커밋하고 advance_phase 를 부르기 전       │
 * │ 그 짧은 틈에 3초 폴링이 걸려 인원이 혼자 +1 되는 것으로 보인다.             │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * 순서는 **대기 중인 방이 먼저, 게임 중인 방이 뒤**다. 들어갈 수 있는 방이 위에 와야
 * 목록이 쓸모가 있다. 화면에서 다르게 정렬하더라도 이 갈래는 유지한다.
 */
export async function listOpenRooms(): Promise<OpenRoom[]> {
  const db = getServiceClient();

  const columns = 'id, code, name, capacity, created_at, phase';
  const [waiting, playing] = await Promise.all([
    db
      .from('rooms')
      .select(columns)
      .eq('phase', 'lobby')
      .order('created_at', { ascending: false })
      .limit(WAITING_ROOM_LIMIT),
    db
      .from('rooms')
      .select(columns)
      .neq('phase', 'lobby')
      .order('created_at', { ascending: false })
      .limit(PLAYING_ROOM_LIMIT),
  ]);

  const failed = waiting.error ?? playing.error;
  if (failed) throw new ApiError(500, `방 목록 조회 실패: ${failed.message}`);

  // 대기 방이 앞, 게임 중인 방이 뒤. 각 묶음 안은 최신순이다.
  const rooms = [...(waiting.data ?? []), ...(playing.data ?? [])];
  if (rooms.length === 0) return [];

  const ids = rooms.map((r) => r.id as string);
  // 방마다 한 번씩 세면 왕복이 70번이다. 목록에 올린 방으로 범위를 좁혀 한 번에 읽고
  // 메모리에서 센다. is_bot은 세는 데만 쓰고 값 자체는 밖으로 내보내지 않는다 (I1).
  const { data: seats, error: seatErr } = await db
    .from('players')
    .select('room_id, is_bot')
    .in('room_id', ids);

  if (seatErr) throw new ApiError(500, `참가자 수 조회 실패: ${seatErr.message}`);

  const humans = new Map<string, number>();
  const everyone = new Map<string, number>();
  for (const s of seats ?? []) {
    const roomId = s.room_id as string;
    everyone.set(roomId, (everyone.get(roomId) ?? 0) + 1);
    if (s.is_bot === false) humans.set(roomId, (humans.get(roomId) ?? 0) + 1);
  }

  return rooms.map((r) => {
    const id = r.id as string;
    const phase = r.phase as Phase;
    return {
      code: r.code as string,
      name: (r.name as string | null) ?? null,
      capacity: r.capacity as number,
      players: (phase === 'lobby' ? humans.get(id) : everyone.get(id)) ?? 0,
      created_at: r.created_at as string,
      phase,
    };
  });
}
