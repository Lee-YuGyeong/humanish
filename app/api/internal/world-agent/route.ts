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
 * 실패는 전부 조용히 빈 결과다. 부르는 쪽(워커)에는 이미 발화 자리가 잡혀 있어서
 * 여기가 뭘 못 해도 타이밍은 그대로다 — 그 자리가 말없이 지나갈 뿐이다 (SPEC §12.3).
 * 월드에는 대신 내보낼 하드코딩 문구가 없다 (lib/server/world-ai.ts).
 */

import { timingSafeEqual } from '@/lib/mp/ticket';
import { fitChatReply } from '@/lib/agent/chat-reply';
import { observeStyle } from '@/lib/agent/disguise';
import { FALLBACK_POOL, type AgentContext, type AgentOutput } from '@/lib/agent/generate';
import { personaForSeat } from '@/lib/agent/persona';
import { AGENT_SELF_URL, agentHeaders } from '@/lib/agent/prefill';
import { worldPersonaForSeat } from '@/lib/agent/world-persona';
import { apiError, readJson } from '@/lib/server/auth';
import { buildWorldRoster } from '@/lib/server/world-ai';

export const dynamic = 'force-dynamic';

/** /api/agent의 MAX_BOTS와 같은 값 — 정원 상한이다 (SPEC §4). */
const MAX_BOTS = 8;
const MAX_HISTORY = 30;
const MAX_TEXT_LEN = 300;
const MAX_NICK_LEN = 20;

/**
 * 발화 길이 상한. **타이밍과는 무관하다** — bots.ts 의 speakAt 은 발화 길이가 아니라
 * 미리 뽑은 글자 수 예산으로 정해진다(BOT_TYPE_CHARS_*). 그래서 여기서는 "사람이
 * 채팅에 이보다 길게 쓰지 않는다"만 보면 된다.
 *
 * ★ 넘치면 **자르지 않고 버린다.** 잘린 말끝("…주말에 일도 많이")은 폴백 문구보다
 *   훨씬 더 봇 티가 난다 — 사람은 문장을 하다 말지 않는다 (실측).
 *   30자로 뒀더니 질문에 제대로 답한 문장이 되레 걸려 대부분 버려졌다(실측 2/3).
 *   8b 가 실제로 내놓는 길이(24~33자)를 담을 만큼 올린다.
 */
const MAX_REPLY_LEN = 42;

interface Body {
  room_id?: string;
  player_ids?: string[];
  history?: { nickname?: string; text?: string; human?: boolean }[];
  /** 반응을 부른 사람 발화. 스스로 말을 꺼내는 경우에는 없다. */
  trigger?: string | null;
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

/** 결과가 없는 것은 에러가 아니다. 부르는 쪽은 그 발화 자리를 말없이 넘긴다. */
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

    // 명단을 여기서 다시 만든다. 워커가 보낸 id를 그대로 믿지 않는다 — 봇이 아닌
    // 자리로 발화를 만들어 달라고 하면 사람 자리에 봇 말이 실린다.
    // world-room 과 **같은 함수**를 쓴다. 한쪽만 월드 AI를 알면 그 AI는 영원히
    // 아무 말도 못 한다 (실측으로 한 번 겪은 경로다 — 그때는 풀 문구만 말했다).
    const roster = await buildWorldRoster(roomId);
    if (!roster) return notFound();

    const bots = roster.seats.filter((s) => s.is_bot && wanted.includes(s.id));
    if (bots.length === 0) return empty();

    const history = sanitizeHistory(body.history);
    // 말투 관측은 **사람 발화만** — 봇 풀 문구를 배우면 봇끼리 서로 닮아간다
    // (lib/agent/chat-reply.ts와 같은 이유).
    const styleProfile = observeStyle(history.filter((h) => h.human).map((h) => h.text));

