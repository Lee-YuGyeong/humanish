/**
 * chat 페이즈 봇 반응의 LLM 덮어쓰기. 소유: B (SPEC §5.4, §12.3, §17.5)
 *
 * question·target(prefill.ts)과 같은 "공개 전 덮어쓰기" 패턴이다.
 * 봇 선택·쿨다운·타이핑 지연은 SQL(bot_reply)이 지금처럼 전부 하고 —
 * 풀 문구를 visible_at = now() + typing_delay()로 insert — 여기는 그 행이
 * 공개되기 전에 text만 LLM 결과로 UPDATE한다.
 *   성공: 타이핑 지연이 끝나는 순간 LLM 반응이 보인다
 *   실패·지연: 풀 문구가 그대로 나간다 — 폴백이 구조적으로 공짜다
 *
 * visible_at은 절대 건드리지 않는다 — 타이밍 분포가 LLM 성공/실패와 무관해야
 * 자리 단위 봇 신호가 안 된다 (I1). 같은 이유로 LLM 텍스트는 풀 문구 길이대에
 * 맞게 자른다(capChatReply) — 짧은 지연에 긴 글이 실리면 그게 신호다.
 *
 * LLM 호출은 /api/agent self-fetch로만 한다 (I4). 이 파일은 키를 모른다.
 * 여기서 나는 모든 에러는 삼킨다 — 봇 입이 채팅을 막아서는 안 된다.
 */

import { personaForSeat } from '@/lib/agent/persona';
import { observeStyle } from '@/lib/agent/disguise';
import { FALLBACK_POOL, type AgentContext, type AgentOutput } from '@/lib/agent/generate';
import { AGENT_SELF_URL, agentHeaders, type BotSeat } from '@/lib/agent/prefill';
import { getServiceClient } from '@/lib/server/supabase';

/** bot_reply가 넣어둔, 아직 공개 전인 봇 메시지 한 건. */
export interface PendingBotMessage {
  id: string;
  player_id: string;
}

/**
 * 순수 — pending 봇 메시지마다 /api/agent 요청 몸통을 만든다.
 * question을 싣지 않으므로 buildMessages의 chat 분기("자연스럽게 한마디")를 탄다.
 * 봇 seat을 모르는 pending(경합으로 봇 목록에서 빠진 행)은 조용히 거른다.
 */
export function buildChatReplyJobs(
  pending: PendingBotMessage[],
  bots: BotSeat[],
  visibleHistory: { speaker: string; text: string }[],
  humanTexts: string[],
): { player_id: string; context: AgentContext }[] {
  const styleProfile = observeStyle(humanTexts);
  const seatOf = new Map(bots.map((b) => [b.id, b.seat]));
  return pending
    .filter((m) => seatOf.has(m.player_id))
    .map((m) => ({
      player_id: m.player_id,
      context: {
        persona: personaForSeat(seatOf.get(m.player_id) as number),
        phase: 'chat' as const,
        visibleHistory,
        styleProfile,
        suspicionOnMe: 0.2,
      },
    }));
}

/**
 * 순수 — LLM 텍스트를 풀 문구 길이대(1~13자 기준 지연)에 맞게 공백 경계에서 자른다.
 * 지연은 insert 시점 풀 문구 길이로 계산됐다 — 그 지연에 긴 글이 실리면
 * "짧게 친 것치고 길다"가 미세한 봇 신호가 된다 (I1 잔여 신호 완화).
 */
export function capChatReply(text: string, maxLen = 25): string {
  const t = text.trim();
  if (t.length <= maxLen) return t;
  const cut = t.slice(0, maxLen + 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > 0 ? cut.slice(0, sp) : t.slice(0, maxLen)).trim();
}

/**
 * 사람 메시지 처리(send_message → bot_reply) 성공 직후,
 * app/api/message/route.ts가 응답 반환 뒤(after)에 부른다.
 */
