/**
 * 워커 전용 — 3D 월드 봇의 반응 한 줄. 소유: A (껍데기) · 내용: B의 lib/agent
 *
 * POST /api/internal/world-agent
 *   Authorization: Bearer <WORLD_SHARED_SECRET>
 *   { room_id, player_ids: [...], history: [{ nickname, text, human }] }
 *   → { ok, results: [{ player_id, text }] }
 *
 * ┌─ 왜 워커가 아니라 여기가 조립하는가 ───────────────────────────────────────┐
 * │ /api/agent 는 호출자가 AgentContext(= 페르소나 시스템 프롬프트 통째)를 만들어  │
 * │ 넣게 돼 있다. 그걸 워커에 두면 프롬프트가 두 벌이 되고, B 소유 파일이 A 워커로 │
 * │ 복사된다. 그래서 워커는 "누가·어떤 대화 뒤에" 만 보내고, 페르소나·말투 관측·   │
 * │ 프롬프트 조립·LLM 키는 전부 이 오리진 안에 남는다 (I4).                      │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ world-room 과 같은 세 가지 ───────────────────────────────────────────────┐
 * │  1. 공유 비밀 없이는 404. "있는데 못 들어간다"는 것조차 알리지 않는다.        │
 * │  2. CORS 헤더를 **주지 않는다.** 브라우저는 응답을 읽을 수 없다.             │
 * │  3. 고칠 때는 "이게 브라우저로 갈 수 있나"를 먼저 묻는다.                    │
 * │     — 여기 응답은 봇의 발화 그 자체다. 브라우저가 미리 읽으면 누가 봇인지     │
 * │       말하기 전에 알게 된다 (I1).                                          │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * 실패는 전부 조용히 빈 결과다. 부르는 쪽(워커)에는 이미 풀 문구가 예약돼 있어서
 * 여기가 뭘 못 해도 봇은 제 시각에 제 말을 한다 (SPEC §12.3).
 */

import { timingSafeEqual } from '@/lib/mp/ticket';
import { capChatReply } from '@/lib/agent/chat-reply';
import { observeStyle } from '@/lib/agent/disguise';
import { FALLBACK_POOL, type AgentContext, type AgentOutput } from '@/lib/agent/generate';
import { personaForSeat } from '@/lib/agent/persona';
import { AGENT_SELF_URL, agentHeaders } from '@/lib/agent/prefill';
import { apiError, readJson } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/supabase';

export const dynamic = 'force-dynamic';

/** /api/agent의 MAX_BOTS와 같은 값 — 정원 상한이다 (SPEC §4). */
const MAX_BOTS = 8;
const MAX_HISTORY = 30;
const MAX_TEXT_LEN = 300;
const MAX_NICK_LEN = 20;

/**
 * 발화 길이 상한. speakAt은 **풀 문구 길이**로 이미 정해졌으므로(bots.ts), 그 지연에
 * 긴 글이 실리면 "짧게 친 것치고 길다"가 미세한 봇 신호가 된다 (I1).
 * 풀 문구가 7~13자대라, 지연 오차(글자당 55ms)를 1초 안에 묶으려면 이쯤이 상한이다.
 *
 * ★ 넘치면 **자르지 않고 버린다.** 잘린 말끝("…주말에 일도 많이")은 폴백 문구보다
 *   훨씬 더 봇 티가 난다 — 사람은 문장을 하다 말지 않는다. 버리면 풀 문구가 그대로
 *   나가고, 그건 최소한 온전한 한국어다 (실측: 3건 중 2건이 잘려 나왔다).
 */
const MAX_REPLY_LEN = 30;

interface Body {
  room_id?: string;
  player_ids?: string[];
  history?: { nickname?: string; text?: string; human?: boolean }[];
}

interface ChatLine {
  nickname: string;
  text: string;
  human: boolean;
}

/** 비밀이 틀리거나 방이 없거나 — 밖에서는 구분되지 않는다. */
function notFound(): Response {
  return new Response(null, { status: 404 });
}

/** 결과가 없는 것은 에러가 아니다. 부르는 쪽은 풀 문구로 그냥 간다. */
function empty(): Response {
  return Response.json({ ok: true, results: [] }, { headers: { 'cache-control': 'no-store' } });
}

