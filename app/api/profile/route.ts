/**
 * 내 프로필 — 이름 짓기. 소유: A (SPEC §15-2-결정)
 *
 * GET  /api/profile  →  { profile, suggested }
 * POST /api/profile  { display_name }  →  { profile }   ← **계정당 한 번뿐이다**
 *
 * ┌─ 이름은 한 번 짓고 끝이다 ─────────────────────────────────────────────────┐
 * │ 두 번째 POST 는 409 다. 자물쇠는 두 겹이고 **둘 다 있어야 한다**:          │
 * │   1. 여기 — 이미 있으면 쓰기 전에 끊는다. 사용자에게 문장을 돌려줄 수      │
 * │      있는 자리가 여기뿐이다.                                               │
 * │   2. profiles_name_frozen 트리거 (supabase/schema.sql) — service role 은   │
 * │      RLS 를 통과하므로 정책으로는 못 막는다. 프로필을 건드리는 경로가      │
 * │      나중에 하나 더 생겨도 트리거는 거기에도 걸린다.                       │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 이 이름이 어디에 나오는가 ────────────────────────────────────────────────┐
 * │ 대기방 · (나중에) 랭킹 · 친구. **게임 화면에는 안 나온다.**                 │
 * │ 방에 앉는 순간 players.lobby_name 으로 베껴지고, shuffle_seats 가 시작할   │
 * │ 때 지운다. 게임에서는 모두 '익명N' 이다 (I1).                              │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 쓰기는 service role 로 한다. profiles 는 authenticated 에게 읽기만 열려 있다 (I9).
 *   대신 **누구 행을 고칠지는 쿠키 세션에서 되찾은 user_id 로만 정한다** —
 *   본문의 user_id 를 받으면 남의 이름을 바꿀 수 있다.
 */

import { ApiError, apiError, readJson, requireUser } from '@/lib/server/auth';
import { getServerAuthClient, getServiceClient } from '@/lib/server/supabase';
import type { Profile } from '@/lib/game/types';

export const dynamic = 'force-dynamic';

/** profiles.display_name 의 체크 제약과 같은 값이어야 한다 (supabase/schema.sql). */
export const MIN_NAME_LEN = 1;
export const MAX_NAME_LEN = 20;

/** lower(display_name) 유니크 인덱스 이름 (supabase/schema.sql). */
const NAME_TAKEN = 'profiles_display_name_key';
/** 기본키(user_id) 충돌 = 이미 이름을 지은 계정이다. 아래 ALREADY_NAMED 주석 참고. */
const ALREADY_NAMED = 'profiles_pkey';
const UNIQUE_VIOLATION = '23505';

const PROFILE_COLUMNS = 'user_id, display_name, avatar_url, created_at';

/**
 * 제어문자(줄바꿈 · 탭 · 눈에 안 보이는 것). **소스에 그 문자를 직접 쓰지 않는다** —
 * 파일에 진짜 NUL 바이트가 박혀서 편집기와 도구가 파일을 깨진 것으로 다룬다.
 */
/**
 * 이름을 다듬는다.
 *
 * ★ **방 제목(normalizeRoomName)과 같은 규칙을 쓴다.** 거기 주석에 각 단계의
 *   근거가 적혀 있다 — NFC 로 먼저 합쳐야 자모가 풀린 한글이 길이를 3배로
 *   세지 않고, 서식문자(\p{Cf})는 지우되 제어문자(\p{Cc})는 공백으로 남겨야
 *   '철\n수' 가 '철수' 라는 없던 단어가 되지 않는다.
 *
 * ★ 이름에서는 그게 **더 중요하다.** 유니크 인덱스가 걸려 있어서, 보이지 않는
 *   글자 하나를 끼우면 눈으로 같아 보이는 이름을 하나 더 만들 수 있다.
 *   '철수' 와 '철수<제로폭공백>' 이 대기방에 나란히 서면 누가 누구인지 못 가린다.
 *   그래서 여기서 털어야 lower(display_name) 유니크가 실제로 의미를 갖는다.
 *
 * ★ 방 제목과 달리 **빈 값을 null 로 접지 않는다.** 이름은 반드시 있어야 하므로
 *   비면 400 이다 (profiles.display_name 이 not null 이다).
 */
export function normalizeDisplayName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ApiError(400, '이름이 없다');
  }
  const name = raw
    .normalize('NFC')
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (name.length < MIN_NAME_LEN) throw new ApiError(400, '이름을 적어야 한다');
  if (name.length > MAX_NAME_LEN) throw new ApiError(400, `이름은 ${MAX_NAME_LEN}자까지다`);
  return name;
}

/** 세션에 실려 있는 구글 프로필. 이름 제안과 사진에 쓴다. */
async function googleMeta(): Promise<Record<string, unknown>> {
  const db = await getServerAuthClient();
  const { data } = await db.auth.getUser();
  return (data.user?.user_metadata ?? {}) as Record<string, unknown>;
}

