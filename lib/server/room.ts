/**
 * 방 생성 · 입장. 소유: A (SPEC §2)
 *
 * 모든 쓰기는 service role로 수행한다 (supabase/policies.sql 전제 참고).
 */

import { getServiceClient } from '@/lib/server/supabase';
import type { Player, Room } from '@/lib/game/types';

/** 방 정원. 사람이 덜 차면 나머지는 봇이 채운다. */
export const ROOM_CAPACITY = 5;

/** 4자 대문자 코드. I·O·0·1처럼 헷갈리는 글자는 뺀다. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/** 코드 충돌 시 재시도 횟수 (SPEC §16.4). 24^4 = 331,776가지라 충돌이 실제로 난다. */
export const CODE_RETRY_LIMIT = 5;

export function generateRoomCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/**
 * TODO(A): rooms insert + 방장 player insert.
 * code unique 제약에 걸리면 에러를 던지지 말고 다른 코드로 CODE_RETRY_LIMIT회까지 재시도한다.
 */
export async function createRoom(_hostNickname: string): Promise<{ room: Room; player: Player }> {
  throw new Error('createRoom: 미구현');
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
  if (error) {
    throw new Error(`cleanup_stale_rooms 실패: ${error.message}`);
  }
  return typeof data === 'number' ? data : 0;
}

/** TODO(A): 코드로 방을 찾아 빈 seat에 앉힌다. 정원 초과·게임 진행 중이면 거절. */
export async function joinRoom(_code: string, _nickname: string): Promise<{ room: Room; player: Player }> {
  throw new Error('joinRoom: 미구현');
}

/**
 * TODO(A): lobby → question 전환 직전에 빈 자리를 봇으로 채운다.
 * 봇을 몇 명 채웠는지는 클라이언트에 절대 알리지 않는다 (SPEC §7).
 *
 * **seat과 nickname을 섞어서 배정한다 (SPEC §17.4).** 빈 seat을 순서대로 채우면
 * 봇이 늘 뒷자리·뒷번호에 몰려서 seat만 보고 봇을 고를 수 있다.
 * created_at도 마찬가지라 public_players 뷰에서 뺀다 (SPEC §7.2).
 */
export async function fillWithBots(_roomId: string): Promise<void> {
  throw new Error('fillWithBots: 미구현');
}
