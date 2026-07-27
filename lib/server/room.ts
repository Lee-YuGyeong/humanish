/**
 * 방 생성 · 입장. 소유: A (SPEC §2)
 *
 * 모든 쓰기는 service role로 수행한다 (supabase/policies.sql 전제 참고).
 */

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
 * TODO(A): 끝난 방 정리 (SPEC §16.4).
 * phase = 'replay'이거나 created_at이 24시간 지난 방을 지운다. cascade가 딸린 데이터를 함께 정리한다.
 * 안 하면 코드가 계속 점유되고 워치독 스캔 대상으로도 남는다.
 */
export async function cleanupStaleRooms(): Promise<number> {
  throw new Error('cleanupStaleRooms: 미구현');
}

/** TODO(A): 코드로 방을 찾아 빈 seat에 앉힌다. 정원 초과·게임 진행 중이면 거절. */
export async function joinRoom(_code: string, _nickname: string): Promise<{ room: Room; player: Player }> {
  throw new Error('joinRoom: 미구현');
}

/**
 * TODO(A): lobby → question 전환 직전에 빈 자리를 봇으로 채운다.
 * 봇을 몇 명 채웠는지는 클라이언트에 절대 알리지 않는다 (SPEC §7).
 */
export async function fillWithBots(_roomId: string): Promise<void> {
  throw new Error('fillWithBots: 미구현');
}
