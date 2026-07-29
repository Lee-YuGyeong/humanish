/**
 * 대기방 프리셋 발화 · 준비 상태. 소유: A (SPEC §15-3-결정, §17.3)
 *
 * 문구 목록과 상수는 lobby-lines.ts 하나에 있다. 여기는 DB로 넘기는 얇은 층이고,
 * 조합을 막는 규칙(쿨다운 · 연속 재전송 · 총량)은 supabase/functions/lobby.sql 이 본다.
 *
 * ★ P0001은 규칙에 걸린 것이지 고장이 아니다. 409로 돌려서 화면이 "다시 눌러보세요"를
 *   띄울 수 있게 한다. 500으로 뭉뚱그리면 쿨다운에 걸린 것과 DB가 죽은 것이 같아 보인다.
 */

import { ApiError } from '@/lib/server/auth';
import { LOBBY_LINE_COOLDOWN_SEC, LOBBY_LINE_MAX } from '@/lib/server/lobby-lines';
import { getServiceClient } from '@/lib/server/supabase';

/** 프리셋 문구 하나를 말한다. text는 호출부가 화이트리스트로 검증한 값이어야 한다 (I9). */
export async function sayLobbyLine(roomId: string, playerId: string, text: string): Promise<void> {
  const { error } = await getServiceClient().rpc('say_lobby_line', {
    p_room_id: roomId,
    p_player_id: playerId,
    p_text: text,
    p_cooldown_sec: LOBBY_LINE_COOLDOWN_SEC,
    p_max_lines: LOBBY_LINE_MAX,
  });

  if (error) {
    if (error.code === 'P0001') throw new ApiError(409, error.message);
    throw new ApiError(500, `대기방 발화 실패: ${error.message}`);
  }
}

/** 준비 완료 토글. 같은 값으로 다시 불러도 아무 일도 일어나지 않는다. */
export async function setLobbyReady(
  roomId: string,
  playerId: string,
  ready: boolean,
): Promise<void> {
  const { error } = await getServiceClient().rpc('set_lobby_ready', {
    p_room_id: roomId,
    p_player_id: playerId,
    p_ready: ready,
  });

  if (error) {
    if (error.code === 'P0001') throw new ApiError(409, error.message);
    throw new ApiError(500, `준비 상태 변경 실패: ${error.message}`);
  }
}
