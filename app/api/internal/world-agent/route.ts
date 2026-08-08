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

import { after } from 'next/server';
import { timingSafeEqual } from '@/lib/mp/ticket';
import {
  applyTypo,
  fitChatReply,
  observeStyle,
  stretchLaugh,
  stripAvoidedPunct,
} from '@/lib/agent/disguise';
import {
  ASK_BACK_CHANCE,
  ASK_BACK_CHANCE_INITIATE,
  isFallbackLine,
  type AgentContext,
  type AgentOutput,
} from '@/lib/agent/generate';
import { describeNow } from '@/lib/agent/clock';
import { mergeFacts, pinFact } from '@/lib/agent/facts';
import { agentHeaders, agentSelfUrl } from '@/lib/agent/self-call';
import { WORLD_PERSONAS } from '@/lib/agent/world-persona';
import { apiError, readJson } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/supabase';
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

/**
 * 워커의 예산에서 빼 두는 왕복 여유 (ms) — self-fetch(/api/agent) 왕복 + 좌석 명단 조회.
 * 이만큼을 빼야 **오리진이 워커보다 먼저** 끊긴다 (deadline_ms 를 계산하는 자리의 상자).
 */
const AGENT_ROUNDTRIP_HEADROOM_MS = 3_500;

interface Body {
  room_id?: string;
  player_ids?: string[];
  history?: { nickname?: string; text?: string; human?: boolean }[];
  /** 반응을 부른 사람 발화. 스스로 말을 꺼내는 경우에는 없다. */
  trigger?: string | null;
  /**
   * 방금 일어난 일. 발화가 아니라 **사건**이다 ("익명3이 방금 들어왔다").
   * 워커가 입·퇴장에서 싣는다 (worker/src/room-do.ts). trigger와 같이 오지 않는다.
   */
  event?: string | null;
  /**
   * 봇이 그 판에서 지금까지 지어낸 사실 (lib/agent/facts.ts). `{ player_id: [...] }`.
   *
   * ★ 병합은 **여기서만** 한다. 워커는 돌려준 배열을 그대로 보관했다가 다음에
   *   그대로 실어 보낸다 — 규칙이 두 벌이 되면 그 순간 갈린다 (lib/mp/가 겪는 문제).
   */
  facts?: Record<string, unknown>;
  /**
   * 지금 이 방에서 **판이 도는가** (worker/src/world-agent.ts 의 RoundContext).
   *
   * ★ 이 값 없이는 여기서 알 수 없다. 월드의 판은 `rooms.phase` 를 'lobby' 로 둔 채
   *   돌기 때문에(app/api/room/start-world), buildWorldRoster 가 보는 값만으로는
   *   "주제가 떠 있는 45초"와 "라운지 잡담"이 똑같아 보인다.
   */
  in_round?: boolean;
  /** speak 창에 떠 있는 주제. trigger 와 같으면 **주제에 답하는 차례**다. */
  round_topic?: string | null;
  /**
   * 워커가 이 요청을 **얼마나 기다려 주는가** (ms). 여기서 왕복 여유를 빼서
   * LLM 컷(deadline_ms)을 잡는다 — 상수로 두면 워커의 단계 클램프와 갈린다
   * (아래 deadline_ms 계산 자리의 상자). 안 오면(구 워커) 예전 값으로 떨어진다.
   */
  budget_ms?: number;
}

interface ChatLine {
  nickname: string;
  text: string;
  human: boolean;
}

