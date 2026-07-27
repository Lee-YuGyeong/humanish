/**
 * 답변 제출. 소유: A (SPEC §13-4)
 *
 * POST /api/answer  { room_id, text }  →  { ok, advanced }
 *
 * ★ player_id를 받지 않는다. 쿠키의 토큰으로 되찾는다 (I9, SPEC §17.4).
 *   받아서 믿으면 남의 이름으로 답변을 넣을 수 있다 — player_id는 누구나 읽는다.
 *
 * ★ visible_at은 페이즈 종료 시각이다. now()로 넣으면 제출 즉시 남에게 보여서
 *   SPEC §13-4("제출 전에는 남의 답이 안 보인다")가 깨진다. 봇 답변도 같은 시각을
 *   쓰므로 사람 답과 봇 답이 한꺼번에 뜬다 — 먼저 뜨면 그것만으로 봇이 드러난다 (I1).
 *
 * 제출 후 곧바로 전환을 시도한다. 사람이 전부 냈으면 그 자리에서 넘어간다 (조기 종료).
 */

import { advancePhase } from '@/lib/server/phase';
import { getServiceClient } from '@/lib/server/supabase';
import { ApiError, apiError, readJson, requirePlayer } from '@/lib/server/auth';

interface Body {
  room_id?: string;
  text?: string;
}

/** 프롬프트 인젝션과 도배를 막는 최소한의 상한. 게임 답변은 길 이유가 없다. */
const MAX_ANSWER_LEN = 300;

export async function POST(req: Request): Promise<Response> {
  try {
    const { room_id: roomId, text } = await readJson<Body>(req);
    if (!roomId) throw new ApiError(400, 'room_id가 없다');

    const trimmed = (text ?? '').trim();
    if (!trimmed) throw new ApiError(400, '답변이 비었다');
    if (trimmed.length > MAX_ANSWER_LEN) {
      throw new ApiError(400, `답변은 ${MAX_ANSWER_LEN}자까지다`);
    }

    const me = await requirePlayer(roomId);
    const db = getServiceClient();

    const { data: room, error: roomErr } = await db
      .from('rooms')
      .select('id, phase, phase_seq, phase_ends_at, round')
      .eq('id', roomId)
      .single();
    if (roomErr) throw new ApiError(500, `방 조회 실패: ${roomErr.message}`);

    if (room.phase !== 'question' && room.phase !== 'target') {
      throw new ApiError(409, `지금은 답변할 때가 아니다 (${room.phase})`);
    }
    if (!room.phase_ends_at) {
      throw new ApiError(500, '페이즈 종료 시각이 없다');
    }

    // 지금 답해야 하는 질문 하나
    const query = db.from('questions').select('id, kind, target_id').eq('room_id', roomId);
    const { data: question, error: qErr } =
      room.phase === 'question'
        ? await query.eq('kind', 'common').eq('round', room.round).maybeSingle()
        : await query.eq('kind', 'target').order('round', { ascending: false }).limit(1).maybeSingle();
    if (qErr) throw new ApiError(500, `질문 조회 실패: ${qErr.message}`);
    if (!question) throw new ApiError(409, '아직 질문이 없다');

    // 지목 질문은 대상자만 답한다
    if (question.kind === 'target' && question.target_id !== me.id) {
      throw new ApiError(403, '지목받은 사람만 답할 수 있다');
    }

    const { error: insErr } = await db.from('answers').upsert(
      {
        question_id: question.id,
        room_id: roomId,
        player_id: me.id,
        text: trimmed,
        visible_at: room.phase_ends_at, // ★ now()가 아니다
      },
      { onConflict: 'question_id,player_id' },
    );
    if (insErr) throw new ApiError(500, `답변 저장 실패: ${insErr.message}`);

    // 사람이 전부 냈으면 여기서 바로 넘어간다 (SPEC §5.1 조기 종료)
    const advanced = await advancePhase(roomId, room.phase_seq, me.id);

    return Response.json({ ok: true, advanced });
  } catch (e) {
    return apiError(e);
  }
}
