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
import { FALLBACK_POOL, type AgentContext, type AgentOutput } from '@/lib/agent/generate';
import { getServiceClient } from '@/lib/server/supabase';
import type { Phase } from '@/lib/game/types';

/**
 * self-fetch 대상. 로컬 개발 기본값 — 배포에서 쓰게 되면 env로 넘긴다. chat-reply.ts와 공유.
 *
 * ★ `||`다, `??`가 아니다. `.env.local`에 `AGENT_SELF_URL=`(이름만, 빈 값)로 두면
 *   process.env 값이 ''인데, ''는 nullish가 아니라 `??`를 통과한다. 그대로 쓰면
 *   self-fetch가 상대 URL(`/api/agent`)이 되어 서버 fetch가 "Failed to parse URL"로
 *   즉사하고, 봇 전원이 조용히 풀 문구로 떨어진다 (실측 — 한 판 전체 LLM 0%).
 */
export const AGENT_SELF_URL = process.env.AGENT_SELF_URL || 'http://127.0.0.1:3000';

/**
 * self-fetch 헤더. 프로덕션 /api/agent는 내부 Bearer(AGENT_SHARED_SECRET)로만 열린다 —
 * world-room 규약과 같다. 비밀이 없으면(개발) 그냥 간다. chat-reply.ts와 공유.
 * LLM API 키가 아니다 — 그건 여전히 라우트만 안다 (I4).
 */
export function agentHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const secret = process.env.AGENT_SHARED_SECRET;
  if (secret) headers.authorization = `Bearer ${secret}`;
  return headers;
}

/** 투표 이유 상한 — app/api/vote/route.ts의 MAX_REASON_LEN과 같은 값. */
const MAX_REASON_LEN = 200;

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

/** vote 페이즈 순수부 입력 — SQL(on_enter_phase)이 이미 넣은 봇 투표 한 건. */
export interface BotVote {
  voter_id: string;
  seat: number;
  targetNickname: string;
}

/**
 * 순수 — 봇 투표 목록으로 /api/agent 요청 몸통을 만든다.
 * 대상은 SQL이 정했고 바꾸지 않는다 — 이유만 대상에 맞게 짓는다 (§8.1은 범위 밖).
 * vote 시점엔 지나간 답변이 전부 공개라(§13-4 통과 후) 기록을 그대로 싣는다.
 */
export function buildVoteReasonJobs(
  votes: BotVote[],
  visibleHistory: { speaker: string; text: string }[],
  humanTexts: string[],
): { player_id: string; context: AgentContext }[] {
  const styleProfile = observeStyle(humanTexts);
  return votes.map((v) => ({
    player_id: v.voter_id,
    context: {
      persona: personaForSeat(v.seat),
      phase: 'vote' as const,
      voteTarget: v.targetNickname,
      visibleHistory,
      styleProfile,
      suspicionOnMe: 0.2,
    },
  }));
}

/**
 * 전환 성공 직후 lib/server/phase.ts가 응답 반환 뒤(after)에 부른다.
 * question·target은 봇 답변을, vote는 봇 투표 이유를 덮는다. 그 외엔 조용히 끝난다.
 */