function sanitizeHistory(raw: Body['history']): ChatLine[] {
  return (raw ?? [])
    .filter((h): h is { nickname?: string; text: string; human?: boolean } =>
      typeof h?.text === 'string' && h.text.trim() !== '',
    )
    .slice(-MAX_HISTORY)
    .map((h) => ({
      nickname: (h.nickname || '익명?').slice(0, MAX_NICK_LEN),
      text: h.text.slice(0, MAX_TEXT_LEN),
      human: h.human !== false,
    }));
}

export async function POST(req: Request): Promise<Response> {
  try {
    const secret = process.env.WORLD_SHARED_SECRET;
    if (!secret) return notFound();

    const auth = req.headers.get('authorization') ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!timingSafeEqual(bearer, secret)) return notFound();

    const body = await readJson<Body>(req);
    const roomId = body.room_id;
    const wanted = Array.isArray(body.player_ids) ? body.player_ids.slice(0, MAX_BOTS) : [];
    if (!roomId || wanted.length === 0) return notFound();

    const db = getServiceClient();

    // 좌석을 여기서 다시 읽는다. 워커가 보낸 id를 그대로 믿지 않는다 —
    // 봇이 아닌 자리로 발화를 만들어 달라고 하면 사람 자리에 봇 말이 실린다.
    // 방 스코프를 반드시 건다 (I10).
    const { data: playerRows } = await db
      .from('players')
      .select('id, seat, is_bot')
      .eq('room_id', roomId);
    const bots = ((playerRows ?? []) as { id: string; seat: number; is_bot: boolean }[])
      .filter((p) => p.is_bot && wanted.includes(p.id));
    if (bots.length === 0) return empty();

    const history = sanitizeHistory(body.history);
    // 말투 관측은 **사람 발화만** — 봇 풀 문구를 배우면 봇끼리 서로 닮아간다
    // (lib/agent/chat-reply.ts와 같은 이유).
    const styleProfile = observeStyle(history.filter((h) => h.human).map((h) => h.text));
    const visibleHistory = history.map((h) => ({ speaker: h.nickname, text: h.text }));

    // question을 싣지 않으므로 buildMessages의 chat 분기("자연스럽게 한마디")를 탄다.
    // 월드에는 페이즈가 없다 — 워커는 게임 규칙을 모르고, 여기서도 알려주지 않는다.
    const jobs = bots.map((b) => ({
      player_id: b.id,
      context: {
        persona: personaForSeat(b.seat),
        phase: 'chat' as const,
        visibleHistory,
        styleProfile,
        suspicionOnMe: 0.2,
      } satisfies AgentContext,
    }));

    const res = await fetch(`${AGENT_SELF_URL}/api/agent`, {
      method: 'POST',
      headers: agentHeaders(),
      body: JSON.stringify({ room_id: roomId, bots: jobs }),
    });
    if (!res.ok) {
      console.error(`[world-agent] /api/agent ${res.status} — 풀 문구 유지 (room ${roomId})`);
      return empty();
    }

    const data = (await res.json()) as {
      results?: { player_id: string; output: AgentOutput; fallback: boolean }[];
    };

    const results: { player_id: string; text: string }[] = [];
    for (const r of data.results ?? []) {
      // LLM 실패분·구제 문구("ㅇㅇ")보다 방의 풀 문구가 낫다 — 덮지 않는다.
      if (r.fallback) continue;

      // **첫 발화만** 쓴다. 2D는 두 줄을 각자의 지연으로 따로 보내지만(§5.4) 월드의
      // 말풍선은 하나다. 이어붙이면 길이만 두 배가 되고 그만큼 잘려 나간다.
      const text = capChatReply(r.output.messages[0] ?? '', MAX_REPLY_LEN);
      if (!text || FALLBACK_POOL.includes(text)) continue;
      // capChatReply가 손을 댔다 = 상한을 넘었다 → 잘린 말끝을 내보내느니 버린다.
      if (text !== (r.output.messages[0] ?? '').trim()) continue;

      results.push({ player_id: r.player_id, text });
    }

    return Response.json({ ok: true, results }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return apiError(e);
  }
}