/** 구글이 준 이름을 첫 제안으로 쓴다. 사용자가 그대로 두든 고치든 자유다. */
function suggestFrom(meta: Record<string, unknown>): string {
  for (const key of ['full_name', 'name']) {
    const v = meta[key];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, MAX_NAME_LEN);
  }
  const email = meta.email;
  if (typeof email === 'string' && email.includes('@')) {
    return email.split('@')[0].slice(0, MAX_NAME_LEN);
  }
  return '';
}

function avatarFrom(meta: Record<string, unknown>): string | null {
  const v = meta.avatar_url ?? meta.picture;
  return typeof v === 'string' ? v : null;
}

export async function GET(): Promise<Response> {
  try {
    const user = await requireUser();

    const { data, error } = await getServiceClient()
      .from('profiles')
      .select(PROFILE_COLUMNS)
      .eq('user_id', user.id)
      .maybeSingle();

    if (error) throw new ApiError(500, `프로필 조회 실패: ${error.message}`);

    // 아직 이름을 안 지었으면 구글이 준 것을 제안한다. 화면이 입력칸에 미리 채운다.
    return Response.json({
      profile: (data as Profile | null) ?? null,
      suggested: data ? null : suggestFrom(await googleMeta()),
    });
  } catch (e) {
    return apiError(e);
  }
}

interface Body {
  display_name?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const user = await requireUser();

    /*
     * 익명 계정에는 이름을 달지 않는다.
     *
     * 이름은 "다음에 와도 나인 걸 아는 것"을 위한 값인데, 익명 계정은 브라우저
     * 저장소가 지워지면 되찾을 수 없다. 그 이름으로 쌓은 기록이 통째로 사라지고,
     * 유니크라서 **그 이름은 아무도 다시 못 쓴다.** 구글을 먼저 연결하게 한다.
     */
    if (user.is_anonymous) {
      throw new ApiError(409, '먼저 구글을 연결해야 이름을 지을 수 있다');
    }

    const db = getServiceClient();

    /*
     * 이미 지었으면 여기서 끝난다.
     *
     * ★ 이 조회가 자물쇠는 아니다. 두 요청이 동시에 오면 둘 다 "없다"를 보고 지나간다 —
     *   그 경우는 아래 insert 의 기본키 충돌이 잡는다. 여기서 먼저 보는 이유는
     *   **사용자에게 돌려줄 문장이 다르기 때문**이다. "이미 쓰는 이름"과
     *   "이미 이름이 있다"는 화면에서 할 일이 정반대다(다른 이름을 고르기 / 그냥 나가기).
     */
    const { data: existing, error: lookupError } = await db
      .from('profiles')
      .select('user_id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (lookupError) throw new ApiError(500, `프로필 조회 실패: ${lookupError.message}`);
    if (existing) throw new ApiError(409, '이름은 한 번만 지을 수 있다');

    const { display_name } = await readJson<Body>(req);
    const name = normalizeDisplayName(display_name);

    const { data, error } = await db
      .from('profiles')
      /*
       * ★ upsert 가 아니라 insert 다. upsert 면 두 번째 요청이 **이름을 덮어쓴다** —
       *   트리거가 그걸 막아주긴 하지만, 라우트가 하려던 일과 DB 가 허락하는 일이
       *   어긋난 채로 남는다. 여기서도 "만들기"만 한다.
       *
       * ★ user_id 는 세션에서 되찾은 값이다. 본문에서 오지 않는다 (I9).
       * ★ 사진은 사용자가 고르는 값이 아니라 구글이 준 것이다. 이름과 함께 한 번
       *   박히고, 이후 갱신은 이 라우트가 하지 않는다 (트리거는 avatar_url 을 안 막는다).
       */
      .insert({ user_id: user.id, display_name: name, avatar_url: avatarFrom(await googleMeta()) })
      .select(PROFILE_COLUMNS)
      .single();

    if (error) {
      // 위 조회를 지나온 동시 요청. 둘 중 하나만 이름을 갖는다.
      if (error.message.includes(ALREADY_NAMED)) {
        throw new ApiError(409, '이름은 한 번만 지을 수 있다');
      }
      // lower(display_name) 유니크에 걸렸다. 사용자에게 보여줄 문장으로 바꾼다.
      if (error.code === UNIQUE_VIOLATION || error.message.includes(NAME_TAKEN)) {
        throw new ApiError(409, '이미 쓰는 이름이다. 다른 이름을 골라야 한다');
      }
      throw new ApiError(500, `이름 저장 실패: ${error.message}`);
    }

    return Response.json({ profile: data as Profile });
  } catch (e) {
    return apiError(e);
  }
}