export async function regenerateBotAnswers(roomId: string): Promise<void> {
  try {
    const db = getServiceClient();

    const { data: room } = await db
      .from('rooms')
      .select('id, phase, round')
      .eq('id', roomId)
      .maybeSingle();
    if (!room) return;
    if (room.phase === 'vote') return regenerateBotVoteReasons(db, roomId);
    if (room.phase !== 'question' && room.phase !== 'target') return;

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
      headers: agentHeaders(),
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

/**
 * vote 진입 훅 — SQL(on_enter_phase)이 무작위 대상 + 풀 이유로 미리 넣어둔
 * 봇 votes의 reason만 LLM으로 덮는다. **target_id는 절대 바꾸지 않는다** (§8.1).
 *
 * votes에는 answers의 visible_at 같은 행 단위 게이트가 없다 — 공개가 방 phase에
 * 달려 있다 (RLS: reveal·replay에서만 select). 그래서 UPDATE 직전에 phase를
 * 재확인한다. 재확인과 UPDATE 사이의 조기 종료 레이스는 허용한다: votes는
 * Realtime 미대상이고 reveal 화면은 진입 시 1회 fetch라, 그 틈에 덮인 이유의
 * 풀 버전을 본 클라이언트가 없다 — "바뀌는 글" 신호(I1)가 못 된다.
 */
async function regenerateBotVoteReasons(
  db: ReturnType<typeof getServiceClient>,
  roomId: string,
): Promise<void> {
  try {
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
    const byId = new Map(players.map((p) => [p.id, p]));
    const botIds = new Set(players.filter((p) => p.is_bot).map((p) => p.id));
    if (botIds.size === 0) return;

    const { data: voteRows } = await db
      .from('votes')
      .select('voter_id, target_id')
      .eq('room_id', roomId)
      .in('voter_id', [...botIds]);
    const botVotes = ((voteRows ?? []) as { voter_id: string; target_id: string }[])
      .map((v) => {
        const voter = byId.get(v.voter_id);
        const target = byId.get(v.target_id);
        return voter && target
          ? { voter_id: v.voter_id, seat: voter.seat, targetNickname: target.nickname }
          : null;
      })
      .filter((v): v is BotVote => v !== null);
    if (botVotes.length === 0) return;

    // vote 시점엔 지나간 답변이 전부 공개다 (advance_phase 4.5단계). 채팅 공개분과
    // 합쳐 근거로 준다 — "익명3 아까 답 좀 이상했음" 같은 이유가 가능해진다.
    // 말투 관측은 여전히 사람 발화만 (봇 풀 문구를 배우면 안 된다).
    const nowIso = new Date().toISOString();
    const [{ data: ansRows }, { data: msgRows }] = await Promise.all([
      db
        .from('answers')
        .select('player_id, text, visible_at')
        .eq('room_id', roomId)
        .lte('visible_at', nowIso)
        .limit(30),
      db
        .from('messages')
        .select('player_id, text, visible_at')
        .eq('room_id', roomId)
        .lte('visible_at', nowIso)
        .limit(30),
    ]);
    const revealed = (
      [...(ansRows ?? []), ...(msgRows ?? [])] as {
        player_id: string;
        text: string;
        visible_at: string;
      }[]
    )
      .sort((a, b) => a.visible_at.localeCompare(b.visible_at))
      .slice(-30);
    const visibleHistory = revealed.map((r) => ({
      speaker: byId.get(r.player_id)?.nickname ?? '?',
      text: r.text,
    }));
    const humanTexts = revealed.filter((r) => !botIds.has(r.player_id)).map((r) => r.text);

    // LLM 호출 — 병렬·8초 컷·agent_logs 기록은 /api/agent가 담당한다 (I4)
    const res = await fetch(`${AGENT_SELF_URL}/api/agent`, {
      method: 'POST',
      headers: agentHeaders(),
      body: JSON.stringify({
        room_id: roomId,
        bots: buildVoteReasonJobs(botVotes, visibleHistory, humanTexts),
      }),
    });
    if (!res.ok) {
      console.error(`[prefill] /api/agent ${res.status} — 투표 이유 풀 문구 유지 (room ${roomId})`);
      return;
    }
    const data = (await res.json()) as {
      results?: { player_id: string; output: AgentOutput; fallback: boolean }[];
    };

    // 조기 종료로 이미 reveal이면 전부 스킵 — 공개 후 바뀌는 이유는 봇 신호다 (I1)
    const { data: recheck } = await db.from('rooms').select('phase').eq('id', roomId).maybeSingle();
    if (!recheck || recheck.phase !== 'vote') return;

    let replaced = 0;
    for (const r of data.results ?? []) {
      if (r.fallback) continue;
      const reason = r.output.messages.join(' ').trim().slice(0, MAX_REASON_LEN);
      // 금칙 필터가 바꿔치운 구제 문구("ㅇㅇ")는 투표 이유로 부자연 — 풀 이유가 낫다
      if (!reason || FALLBACK_POOL.includes(reason)) continue;

      const { error } = await db
        .from('votes')
        .update({ reason })
        .eq('room_id', roomId)
        .eq('voter_id', r.player_id);
      if (!error) replaced += 1;
    }

    console.log(
      `[prefill] vote — 봇 이유 ${replaced}/${botVotes.length} LLM 교체 (room ${roomId.slice(0, 8)})`,
    );
  } catch (e) {
    // 봇 입이 게임을 막으면 안 된다 (§12.3) — 기록만 남기고 조용히 물러난다
    console.error('[prefill]', e instanceof Error ? e.message : String(e));
  }
}
