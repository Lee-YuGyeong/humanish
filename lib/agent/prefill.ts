/**
 * 실전 게임 배선 — 페이즈 진입 후 봇 답변을 LLM으로 재생성해 덮어쓴다. 소유: B
 *
 * SQL 진입 훅(on_enter_phase)이 문구 풀로 미리 넣어둔 봇 답변은
 * visible_at = 페이즈 종료 시각(미래)이고, RLS(visible_at <= now())가 공개
 * 전까지 숨긴다. 그 창 동안 text만 LLM 결과로 UPDATE하면 —
 *   성공: 공개 시점에 LLM 답이 나간다 (사람 답과 동시에, I1 유지)
 *   실패·지연: 풀 문구가 그대로 남는다 — 폴백이 구조적으로 공짜다 (§12.3, §17.5)
 *
 * LLM 호출은 /api/agent self-fetch로만 한다 (I4). 이 파일은 키를 모른다.
 * 여기서 나는 모든 에러는 삼킨다 — 봇 입이 게임 진행을 막아서는 안 된다.
 */

import { personaForSeat } from '@/lib/agent/persona';
import { observeStyle } from '@/lib/agent/disguise';
import type { AgentContext, AgentOutput } from '@/lib/agent/generate';
import { getServiceClient } from '@/lib/server/supabase';
import type { Phase } from '@/lib/game/types';

/** self-fetch 대상. 로컬 개발 기본값 — 배포에서 쓰게 되면 env로 넘긴다. */
const AGENT_SELF_URL = process.env.AGENT_SELF_URL ?? 'http://127.0.0.1:3000';

export interface BotSeat {
  id: string;
  seat: number;
}

/**
 * 순수 — 봇 목록과 게임 상황으로 /api/agent 요청 몸통을 만든다.
 * question·target은 남의 답이 안 보이는 페이즈라(§13-4) visibleHistory는 비운다.
 * 말투 관측은 이미 공개된 사람 발화로만 한다.
 */
export function buildPrefillJobs(
  bots: BotSeat[],
  phase: Phase,
  question: string | undefined,
  humanTexts: string[],
): { player_id: string; context: AgentContext }[] {
  const styleProfile = observeStyle(humanTexts);
  return bots.map((b) => ({
    player_id: b.id,
    context: {
      persona: personaForSeat(b.seat),
      phase,
      question,
      visibleHistory: [],
      styleProfile,
      suspicionOnMe: 0.2,
    },
  }));
}

/**
 * 전환 성공 직후 lib/server/phase.ts가 응답 반환 뒤(after)에 부른다.
 * 지금 페이즈가 question·target이 아니면 조용히 끝난다.
 */
export async function regenerateBotAnswers(roomId: string): Promise<void> {
  try {
    const db = getServiceClient();

    const { data: room } = await db
      .from('rooms')
      .select('id, phase, round')
      .eq('id', roomId)
      .maybeSingle();
    if (!room || (room.phase !== 'question' && room.phase !== 'target')) return;

    // 지금 페이즈의 질문 — app/api/answer/route.ts와 같은 선택 규칙
    const query = db.from('questions').select('id, text, kind').eq('room_id', roomId);
    const { data: question } =
      room.phase === 'question'
        ? await query.eq('kind', 'common').eq('round', room.round).maybeSingle()
        : await query.eq('kind', 'target').order('round', { ascending: false }).limit(1).maybeSingle();
    if (!question) return;

    const { data: botRows } = await db
      .from('players')
      .select('id, seat')
      .eq('room_id', roomId)
      .eq('is_bot', true);
    const bots = (botRows ?? []) as BotSeat[];
    if (bots.length === 0) return;

    // 교체 가능한 행 = 이 질문에 SQL이 넣어둔 봇 답변 중 아직 공개 전인 것.
    // target 페이즈는 지목당한 봇 하나만 행이 있다 — 이 필터가 자연히 걸러준다.
    const nowIso = new Date().toISOString();
    const { data: pending } = await db
      .from('answers')
      .select('player_id')
      .eq('question_id', question.id)
      .gt('visible_at', nowIso)
      .in(
        'player_id',
        bots.map((b) => b.id),
      );
    const replaceable = new Set((pending ?? []).map((r: { player_id: string }) => r.player_id));
    const targets = bots.filter((b) => replaceable.has(b.id));
    if (targets.length === 0) return;

    // 방 말투 관측 — 이미 공개된 발화 중 사람 것만 (봇 풀 문구를 배우면 안 된다)
    const { data: revealed } = await db
      .from('answers')
      .select('text, player_id')
      .eq('room_id', roomId)
      .lte('visible_at', nowIso)
      .limit(30);
    const botIds = new Set(bots.map((b) => b.id));
    const humanTexts = ((revealed ?? []) as { text: string; player_id: string }[])
      .filter((a) => !botIds.has(a.player_id))
      .map((a) => a.text);

    // LLM 호출 — 병렬·8초 컷·agent_logs 기록은 /api/agent가 담당한다 (I4)
    const res = await fetch(`${AGENT_SELF_URL}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        room_id: roomId,
        bots: buildPrefillJobs(targets, room.phase, question.text, humanTexts),
      }),
    });
    if (!res.ok) {
      console.error(`[prefill] /api/agent ${res.status} — 풀 문구 유지 (room ${roomId})`);
      return;
    }
    const data = (await res.json()) as {
      results?: { player_id: string; output: AgentOutput; fallback: boolean }[];
    };

    let replaced = 0;
    for (const r of data.results ?? []) {
      // LLM 실패분("ㅇㅇ")보다 질문-매칭 풀 문구가 낫다 — 덮지 않는다
      if (r.fallback) continue;
      const text = r.output.messages.join(' ').trim();
      if (!text) continue;

      const { error, count } = await db
        .from('answers')
        .update({ text }, { count: 'exact' })
        .eq('question_id', question.id)
        .eq('player_id', r.player_id)
        // 그 사이 조기 종료로 공개됐으면 건드리지 않는다 — 공개 후 바뀌는 글은 봇 신호다 (I1)
        .gt('visible_at', new Date().toISOString());
      if (!error && (count ?? 0) > 0) replaced += 1;
    }

    console.log(
      `[prefill] ${room.phase} r${room.round} — 봇 답변 ${replaced}/${targets.length} LLM 교체 (room ${roomId.slice(0, 8)})`,
    );
  } catch (e) {
    // 봇 입이 게임을 막으면 안 된다 (§12.3) — 기록만 남기고 조용히 물러난다
    console.error('[prefill]', e instanceof Error ? e.message : String(e));
  }
}
