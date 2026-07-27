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

export function generateRoomCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** TODO(A): rooms insert + 방장 player insert. 코드 충돌 시 재시도. */
export async function createRoom(_hostNickname: string): Promise<{ room: Room; player: Player }> {
  throw new Error('createRoom: 미구현');
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