export async function regenerateBotChatReply(roomId: string): Promise<void> {
  try {
    const db = getServiceClient();

    const { data: room } = await db
      .from('rooms')
      .select('id, phase')
      .eq('id', roomId)
      .maybeSingle();
    if (!room || room.phase !== 'chat') return;

    const { data: playerRows } = await db
      .from('players')
      .select('id, seat, nickname, is_bot')
      .eq('room_id', roomId);
    const players = (playerRows ?? []) as {
      id: string;
      seat: number;
      nickname: string;
      is_bot: boolean;
    }[];
    const bots: BotSeat[] = players.filter((p) => p.is_bot).map((p) => ({ id: p.id, seat: p.seat }));
    if (bots.length === 0) return;
    const botIds = new Set(bots.map((b) => b.id));

    // 교체 가능한 행 = 봇 소유 + 아직 공개 전. 사람 메시지는 visible_at이 항상
    // 현재라 이 필터에 절대 걸리지 않는다. 쿨다운으로 bot_reply가 안 넣었으면 0행.
    const nowIso = new Date().toISOString();
    const { data: pendingRows } = await db
      .from('messages')
      .select('id, player_id, visible_at')
      .eq('room_id', roomId)
      .gt('visible_at', nowIso)
      .in('player_id', [...botIds])
      .order('visible_at', { ascending: false });
    // 봇당 최신 한 건만 — 같은 봇의 pending이 겹치면(이론상) 답도 한 번만 만든다
    const pending: PendingBotMessage[] = [];
    const seen = new Set<string>();
    for (const row of (pendingRows ?? []) as { id: string; player_id: string }[]) {
      if (seen.has(row.player_id)) continue;
      seen.add(row.player_id);
      pending.push({ id: row.id, player_id: row.player_id });
    }
    if (pending.length === 0) return;

    // 대화 맥락 = 공개된 메시지만 (pending 자신의 풀 문구가 새면 LLM이 자기
    // 폴백에 대꾸한다). 말투 관측은 사람 발화만 — 봇 풀 문구를 배우면 안 된다.
    const { data: revealedRows } = await db
      .from('messages')
      .select('player_id, text')
      .eq('room_id', roomId)
      .lte('visible_at', nowIso)
      .order('visible_at', { ascending: true })
      .limit(30);
    const nickOf = new Map(players.map((p) => [p.id, p.nickname]));
    const revealed = (revealedRows ?? []) as { player_id: string; text: string }[];
    const visibleHistory = revealed.map((m) => ({
      speaker: nickOf.get(m.player_id) ?? '?',
      text: m.text,
    }));
    const humanTexts = revealed.filter((m) => !botIds.has(m.player_id)).map((m) => m.text);

    // LLM 호출 — 병렬·8초 컷·agent_logs 기록은 /api/agent가 담당한다 (I4)
    const res = await fetch(`${AGENT_SELF_URL}/api/agent`, {
      method: 'POST',
      headers: agentHeaders(),
      body: JSON.stringify({
        room_id: roomId,
        bots: buildChatReplyJobs(pending, bots, visibleHistory, humanTexts),
      }),
    });
    if (!res.ok) {
      console.error(`[chat-reply] /api/agent ${res.status} — 풀 문구 유지 (room ${roomId})`);
      return;
    }
    const data = (await res.json()) as {
      results?: { player_id: string; output: AgentOutput; fallback: boolean }[];
    };

    const rowOf = new Map(pending.map((m) => [m.player_id, m.id]));
    let replaced = 0;
    for (const r of data.results ?? []) {
      // LLM 실패분·구제 문구("ㅇㅇ")보다 풀 문구가 낫다 — 덮지 않는다
      if (r.fallback) continue;
      const text = capChatReply(r.output.messages.join(' '));
      if (!text || FALLBACK_POOL.includes(text)) continue;
      const rowId = rowOf.get(r.player_id);
      if (!rowId) continue;

      const { error, count } = await db
        .from('messages')
        .update({ text }, { count: 'exact' })
        .eq('id', rowId)
        // 그 사이 타이핑 지연이 끝나 공개됐으면 건드리지 않는다 — 공개 후 바뀌는 글은 봇 신호다 (I1)
        .gt('visible_at', new Date().toISOString());
      if (!error && (count ?? 0) > 0) replaced += 1;
    }

    console.log(
      `[chat-reply] 봇 반응 ${replaced}/${pending.length} LLM 교체 (room ${roomId.slice(0, 8)})`,
    );
  } catch (e) {
    // 봇 입이 채팅을 막으면 안 된다 (§12.3) — 기록만 남기고 조용히 물러난다
    console.error('[chat-reply]', e instanceof Error ? e.message : String(e));
  }
}