    /*
     * ★ 반응을 부른 **그 한마디**를 question 으로 넘긴다 (워커가 실어 보낸다).
     *
     * 안 넘기면 buildMessages 의 chat 분기("대화 흐름에 자연스럽게 한마디 끼어들어라")를
     * 타는데, 누가 말을 걸어서 대꾸하는 상황에는 그게 안 맞는다 — 흐름에는 맞지만
     * 질문에는 안 맞는 답이 나온다 (실측: "안녕" → "그러게").
     * 반대로 **스스로 말을 꺼낼 때는 trigger 가 없고**, 그때는 chat 분기가 맞다.
     *
     * 기록에서는 뺀다. 남겨두면 같은 문장이 [대화 기록]과 [지금 답할 질문]에 두 번
     * 나오고, generate.ts 의 에코 검사가 그걸 베끼기로 오인해 폴백으로 바꾼다.
     */
    const trigger = typeof body.trigger === 'string' ? body.trigger.slice(0, MAX_TEXT_LEN) : null;
    const triggerIdx = trigger ? history.map((h) => h.text).lastIndexOf(trigger) : -1;
    const visibleHistory = history
      .filter((_, i) => i !== triggerIdx)
      .map((h) => ({ speaker: h.nickname, text: h.text }));

    /*
     * ★ 월드 AI 에게는 **월드 인물**을 준다 (lib/agent/world-persona.ts).
     *   게임 페르소나는 의심·투표를 전제로 만들어져서, 그냥 노는 공간에서는
     *   동문서답으로 보인다 (실측: "안녕하세요" → "야 근데 야근 너무 힘들어").
     *   게임이 시작된 방의 진짜 봇은 그대로 게임 페르소나를 쓴다.
     */
    const jobs = bots.map((b) => ({
      player_id: b.id,
      context: {
        persona: b.synthetic ? worldPersonaForSeat(b.seat) : personaForSeat(b.seat),
        // 월드 AI는 무대도 라운지다 — 시스템 프롬프트에서 게임 문장이 전부 빠진다
        // (generate.ts WORLD_RULES). 페르소나가 "게임 중이 아니다"로 게임 프레임을
        // 되받아치던 구조를 대체한다. 게임이 시작된 방의 진짜 봇은 게임 무대 그대로.
        setting: b.synthetic ? ('world' as const) : ('game' as const),
        phase: 'chat' as const,
        question: trigger ?? undefined,
        visibleHistory,
        styleProfile,
        suspicionOnMe: 0.2,
      } satisfies AgentContext,
    }));

    const res = await fetch(`${AGENT_SELF_URL}/api/agent`, {
      method: 'POST',
      headers: agentHeaders(),
      body: JSON.stringify({
        room_id: roomId,
        bots: jobs,
        // 월드 AI 는 players 행이 없어 agent_logs 외래키에 걸린다 (lib/server/world-ai.ts).
        no_log: bots.some((b) => b.synthetic),
      }),
    });
    if (!res.ok) {
      console.error(`[world-agent] /api/agent ${res.status} — 이번 발화는 거른다 (room ${roomId})`);
      return empty();
    }

    const data = (await res.json()) as {
      results?: { player_id: string; output: AgentOutput; fallback: boolean }[];
    };

    const results: { player_id: string; text: string }[] = [];
    for (const r of data.results ?? []) {
      // LLM 실패분·구제 문구("ㅇㅇ")는 버린다. 월드에는 대신 쓸 풀이 없으니 그 자리는
      // 그냥 조용히 지나간다 — 맥락 없는 한 글자보다 침묵이 사람에 가깝다.
      if (r.fallback) continue;

      // **첫 발화만** 쓴다. 2D는 두 줄을 각자의 지연으로 따로 보내지만(§5.4) 월드의
      // 말풍선은 하나다. 이어붙이면 길이만 두 배가 되고 그만큼 잘려 나간다.
      // 상한을 넘으면 자르지 않고 버린다(fitChatReply → null) — 잘린 말끝은 폴백
      // 문구보다 봇 티가 난다 (실측).
      const text = fitChatReply(r.output.messages[0] ?? '', MAX_REPLY_LEN);
      if (!text || FALLBACK_POOL.includes(text)) continue;

      results.push({ player_id: r.player_id, text });
    }

    return Response.json({ ok: true, results }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return apiError(e);
  }
}