/**
 * 이 AI 가 연기할 월드 인물 — **방마다 다르고, 한 방 안에서는 늘 같다.**
 *
 * ┌─ 왜 랜덤이 아니라 해시인가 ───────────────────────────────────────────────┐
 * │ 이 함수는 봇이 한마디 할 때마다 불린다. 말할 때마다 인물이 바뀌면 말투가      │
 * │ 문장마다 갈리고, 그건 사람이 절대 안 하는 짓이라 그 자체로 봇 표식이다 (I1).  │
 * │ 해시면 언제 불려도 같은 인물이고, DO 가 재시작해도 이어진다.                 │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 왜 seat 를 넣으면 안 되는가 (신고: "말투가 계속 바뀐다") ──────────────────┐
 * │ 한때 `roomId:seat` 를 해시했다. seat 가 방 안에서 고정이라고 봤는데 **아니다** │
 * │ — 월드 AI 는 늘 **비어 있는 첫 자리**를 받는다 (lib/server/world-ai.ts 의     │
 * │ buildWorldRoster). 사람이 1번에 있으면 AI 는 2번, 그 사람이 나가면 AI 가      │
 * │ 1번으로 당겨진다. 라운지는 사람이 쉼없이 드나드는 곳이라 **입·퇴장 한 번마다   │
 * │ 인물이 통째로 갈렸다.** 워커도 좌석 id 목록이 바뀌면 봇을 다시 세우므로        │
 * │ (room-do.ts 의 `if (before !== after) this.bots = null`) 그대로 새 인물이 된다.│
 * │                                                                          │
 * │ 그래서 **id 를 해시한다.** …고 적어 두었는데, 그게 틀렸다. 아래를 볼 것.      │
 * │ ★ 자리에서 파생되는 값은 무엇이든 이 자리에 쓰지 않는다 — 자리는 움직인다.    │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ ★ id 도 자리에서 파생된다 (2026-08-07, 이 주석이 틀렸었다) ────────────────┐
 * │ 위 상자는 "월드 AI 의 id 는 stableUuid(roomId, index) 라 자리가 밀려도       │
 * │ 그대로"라고 적어 두었다. **아니다** — lib/server/world-ai.ts 는              │
 * │ `stableUuid(roomId, seat)` 이고 그 seat 는 `maxTaken + 1`, 즉 **사람이 새    │
 * │ 자리를 채울 때마다 밀린다.** 그러니 id 를 해시해도 seat 를 해시한 것과 같고,  │
 * │ 위 상자가 없애려던 증상("입·퇴장 한 번마다 인물이 통째로 갈렸다")이 그대로    │
 * │ 살아 있었다.                                                                │
 * │                                                                            │
 * │ world-ai.ts 쪽을 고칠 수는 없다. 거기서 id 를 자리에 묶은 건 **닉네임이       │
 * │ 익명{seat} 이라서** 다 — 자리가 밀렸는데 id 가 그대로면 워커의 명부 diff 가   │
 * │ 아무 이벤트도 못 내고 같은 익명N 이 화면에 둘 남는다 (그 파일의 상자).        │
 * │                                                                            │
 * │ 그래서 **인물을 id 가 아니라 방에 묶는다.** 월드 AI 는 방마다 1대이고         │
 * │ (AI_SEATS_PER_ROUND), 방 id 는 판이 끝날 때까지 안 움직이는 유일한 값이다.    │
 * │ AI 를 여럿으로 늘려도 갈리도록 **좌석 순 몇 번째 AI 인가**를 같이 넣는다 —    │
 * │ 그 순번은 자리가 통째로 밀려도 그대로다.                                     │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
function worldPersonaFor(stableId: string): (typeof WORLD_PERSONAS)[number] {
  // FNV-1a. 암호용이 아니라 고르게 흩뿌리기만 하면 된다 — uuid 앞자리만 봐서는
  // 서로 비슷해 같은 인물로 몰린다.
  let h = 2166136261;
  for (let i = 0; i < stableId.length; i += 1) {
    h ^= stableId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return WORLD_PERSONAS[Math.abs(h) % WORLD_PERSONAS.length];
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
    // 말투 관측은 **사람 발화만** — 봇 풀 문구를 배우면 봇끼리 서로 닮아간다.
    // (걷어낸 chat-reply.ts 계층도 같은 이유로 사람 발화만 봤다 — 4a60b8f)
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
     *   동문서답으로 보였다 (실측: "안녕하세요" → "야 근데 야근 너무 힘들어").
     *   그 게임 페르소나 자체가 2026-08-08 에 지워졌다 — 2D 게임 방이 흐름에서
     *   빠지면서 "게임이 시작된 방의 진짜 봇" 분기도 함께 없어졌다.
     */
    /*
     * ★ 입·퇴장 같은 **사건**은 trigger 가 아니라 event 로 온다 (generate.ts 의
     *   worldEvent 분기). 둘이 같이 오면 사람 말이 먼저다 — 누가 말을 걸었는데
     *   "누가 들어왔네"로 답하면 그게 동문서답이다.
     */
    const event = typeof body.event === 'string' ? body.event.slice(0, MAX_TEXT_LEN) : null;

    /*
     * ┌─ 무대는 `synthetic` 이 아니라 **판이 도는가**로 가른다 ────────────────────┐
     * │ (신고 2026-08-07: "주제가 나오면 가만히 있는다")                            │
     * │                                                                            │
     * │ 여기는 월드 AI 면 무조건 setting:'world' 를 깔았다. 그 무대의 규칙은        │
     * │ "지금은 판이 시작되기 전이고 … 아직 아무도 질문을 받지 않았다"이다          │
     * │ (generate.ts 의 WORLD_RULES). 그런데 월드의 판은 rooms.phase 를 'lobby' 로  │
     * │ 둔 채 돌아서, **주제가 화면에 떠 있는 45초 동안에도** AI 는 그 문장을 듣고  │
     * │ 있었다. 주제는 [지금 답할 질문]이 아니라 [방금 너한테 온 말]로 들어갔고,    │
     * │ 제 규칙과 어긋나는 답은 아래 거르개(fallback·isEvasive·상한)에 걸려         │
     * │ 통째로 버려졌다 — 그래서 화면에서는 침묵으로 보였다.                        │
     * │                                                                            │
     * │ AgentContext.setting 의 주석이 처음부터 이렇게 적어 두었다:                 │
     * │ **"두 무대의 차이는 판이 돌고 있는가뿐이다."** 그 사실을 아는 건 워커뿐이라 │
     * │ 이제 워커가 실어 보낸다 (in_round).                                        │
     * │                                                                            │
     * │ ★ 인물(persona)은 그대로 월드 인물이다. 판이 열렸다고 다른 사람이 되면      │
     * │   말투가 통째로 갈리고 그게 곧 좌석 지문이다 (worldPersonaFor 의 상자).     │
     * │ ★ synthetic 은 여전히 synthetic 이다 — no_log·deadline_ms 는 players 행이   │
     * │   없다는 사실에 딸린 값이라 무대와 무관하다.                                │
     * └────────────────────────────────────────────────────────────────────────────┘
     */
    const inRound = body.in_round === true;
    const roundTopic =
      typeof body.round_topic === 'string' ? body.round_topic.slice(0, MAX_TEXT_LEN) : null;
    /*
     * 같은 speak 창이라도 **사람 말에 대꾸하는 발화**는 trigger 가 그 사람 말이라
     * 주제와 다르다. 주제 그 자체가 trigger 로 올 때만 "판이 던진 질문"이다 —
     * 그때는 되묻지 않는다 (되물어도 답할 상대가 없고, 창이 닫히면 그냥 허공이다.
     * generate.ts 의 askBack 상자가 게임 question 페이즈를 빼 두는 것과 같은 이유).
     */
    const answeringTopic = inRound && trigger !== null && trigger === roundTopic;

    /*
     * ★ 지금 몇 시인가 (lib/agent/clock.ts). **한 요청 안에서 한 번만 읽는다** —
     *   봇마다 따로 읽으면 자정을 넘기는 순간 같은 방의 두 봇이 다른 날짜를 말한다.
     */
    const now = describeNow(new Date().toISOString()) ?? undefined;

    // 워커가 보낸 사실도 그대로 믿지 않는다 — 한 번 걸러서 넣는다 (facts.ts).
    // DO 스토리지는 워커만 쓰지만, 여기 들어온 값은 다음 턴 시스템 프롬프트가 된다.
    const rawFacts = (body.facts ?? {}) as Record<string, unknown>;
    const factsOf = (playerId: string): string[] => {
      const v = rawFacts[playerId];
      return Array.isArray(v) ? mergeFacts([], v) : [];
    };

    /*
     * 월드 AI 의 **좌석 순 순번**. 자리도 id 도 사람이 드나들 때마다 밀리지만
     * 이 순번은 안 밀린다 (worldPersonaFor 의 두 번째 상자). 명단은 이미 좌석 순이다
     * (buildWorldRoster 의 seats.sort).
     */
    const worldOrdinal = new Map(
      roster.seats.filter((s) => s.synthetic).map((s, i) => [s.id, i] as const),
    );

    const plan = bots.map((b) => {
      // 월드 AI 는 **방 + 순번**으로 고른다 — 자리도 id 도 밀린다 (worldPersonaFor 의 상자).
      // synthetic 아닌 봇(2D로 시작된 방의 진짜 봇)은 게임 페르소나와 함께 지워졌다 —
      // 옛 방이 남아 있어도 월드 인물로 답하는 게 침묵보다 낫다.
      const persona = worldPersonaFor(`${roomId}:${worldOrdinal.get(b.id) ?? 0}`);
      return {
        player_id: b.id,
        persona,
        priorFacts: factsOf(b.id),
        context: {
          persona,
          facts: factsOf(b.id),
          // 판이 안 도는 월드 AI 만 라운지 무대다 — 시스템 프롬프트에서 게임 진행이
          // 빠진다 (generate.ts WORLD_RULES). 판이 돌기 시작하면 **월드 AI 도 게임
          // 무대**로 넘어간다 (위 상자). 게임이 시작된 방의 진짜 봇은 늘 게임 무대다.
          setting: b.synthetic && !inRound ? ('world' as const) : ('game' as const),
          now,
          // 주제에 답하는 차례는 게임의 question 페이즈와 같은 자리다 — 그래야
          // generate.ts 가 [지금 답할 질문] 틀로 물어본다. 나머지는 자유 채팅이다.
          phase: answeringTopic ? ('question' as const) : ('chat' as const),
          question: trigger ?? undefined,
          worldEvent: trigger ? undefined : (event ?? undefined),
          /*
           * ★ 되묻기 주사위는 **여기서** 굴린다 (generate.ts 의 askBack 상자).
           *   프롬프트에 "가끔 되물어라"를 적으면 8b 는 매번 되묻거나 아예 안 한다.
           *   말을 거는 차례(trigger 없음)가 더 자주 묻는다 — 원래 말은 질문으로 건다.
           *
           * ★ 입·퇴장 인사에는 **안 붙인다.** 인사에 되묻기까지 얹으면 8b 는 인사를
           *   버리고 질문만 낸다 (실측: 인사 자리에서 "그럼 너 오늘 뭐할까?").
           *   사람도 문 열고 들어온 사람에게 인사부터 하지 질문부터 하지 않는다.
           */
          askBack:
            answeringTopic || (!trigger && event)
              ? false
              : Math.random() < (trigger ? ASK_BACK_CHANCE : ASK_BACK_CHANCE_INITIATE),
          visibleHistory,
          styleProfile,
          suspicionOnMe: 0.2,
        } satisfies AgentContext,
      };
    });
    const jobs = plan.map(({ player_id, context }) => ({ player_id, context }));
    // 후처리(오타·웃음 길이)가 인물마다 다르다 — 응답을 받은 뒤에도 인물을 알아야 한다.
    const personaOf = new Map(plan.map((p) => [p.player_id, p.persona]));
    const priorFactsOf = new Map(plan.map((p) => [p.player_id, p.priorFacts]));

    const synthetic = bots.some((b) => b.synthetic);
    /*
     * 워커가 기다려 주는 시간. 구 워커는 안 보내므로 예전 상수(22초)로 떨어진다 —
     * 그때도 동작은 하고, 다만 단계 클램프와 어긋날 뿐이다.
     */
    const budgetMs =
      typeof body.budget_ms === 'number' && Number.isFinite(body.budget_ms)
        ? Math.max(0, Math.round(body.budget_ms))
        : 22_000 + AGENT_ROUNDTRIP_HEADROOM_MS;
    const res = await fetch(`${agentSelfUrl(req)}/api/agent`, {
      method: 'POST',
      headers: agentHeaders(),
      body: JSON.stringify({
        room_id: roomId,
        bots: jobs,
        // 월드 AI 는 players 행이 없어 agent_logs 외래키에 걸린다 (lib/server/world-ai.ts).
        no_log: synthetic,
        /*
         * ★ 월드 AI 는 LLM 컷을 8초에서 **22초**로 늘린다 (신고: "말을 안 할 때가 많다"
         *   → 그래도 안 해서 로그로 재 봤다). 그 방은 자리를 놓친 답도 말하고
         *   (room-do.ts 의 upgradeSpeech — "어색한 풀 문구 < 침묵 < 늦은 진짜 답"),
         *   워커는 26초를 기다려 준다 (COMPANION_AGENT_TIMEOUT_MS).
         *
         *   처음엔 10초로 늘렸는데 **여전히 모자랐다** — gemma-4-31b 실측이 7~11초라
         *   (4건: 7.4 · 7.5 · 10.9 · 30.0) 절반이 컷에 걸렸고, 월드에는 대신 낼 풀
         *   문구가 없어 그대로 침묵이었다. 값을 어림하지 말고 **재고 정한다.**
         *
         *   게임 방의 진짜 봇은 그대로 8초다 (§12.3) — 어차피 speakAt 을 넘긴 답은
         *   버려지므로 더 기다릴 이유가 없다.
         *
         * ┌─ ★ 22초 상수를 버리고 **워커가 실제로 기다리는 시간**에서 뺀다 ──────────┐
         * │ (2026-08-07, 실측으로 잡았다)                                            │
         * │                                                                          │
         * │ 여기 22_000 은 /api/agent 의 MAX_DEADLINE_MS 와 짝이 되라고 손으로 적어    │
         * │ 둔 값이었는데, **두 곳이 갈렸다** — MAX_DEADLINE_MS 를 28초로 올려도       │
         * │ 여기가 22초를 보내니 아무것도 안 바뀌었다. 로그에서 /api/agent 가 정확히   │
         * │ 22.2초에 붙어 있는 걸로 잡았다.                                          │
         * │                                                                          │
         * │ 게다가 상수로는 애초에 맞출 수가 없다. 워커의 대기는 상수가 아니라        │
         * │ **남은 단계 시간**으로 조여지기 때문이다(room-do 의 upgradeSpeech) —      │
         * │ speak 창에서는 20초대, 라운지에서는 32초다. 상수를 어느 쪽에 맞춰도        │
         * │ 나머지 한쪽이 틀린다.                                                    │
         * │                                                                          │
         * │ 그래서 워커가 제 예산(budget_ms)을 실어 보내고, 여기서 왕복 여유만 뺀다.   │
         * │ 상한은 /api/agent 가 MAX_DEADLINE_MS 로 다시 누르므로 여기서 또 적지       │
         * │ 않는다 — 값이 두 군데 살면 또 갈린다.                                    │
         * │                                                                          │
         * │ ★ 반드시 **워커보다 먼저** 끊겨야 한다. 워커가 먼저 끊으면 이 요청이       │
         * │   통째로 취소돼 world_agent_logs 의 after() insert 까지 같이 죽는다 —     │
         * │   왜 조용했는지 기록조차 안 남는다 (COMPANION_AGENT_TIMEOUT_MS 의 상자).  │
         * └──────────────────────────────────────────────────────────────────────────┘
         */
        ...(synthetic ? { deadline_ms: Math.max(1_000, budgetMs - AGENT_ROUNDTRIP_HEADROOM_MS) } : {}),
      }),
    });
    if (!res.ok) {
      console.error(`[world-agent] /api/agent ${res.status} — 이번 발화는 거른다 (room ${roomId})`);
      return empty();
    }

    const data = (await res.json()) as {
      model?: string | null;
      results?: {
        player_id: string;
        output: AgentOutput;
        fallback: boolean;
        took_ms?: number;
      }[];
    };

    const results: {
      player_id: string;
      text: string;
      tail: string | null;
      facts: string[];
    }[] = [];
    /*
     * 사후에 읽어보려고 남기는 기록 (world_agent_logs). **버려진 발화도 남긴다** —
     * 월드에서 봇이 조용한 이유의 대부분이 여기 있고(길이 초과·폴백), 그건
     * "무슨 말을 했나"만큼 봐야 하는 값이다. 아래 continue 자리마다 기록부터 한다.
     */
    const logRows: Record<string, unknown>[] = [];
    const logRow = (
      r: { player_id: string; output: AgentOutput; took_ms?: number },
      dropped: string | null,
      finalText: string | null,
      finalTail: string | null,
    ): void => {
      logRows.push({
        room_id: roomId,
        player_id: r.player_id,
        persona: personaOf.get(r.player_id)?.id ?? '',
        trigger_text: trigger,
        event_text: event,
        history: visibleHistory,
        raw: r.output.messages[0] ?? '',
        raw_tail: r.output.messages[1] ?? null,
        text: finalText,
        tail: finalTail,
        dropped,
        reasoning: r.output.reasoning,
        suspicion: r.output.suspicionOnMe,
        action: r.output.action,
        model: data.model ?? null,
        took_ms: r.took_ms ?? null,
      });
    };

    for (const r of data.results ?? []) {
      // LLM 실패분·구제 문구("ㅇㅇ")는 버린다. 월드에는 대신 쓸 풀이 없으니 그 자리는
      // 그냥 조용히 지나간다 — 맥락 없는 한 글자보다 침묵이 사람에 가깝다.
      if (r.fallback) {
        logRow(r, 'fallback', null, null);
        continue;
      }

      // 상한을 넘으면 자르지 않고 버린다(fitChatReply → null) — 잘린 말끝은
      // 폴백 문구보다 봇 티가 난다 (실측).
      const text = fitChatReply(r.output.messages[0] ?? '', MAX_REPLY_LEN);
      if (!text) {
        logRow(r, 'too_long', null, null);
        continue;
      }
      if (isFallbackLine(text, personaOf.get(r.player_id))) {
        logRow(r, 'fallback_line', null, null);
        continue;
      }

      /*
       * ★ 두 번째 발화는 **이어서 한 줄 더** 친다 (tail).
       *
       *   예전에는 첫 줄만 쓰고 버렸다. 월드 말풍선이 하나라 두 줄을 동시에 못 띄웠기
       *   때문인데, 지금은 워커가 앞 줄을 내보낸 **뒤에** 뒷줄을 이어 예약할 수 있다
       *   (worker/src/bots.ts의 pendingTail). 사람은 한 생각을 두 번에 나눠 친다 —
       *   그게 한 줄로 딱 끝나는 자리보다 사람 같다.
       *
       *   이어붙이지 않는 이유는 그대로다. 한 줄로 합치면 길이가 두 배가 되고
       *   그만큼 상한에 걸려 통째로 버려진다. 각자 따로 상한을 본다.
       */
      const second = r.output.messages[1] ?? '';
      const tail = second ? fitChatReply(second, MAX_REPLY_LEN) : null;

      /*
       * ★ 오타는 **여기서** 얹는다 — 상한 검사(fitChatReply)를 통과한 뒤다.
       *   순서를 뒤집어 오타를 먼저 얹으면, 띄어쓰기를 붙인 만큼 짧아진 글이
       *   상한에 걸릴지 말지가 오타 유무로 갈린다. 상한 판정은 LLM 이 낸 원문으로만
       *   해야 한다.
       *
       *   비율은 방 사람들의 오타 빈도(styleProfile.typoRate)를 따른다 — 봇만 유난히
       *   많이/적게 틀리면 그게 거꾸로 봇 지문이다 (I1, disguise.ts의 상자).
       */
      /*
       * ★ 웃음 길이는 **인물을 따라** 흔든다 (disguise.ts 의 stretchLaugh 상자).
       *   8b 는 "웃음은 ㅋㅋ만 쓴다"를 글자 수까지 지켜서 매번 정확히 두 글자로
       *   웃는다 — 늘 같은 길이로 웃는 자리는 세어 보면 드러난다 (I1).
       *   없던 웃음을 만들지는 않는다. 웃음을 안 쓰는 인물(laugh 없음)은 그대로다.
       *
       *   상한 검사 뒤라 길이가 최대 몇 글자 늘 수 있다. 그건 그대로 둔다 —
       *   "ㅋㅋㅋㅋㅋ"는 길어도 사람이 쓰는 모양이고, 상한이 막으려던 건 봇 티가
       *   나는 긴 **문장**이다.
       */
      /*
       * ★ 인물이 안 쓰기로 한 부호는 걷어낸다. 느낌표를 금지한 인물이 "안녕하세요!"
       *   로 인사한 게 실측됐다 — 부호 하나가 새면 그 인물이 다른 인물과 안 갈린다.
       *   오타·웃음보다 **먼저** 건다: 오타가 붙인 글자를 다시 지울 일이 없게.
       */
      const persona = personaOf.get(r.player_id);
      const human = (s: string) =>
        stretchLaugh(
          applyTypo(stripAvoidedPunct(s, persona?.avoidPunct), styleProfile, Math.random),
          persona?.laugh,
          Math.random,
        );
      /*
       * ★ 사실은 **여기까지 온 발화에만** 따라붙는다. 위에서 걸러진 것들 —
       *   폴백(r.fallback)·상한 초과·구제 문구 — 은 이 줄에 닿지 못한다.
       *   그게 맞다: 나가지 않은 말의 설정을 기억하면 봇이 한 적 없는 말을 했다고
       *   믿는다 (AgentOutput.facts 주석).
       *
       *   돌려주는 건 **합쳐진 전체 명단**이다. 워커는 병합을 모른 채 받은 걸
       *   그대로 보관하면 된다 (Body.facts 주석).
       */
      /*
       * ★ 코드가 못 박은 것(pinFact)이 모델이 낸 것보다 **앞**이다. 같은 주제면
       *   앞의 것이 이기므로(mergeFacts), 8b 가 대충 낸 값보다 실제로 나간 답이
       *   남는다. 8b 는 facts 칸을 7턴에 1번밖에 안 채운다 (facts.ts 실측).
       *
       *   못 박는 건 **앞 줄(text)뿐이다.** tail 은 이어 치는 덧말이라 질문에 대한
       *   답이 아니다 — 그걸 값으로 박으면 "사는 곳: 근데 여기 좋네"가 된다.
       */
      const pinned = pinFact(trigger, text);
      /*
       * ★ human()은 Math.random을 쓴다 — 한 번만 부르고 그 값을 기록과 응답에
       *   같이 쓴다. 두 번 부르면 로그의 문장과 실제로 나간 문장이 오타 하나만큼
       *   달라지고, 그러면 이 기록으로는 오타가 얼마나 났는지 셀 수 없다.
       */
      const finalText = human(text);
      const finalTail = tail && !isFallbackLine(tail, persona) ? human(tail) : null;
      logRow(r, null, finalText, finalTail);
      results.push({
        player_id: r.player_id,
        text: finalText,
        tail: finalTail,
        facts: mergeFacts(priorFactsOf.get(r.player_id) ?? [], [
          ...(pinned ? [pinned] : []),
          ...(r.output.facts ?? []),
        ]),
      });
    }

    /*
     * 기록은 **응답을 막지 않는다.** 실패해도 봇은 말한다 — agent_logs와 같은 규약
     * (app/api/agent/route.ts).
     *
     * ┌─ await 에서 after 로 바꿨다 (2026-08-06, "봇이 너무 느리다") ─────────────┐
     * │ 예산이 12초(COMPANION_AGENT_TIMEOUT_MS)라 insert 한 번은 부담이 아니라고    │
     * │ 봤는데, 그 판단이 틀렸다. 문제는 예산이 아니라 **사람이 기다리는 시간**이다 │
     * │ — 이 insert 는 LLM 이 답을 다 내놓은 **뒤에** 도는 Supabase 왕복이라,      │
     * │ 그동안 봇은 이미 할 말을 손에 쥐고 가만히 있는다.                          │
     * │                                                                          │
     * │ 그냥 떼어 놓으면(await 없이) Workers 에서는 응답과 함께 잘려 기록이 조용히 │
     * │ 빈다 — app/api/reveal 주석이 경고하는 그 고장이다. 그래서 Next 15 의       │
     * │ after() 를 쓴다: 응답을 먼저 보내고 그 뒤에 돌되, 런타임이 waitUntil 로     │
     * │ 붙들어 준다. 잘려나가는 문제도, 기다리는 문제도 여기서 같이 없어진다.       │
     * └──────────────────────────────────────────────────────────────────────────┘
     */
    if (logRows.length > 0) {
      after(async () => {
        const { error: logErr } = await getServiceClient().from('world_agent_logs').insert(logRows);
        if (logErr) console.error('[world-agent] 발화 기록 실패:', logErr.message);
      });
    }

    return Response.json({ ok: true, results }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return apiError(e);
  }
}
