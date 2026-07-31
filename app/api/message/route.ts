/**
 * 자유 채팅 메시지. 소유: A (SPEC §5.4, §13-6)
 *
 * POST /api/message  { room_id, text }  →  { ok }
 *
 * ★ player_id를 받지 않는다. 쿠키의 토큰으로 되찾는다 (I9, SPEC §17.4).
 *
 * 사람 메시지를 넣은 뒤 봇 하나가 반응할지 판단한다 (SPEC §5.4).
 *   - 봇당 쿨다운 8초
 *   - 한 메시지에 반응하는 봇은 최대 1명
 *   - 반응은 즉시 insert하되 visible_at을 미래로 박는다 (타이핑 지연)
 *
 * LLM 배선 (SPEC §12.3, §17.5): bot_reply RPC는 그대로 두고 — 봇 선택·쿨다운·
 * 타이핑 지연의 유일한 주인 — 그 결과로 남은 공개 전 행을 응답 반환 뒤
 * regenerateBotChatReply(B 소유)가 LLM 텍스트로 덮는다. 실패하면 풀 문구가 남는다.
 */

import { after } from 'next/server';
import { getServiceClient } from '@/lib/server/supabase';
import { ApiError, apiError, readJson, requirePlayer } from '@/lib/server/auth';
import { regenerateBotChatReply } from '@/lib/agent/chat-reply';

interface Body {
  room_id?: string;
  text?: string;
}

const MAX_MESSAGE_LEN = 200;

/** SPEC §5.4 — 봇당 최소 8초. 이 값이 §12.6의 호출 상한과 물려 있다. */
const BOT_COOLDOWN_SEC = 8;

export async function POST(req: Request): Promise<Response> {
  try {
    const { room_id: roomId, text } = await readJson<Body>(req);
    if (!roomId) throw new ApiError(400, 'room_id가 없다');

    const trimmed = (text ?? '').trim();
    if (!trimmed) throw new ApiError(400, '메시지가 비었다');
    if (trimmed.length > MAX_MESSAGE_LEN) {
      throw new ApiError(400, `메시지는 ${MAX_MESSAGE_LEN}자까지다`);
    }

    const me = await requirePlayer(roomId);
    const db = getServiceClient();

    // 페이즈 확인도 send_message 안에서 한다 — 확인과 삽입 사이에 페이즈가
    // 넘어가는 틈을 없애려는 것이다.
    // ★ visible_at을 여기서 new Date()로 만들지 않는다. 앱 서버 시계와 DB 시계가
    //   어긋나 있다 (I2, SPEC §12.5). 메시지 삽입과 봇 반응을 SQL 한 번에 맡긴다.
    const { error: sendErr } = await db.rpc('send_message', {
      p_room_id: roomId,
      p_player_id: me.id,
      p_text: trimmed,
      p_cooldown_sec: BOT_COOLDOWN_SEC,
    });

    if (sendErr) {
      if (sendErr.code === 'P0001') throw new ApiError(409, sendErr.message);
      throw new ApiError(500, `메시지 저장 실패: ${sendErr.message}`);
    }

    // bot_reply가 넣은 공개 전 봇 반응을 응답 반환 뒤 LLM으로 덮는다 (SPEC §17.5).
    // lib/server/phase.ts의 regenerateBotAnswers 배선과 같은 골격이다.
    try {
      after(() => regenerateBotChatReply(roomId));
    } catch {
      // 요청 컨텍스트 밖(테스트·스크립트)에서는 after가 없다 — 그냥 발사한다
      void regenerateBotChatReply(roomId);
    }

    return Response.json({ ok: true });
  } catch (e) {
    return apiError(e);
  }
}
