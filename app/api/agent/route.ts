/**
 * LLM 프록시 — NVIDIA NIM 어댑터. 껍데기: A · 내용: B (SPEC §2). 공급자는 §15-1-결정.
 *
 * 공급자에 의존하는 것(엔드포인트 · 인증 헤더 · 모델 ID · 응답 모양)은 이 파일 밖으로
 * 내보내지 않는다 (SPEC §9.2). 공급자를 바꾸면 이 파일만 갈아끼운다.
 * 프롬프트 조립과 응답 정제는 lib/agent/generate.ts(공급자 무관 층)가 한다.
 *
 * GET  /api/agent                              → { provider, configured, model }
 *   키가 설정됐는지만 본다. NIM을 부르지 않는다.
 * POST /api/agent
 *   { probe: true, prompt? }                   → { ok, model, took_ms, reply }
 *     NIM 왕복 확인용. 키를 넣은 뒤 이걸로 연결을 검증한다.
 *   { lab: true, question?, phase?, history? } → { ok, results: [...] }
 *     /lab 전용 — 페르소나 전원에게 같은 상황을 주고 나란히 비교한다.
 *     컨텍스트 조립을 서버에서 하는 이유: 페르소나 프롬프트가 클라이언트로 새면 안 된다.
 *   { room_id, bots: [{ player_id, context }] } → { ok, results: [...] }
 *     봇 응답 일괄 생성. room_id가 있으면 agent_logs에 남긴다.
 *
 * SPEC §12.3의 네 가지를 여기서 지킨다.
 *   병렬 — Promise.allSettled · 8초 컷 — AbortController · 재시도 0 — fetch 기본엔
 *   재시도가 없다(SDK를 들이게 되면 그 순간 재시도 설정부터 확인할 것) · 폴백 — FALLBACK_POOL
 *
 * ★ 프로덕션은 내부 Bearer(AGENT_SHARED_SECRET)로만 열린다 — world-room과 같은 규약.
 *   비밀이 없거나 틀리면 404. "있는데 못 들어간다"는 것조차 알리지 않는다.
 *   선생성 층(lib/agent/prefill.ts · chat-reply.ts)이 같은 비밀을 헤더에 실어 부른다.
 *   probe · lab · 모델 오버라이드는 개발 도구라 프로덕션에서는 실전 모드만 연다.
 */

import { after } from 'next/server';
import { timingSafeEqual } from '@/lib/mp/ticket';
import {
  generate,
  fallbackOutput,
  AGENT_TIMEOUT_MS,
  type AgentContext,
} from '@/lib/agent/generate';
import { describeNow } from '@/lib/agent/clock';
import { hedgeOnStall } from '@/lib/agent/hedge';
import type { Persona } from '@/lib/agent/persona';
import { WORLD_PERSONAS } from '@/lib/agent/world-persona';
import { observeStyle } from '@/lib/agent/disguise';
import type { LlmChatMessage, Phase } from '@/lib/game/types';
import { ApiError, apiError, readJson } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/supabase';

/*
 * ★ `runtime = 'edge'` 를 쓰지 않는다.
 *
 *   OpenNext(Cloudflare)로 배포하면 edge 런타임 라우트가 워커에 제대로 붙지 않아
 *   **이 경로만 500** 이 된다. 이 저장소에서 edge 를 선언한 라우트가 여기 하나뿐이었고,
 *   실제로 운영에서 /api/agent 만 500 이었다 (다른 라우트는 전부 200).
 *   증상이 고약한 이유: LLM 이 죽어도 봇은 풀 문구로 말하므로 **화면은 멀쩡해 보인다.**
 *   운영에서 봇이 계속 풀 문구만 말한다면 제일 먼저 여기를 의심할 것.
 *
 *   이 라우트는 fetch 와 service role 클라이언트만 쓰므로 기본(워커) 런타임으로 충분하다.
 */
export const dynamic = 'force-dynamic';

// ── NVIDIA NIM 어댑터 — 공급자 의존부는 전부 이 블록 안 ─────────────────────

interface NimConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** 키가 없으면 null. 폴백 경로는 키 없이도 돌아야 한다 (§12.3). */
function nimConfig(): NimConfig | null {
  const apiKey = process.env.NVIDIA_NIM_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (process.env.NVIDIA_NIM_BASE_URL ?? 'https://integrate.api.nvidia.com/v1').replace(/\/$/, ''),
    /*
     * 기본값은 **코드에 둔다** — .env.local 은 로컬만 읽는다. 여기에 안 박으면
     * 배포본이 조용히 다른 모델로 돈다. NVIDIA_NIM_MODEL 은 /lab 실험용 덮어쓰기다.
     *
     * 2026-08-03 실측(무료 티어, 카탈로그 102개 전수). 인물 4명 × 질문 3개 = 12발화 기준.
     *
     * ★ 고르는 기준은 **한국어 문장이 아니라 JSON 스키마 준수율**이다. 이걸로 두 번 속았다:
     *   겉보기 답이 멀쩡해도 parseOutput 이 잔해에서 한 줄 건져낸 것일 수 있고, 그때는
     *   fallback 플래그가 안 켜져서 성공으로 집계된다. 반드시 reasoning 을 읽어야 갈린다.
     *
     *              모델                        정상   JSON깨짐  폴백  8초초과
     *   google/gemma-4-31b-it                  92%      0       1      4
     *   meta/llama-3.1-8b-instruct             92%      1       0      0
     *   nvidia/nemotron-3-ultra-550b-a55b      50%      2       4      6
     *   minimaxai/minimax-m3                   50%      0       6     12
     *   deepseek-ai/deepseek-v4-pro            17%      0      10      4
     *
     * 8b(직전 기본값)는 지연만 보면 무결점인데 번역체다 — "우산 벗겨서 산책해!" 처럼
     * 뜻이 안 통하고 질문을 그대로 되풀이한다. gemma 는 8초를 1/3쯤 넘겨 그만큼 폴백이
     * 되지만, **폴백은 "아 잠만!" 한마디라 사람으로 읽히고 번역체는 항상 티가 난다.**
     * 가끔 티나는 쪽을 골랐다.
     *
     * 추론 모델은 전부 탈락이다. nemotron-3-ultra 는 발화 자리에 영어 사고 과정을 실었다
     * ("The user is asking what I usually do on weekends. As a 25"). 한 줄로 판이 끝난다.
     * 같은 계열이라도 nano·super 는 한국어에 중국어가 섞였다 — 계열로 묶으면 놓친다.
     *
     * gemma 의 약점은 내용 붕괴다(같은 질문 10회에 전부 "마라탕 어때?"). 실시간 생성만으로
     * 봇을 굴리면 봇들이 같은 답을 한다 — SPEC §17 의 문구 풀 우선이 이걸 막는다.
     * 미리 만드는 문구 풀은 다양성이 유일하게 살아 있는 minimaxai/minimax-m3 로 뽑는다.
     *
     * ── 2026-08-04: 기본값을 nemotron-3-super 로 바꿨다 (지시) ────────────────
     * ★ 위 실측과 어긋나는 선택이다. 표에 super 행이 없는 건 안 재서가 아니라
     *   윗줄(추론 모델 탈락)에서 계열째 떨어뜨렸기 때문이고, 그때 super 가 떨어진
     *   사유는 지연도 JSON 도 아닌 **한국어에 중국어가 섞인 것**이다. 그 증상은
     *   parseOutput 을 통과해서 폴백 플래그가 안 켜진다 — 즉 집계로는 정상으로
     *   잡히고 화면에서만 티가 난다. 봇 티는 여기서 난다.
     *   되돌릴 거면 'google/gemma-4-31b-it' 로 돌아가면 된다.
     *
     * ── 2026-08-05: gemma 로 되돌렸다 (신고: 말이 느리고, 안 할 때도 많다) ─────
     * ★ 추론 모델의 실패 모양 그대로였다. nemotron 계열은 발화 전에 생각을 먼저
     *   쓰는데, 그 생각이 max_tokens(300)와 8초 컷을 잡아먹는다 — JSON 이 안 나와
     *   폴백이 되고, 월드는 폴백을 버리므로(world-agent) 그게 곧 **침묵**이다.
     *   컷 직전에 겨우 온 답은 지각 발화로 나가 **느림**이 된다. 철자 깨짐
     *   ("깼어"→"깟어")도 이 모델의 한국어 증상이다 — 일부러 얹는 오타(applyTypo)는
     *   모음을 못 바꾼다.
     */
    model: process.env.NVIDIA_NIM_MODEL || 'google/gemma-4-31b-it',
  };
}

/**
 * OpenAI 호환 chat/completions 한 번. 재시도 없음 — 실패는 폴백이 받는다.
 *
 * ┌─ ★ 스트리밍으로 받는다 (2026-08-07) ──────────────────────────────────────┐
 * │ 신고: "3D 월드에서 AI 가 한마디도 안 한다." world_agent_logs 를 읽어 보니   │
 * │ **버려진 발화의 took_ms 가 전부 컷 값에 정확히 붙어 있었다** (10000 · 22000).│
 * │ 컷을 10초 → 22초로 늘려도 그대로였다 — 늘릴 값이 아니라 **기다리는 방식**이  │
 * │ 문제였다.                                                                  │
 * │                                                                          │
 * │ 모델이 내놓는 JSON 의 순서를 보면 답이 보인다 (OUTPUT_FORMAT):              │
 * │   {"messages":[…] , "reasoning":… , "suspicionOnMe":… , "action":… , …}   │
 * │ **정작 필요한 발화는 맨 앞 필드**인데, 한 번에 받으면 뒤 필드까지 다 나올     │
 * │ 때까지 아무것도 못 쓴다. 22초에 끊기면 이미 나와 있던 발화까지 같이 버려지고, │
 * │ 월드에는 대신 낼 풀 문구가 없으니 그게 그대로 **침묵**이다.                  │
 * │                                                                          │
 * │ 그래서 흘려 받고, 끊기면 **거기까지 온 것을 돌려준다.** 잘린 JSON 에서 발화를 │
 * │ 건지는 길은 이미 있다 — parseOutput 의 salvage("JSON 파싱 실패 — 발화만      │
 * │ 건짐"). 없던 장치를 만드는 게 아니라, 지금까지 그 장치에 **닿지도 못하고**    │
 * │ 버려지던 것을 닿게 하는 것이다.                                            │
 * │                                                                          │
 * │ ★ 중간에 스스로 끊지는 않는다. 발화만 건지고 바로 끊으면 reasoning·facts 가  │
 * │   영영 안 와서, 봇이 지어낸 설정이 다음 턴에 사라진다 (facts.ts). 끝까지      │
 * │   기다리되 **끊길 때 손해가 없게** 만드는 게 이 변경의 전부다.               │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
async function callNim(
  cfg: NimConfig,
  messages: LlmChatMessage[],
  signal?: AbortSignal,
  /**
   * 첫 토큰이 도착한 순간 한 번 불린다. 헤지(callNimHedged)가 "이 연결이 살아
   * 있는가"를 판단하는 유일한 신호다 — 응답 헤더는 큐에 걸린 요청도 바로 준다.
   */
  onFirstToken?: () => void,
): Promise<string> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: 0.75, // 0.9는 8b에서 말이 샜다(실측 — 엉뚱한 답). 다양성은 페르소나가 만든다
      /*
       * ★ 300 → 140 (2026-08-07). 생성 시간은 **낸 토큰 수에 비례한다** — 같은
       *   질문 12회를 300 과 110 으로 재 보니 중앙값이 12.7초 → 8.6초였다.
       *   300 은 "길면 봇 티가 난다"를 막으려고 잡은 상한인데, 실제로 그 예산을
       *   쓰는 건 발화가 아니라 뒤 필드(reasoning·facts)다. 발화가 맨 앞이라
       *   잘려도 salvage 가 받는다 — 잘리면 잃는 건 설정 기억뿐이고, 그건
       *   침묵보다 훨씬 싸다.
       */
      max_tokens: 140,
      stream: true,
    }),
    signal: signal ?? null,
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`NIM ${res.status}: ${detail}`);
  }
  if (!res.body) throw new Error('NIM 응답이 비었다');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let acc = '';

  /** SSE 한 줄씩 — `data: {…}` 의 delta.content 만 모은다. `[DONE]` 이면 끝. */
  const drain = (chunk: string): boolean => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return true;
      try {
        const piece = (JSON.parse(payload) as { choices?: { delta?: { content?: unknown } }[] })
          .choices?.[0]?.delta?.content;
        if (typeof piece === 'string' && piece.length > 0) {
          if (!acc) onFirstToken?.();
          acc += piece;
        }
      } catch {
        // 조각난 줄은 버린다 — 다음 청크에서 온전한 줄로 다시 온다.
      }
    }
    return false;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (drain(decoder.decode(value, { stream: true }))) break;
    }
  } catch (e) {
    // 컷(AbortSignal)이 대부분이다. **여기까지 온 것이 있으면 그게 답이다** —
    // 위 상자의 요점이고, 아무것도 못 받았을 때만 폴백으로 넘긴다.
    if (!acc.trim()) throw e;
  } finally {
    void reader.cancel().catch(() => {});
  }

  if (!acc.trim()) throw new Error('NIM 응답이 비었다');
  return acc.trim();
}

/**
 * 첫 토큰이 이만큼 안 오면 **한 번 더 건다** (같은 컷 안에서 나란히).
 *
 * 성공한 호출의 첫 토큰은 1~2초 안에 온다 (실측). 6초는 "느린 것"이 아니라
 * "안 오고 있는 것"의 문턱이다 — 그 이상 기다려도 대개 끝까지 안 온다.
 * 왜 이게 필요한지는 lib/agent/hedge.ts 머리말에 있다.
 */
const HEDGE_AFTER_MS = 6_000;

/**
 * 헤지를 켤 최소 컷. 게임(2D)의 8초 규칙(§12.3)에서는 두 번째 요청이 답을 낼
 * 시간이 애초에 없다 — 남의 지갑만 쓰고 결과는 같다. 월드 AI 의 긴 컷
 * (deadline_ms, 최대 MAX_DEADLINE_MS)에서만 켠다.
 */
const HEDGE_MIN_DEADLINE_MS = 15_000;

/** 무응답 헤지를 얹은 callNim. 언제 한 번 더 거는지는 hedgeOnStall 이 정한다. */
function callNimHedged(
  cfg: NimConfig,
  messages: LlmChatMessage[],
  signal: AbortSignal,
): Promise<string> {
  return hedgeOnStall(
    (attemptSignal, onFirstToken) => callNim(cfg, messages, attemptSignal, onFirstToken),
    signal,
    HEDGE_AFTER_MS,
  );
}

// ── 공급자 무관 층 — 타임아웃 ───────────────────────────────────────────────

/** 8초 컷 (§12.3). AbortController로 fetch까지 실제로 끊는다. */
function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`시간 초과 (${ms}ms)`)), ms);
  return run(ac.signal).finally(() => clearTimeout(timer));
}

/**
 * /lab 전용 여유 컷. 게임은 8초가 규칙(§12.3)이지만 lab은 품질 비교가 목적이라
 * 느린 모델도 일단 답을 보게 한다. 응답 시간(took_ms)을 같이 보여주므로
 * "이 모델이 8초 안에 들어오는가"도 lab에서 판단할 수 있다.
 */
/*
 * ★ 30초 → 60초 (2026-08-07). lab 은 **인물 전원(4명)을 동시에** 쏘는데, 무료 티어에서
 *   병렬은 그대로 큐에 줄을 서서 순차 p50 17초짜리가 4병렬에서 30초(=이 컷)가 된다 —
 *   실측으로 48건 중 32건이 여기서 잘렸다. 그러면 비교하려던 품질이 아니라 컷만 보게
 *   된다. 60초로 올리니 72건 중 1건으로 떨어졌다.
 *   프로덕션과 무관한 값이다 — probe·lab 은 운영에서 404다 (POST 머리말).
 */
const LAB_TIMEOUT_MS = 60_000;

/**
 * deadline_ms 로 늘릴 수 있는 상한. 워커의 월드 AI 대기(COMPANION_AGENT_TIMEOUT_MS)에서
 * self-fetch 왕복 + 명단 조회 + 기록 insert 여유를 뺀 값이다 — 워커 값까지 열면
 * 워커가 답을 받기 전에 제 시계로 끊어서, 만들어 놓고 버린다.
 *
 * ★ 10초 → 22초 (2026-08-07). 10초는 **모델이 실제로 쓰는 시간을 재기 전에** 잡은
 *   값이었다. gemma-4-31b 실측이 7~11초라(4건: 7.4 · 7.5 · 10.9 · 30.0) 절반이 컷에
 *   걸려 폴백이 됐고, 월드에는 대신 낼 풀 문구가 없어 그대로 침묵이 됐다
 *   (신고: "익명5가 주제에 한마디도 안 한다"). 워커는 26초까지 기다린다.
 *
 * ★ 22초 → 28초 (2026-08-07). 위 실측(7~11초)이 낡았다 — 같은 모델·같은 계정에서
 *   **중앙값 17초 · p90 21초**로 늘었다(순차 10회). 게다가 지연이 전부 TTFT 라
 *   (47자 프롬프트로 18자를 뽑는 데 19.7초, 그중 19.69초가 첫 바이트 이전)
 *   max_tokens 나 프롬프트 길이로는 못 줄인다. 22초는 p90 을 겨우 담고 그 위를
 *   전부 버린다. 워커는 32초까지 기다린다 (COMPANION_AGENT_TIMEOUT_MS — 여유 4초).
 *
 *   ★ 이 값이 실제로 듣는 곳은 **라운지와 freechat 뿐이다.** speak(45초)에서는
 *     워커가 남은 단계 시간으로 먼저 조이므로(room-do 의 upgradeSpeech) 여기를
 *     올려도 한 자리도 안 바뀐다 — 실제로 10→22 로 올렸을 때 그랬다.
 *
 * ★ 게임(2D)의 8초 규칙(§12.3)은 그대로다 — 이 상한은 deadline_ms 를 실어 보내는
 *   월드 AI 에만 걸린다. 저쪽은 speakAt 을 넘긴 답을 어차피 버리므로 더 기다릴
 *   이유가 없다.
 */
const MAX_DEADLINE_MS = 28_000;

// ── 라우트 ──────────────────────────────────────────────────────────────────

export async function GET(req: Request): Promise<Response> {
  const cfg = nimConfig();

  // ?models=1 — NIM 카탈로그에서 쓸 수 있는 모델 ID 목록 (개발 전용, /lab 비교용).
  if (new URL(req.url).searchParams.has('models')) {
    if (process.env.NODE_ENV === 'production') return new Response(null, { status: 404 });
    if (!cfg) return Response.json({ error: 'NVIDIA_NIM_API_KEY 미설정' }, { status: 500 });
    const res = await fetch(`${cfg.baseUrl}/models`, {
      headers: { authorization: `Bearer ${cfg.apiKey}` },
    });
    if (!res.ok) return Response.json({ error: `NIM ${res.status}` }, { status: 502 });
    const data = (await res.json()) as { data?: { id?: string }[] };
    return Response.json({ models: (data.data ?? []).map((m) => m.id).filter(Boolean) });
  }

  return Response.json({
    provider: 'nvidia-nim',
    configured: cfg !== null,
    model: cfg?.model ?? null,
  });
}

interface BotJob {
  player_id: string;
  context: AgentContext;
  /** lab 모드에서만 채워서 응답에 실어준다. */
  persona?: Pick<Persona, 'id' | 'traits'>;
}

interface Body {
  probe?: boolean;
  prompt?: string;
  lab?: boolean;
  question?: string;
  phase?: Phase;
  history?: { speaker?: string; text?: string }[];
  /** 개발 전용 라우트라 허용 — /lab에서 모델을 나란히 비교하기 위한 오버라이드 (§15-1-결정). */
  model?: string;
  room_id?: string;
  bots?: { player_id?: string; context?: AgentContext }[];
  /**
   * agent_logs 기록을 건너뛴다. 3D 월드의 AI 는 players 행이 없어서
   * (lib/server/world-ai.ts) player_id 외래키에 매번 걸린다 — 기록은 못 남기고
   * 콘솔만 에러로 덮인다. 발화 자체는 그대로 만든다.
   */
  no_log?: boolean;
  /**
   * 이번 요청의 LLM 컷 (ms). 안 주면 8초 (AGENT_TIMEOUT_MS, §12.3).
   *
   * 월드 AI 용이다 (app/api/internal/world-agent) — 그 방은 자리를 놓친 답도
   * 말하고("침묵 < 늦은 진짜 답"), 워커가 12초를 기다려 주는데 여기가 8초에
   * 끊으면 남는 시간이 통째로 버려진다. MAX_DEADLINE_MS 위로는 눌린다.
   */
  deadline_ms?: number;
}

/** 정원 상한(8)보다 많은 봇을 한 번에 만들 일이 없다 (SPEC §4). */
const MAX_BOTS = 8;
const MAX_PROBE_PROMPT_LEN = 500;
const MAX_LAB_TEXT_LEN = 300;
const MAX_LAB_HISTORY = 30;

/**
 * /lab: 인물 전원에게 같은 상황을 준다. 조립은 서버에서 — 프롬프트가 새면 안 된다.
 * 게임 페르소나가 지워진 뒤로(2026-08-08) 비교 대상은 월드 인물 7인이다.
 */
function labJobs(body: Body): BotJob[] {
  const history = (body.history ?? [])
    .filter((h): h is { speaker?: string; text: string } => typeof h?.text === 'string' && h.text.trim() !== '')
    .slice(-MAX_LAB_HISTORY)
    .map((h) => ({
      speaker: (h.speaker || '익명?').slice(0, 20),
      text: h.text.slice(0, MAX_LAB_TEXT_LEN),
    }));

  const styleProfile = observeStyle(history.map((h) => h.text));
  const phase: Phase = body.phase ?? 'question';
  const question = body.question?.slice(0, MAX_LAB_TEXT_LEN) || undefined;
  // 인물 전원이 **같은 시각**을 본다 — /lab 은 나란히 비교하는 화면이라 특히 그렇다
  const now = describeNow(new Date().toISOString()) ?? undefined;

  return WORLD_PERSONAS.map((persona) => ({
    player_id: `lab-${persona.id}`,
    persona: { id: persona.id, traits: persona.traits },
    context: {
      persona,
      phase,
      question,
      visibleHistory: history,
      styleProfile,
      suspicionOnMe: 0.2,
      now,
    },
  }));
}

export async function POST(req: Request): Promise<Response> {
  try {
    // 프로덕션은 내부 Bearer로만 연다 (world-room과 같은 규약). 열어두면 남의 지갑으로
    // 쓰는 LLM 프록시가 된다. 비밀 미설정 = 예전 그대로 통째로 404 (fail-closed).
    const isProd = process.env.NODE_ENV === 'production';
    if (isProd) {
      const secret = process.env.AGENT_SHARED_SECRET;
      if (!secret) return new Response(null, { status: 404 });
      const auth = req.headers.get('authorization') ?? '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!timingSafeEqual(bearer, secret)) return new Response(null, { status: 404 });
    }

    const body = await readJson<Body>(req);

    // probe · lab · 모델 오버라이드는 개발 도구다 — 프로덕션은 실전 모드(room_id·bots)만.
    if (isProd && (body.probe || body.lab || body.model)) {
      return new Response(null, { status: 404 });
    }

    const baseCfg = nimConfig();
    // 모델 오버라이드는 개발 환경(위 가드)에서만 허용된다 — /lab 비교용 (§15-1-결정).
    const cfg =
      baseCfg && body.model ? { ...baseCfg, model: body.model.slice(0, 100) } : baseCfg;

    // ── probe: NIM 왕복 확인 ────────────────────────────────────────────────
    if (body.probe) {
      if (!cfg) throw new ApiError(500, 'NVIDIA_NIM_API_KEY 미설정 (.env.local.example 참고)');

      const prompt = (body.prompt ?? '지금 뭐 먹고 싶은지 한 줄로만 말해줘.').slice(0, MAX_PROBE_PROMPT_LEN);
      const t0 = Date.now();
      const reply = await withDeadline(
        (signal) =>
          callNim(
            cfg,
            [
              { role: 'system', content: '너는 한국 대학생이다. 반말로 짧게 한두 문장만 답한다.' },
              { role: 'user', content: prompt },
            ],
            signal,
          ),
        LAB_TIMEOUT_MS,
      );
      return Response.json({ ok: true, model: cfg.model, took_ms: Date.now() - t0, reply });
    }

    // ── 봇 응답 생성 (lab 또는 실전) ────────────────────────────────────────
    let jobs: BotJob[];
    let roomId: string | null;

    if (body.lab) {
      jobs = labJobs(body);
      roomId = null; // lab은 방이 없다 — agent_logs를 남기지 않는다
    } else {
      if (!body.room_id) throw new ApiError(400, 'room_id가 없다');
      const bots = body.bots;
      if (!Array.isArray(bots) || bots.length === 0) throw new ApiError(400, 'bots가 비었다');
      if (bots.length > MAX_BOTS) throw new ApiError(400, `봇은 한 번에 ${MAX_BOTS}명까지다`);
      if (bots.some((b) => !b.player_id || !b.context)) {
        throw new ApiError(400, 'player_id나 context 없는 봇이 있다');
      }
      jobs = bots.map((b) => ({ player_id: b.player_id!, context: b.context! }));
      roomId = body.no_log ? null : body.room_id;
    }

    // 봇 수만큼 병렬 (§12.3). 순차 호출은 봇 수 배만큼 느리다.
    // LlmCall을 봇마다 deadline의 signal에 묶어 generate에 넘긴다 (SPEC §9.2).
    // 게임은 8초가 규칙이고(§12.3), deadline_ms 는 월드 AI 의 지각 발화 예산이다
    // (Body.deadline_ms). 내부 Bearer 뒤라 아무나 못 늘린다.
    const deadlineMs = body.lab
      ? LAB_TIMEOUT_MS
      : typeof body.deadline_ms === 'number'
        ? Math.min(MAX_DEADLINE_MS, Math.max(1_000, Math.round(body.deadline_ms)))
        : AGENT_TIMEOUT_MS;
    /*
     * 컷이 넉넉한 경로(월드 AI)에서는 무응답 헤지를 켠다 — 첫 토큰이 안 오는 연결에
     * 컷을 통째로 태우지 않는다 (callNimHedged 의 상자). 게임의 8초는 그대로다.
     *
     * ★ lab 은 뺀다. 컷은 넉넉하지만(60초) 인물 전원을 **동시에** 쏘는 화면이라,
     *   거기서 안 오는 첫 토큰은 공급자 무응답이 아니라 **내 요청들끼리의 큐**다
     *   (LAB_TIMEOUT_MS 의 상자 — 순차 p50 17초가 4병렬에서 30초). 큐를 헤지로
     *   밀면 줄만 두 배로 길어진다.
     */
    const hedge = !body.lab && deadlineMs >= HEDGE_MIN_DEADLINE_MS;
    const t0 = Date.now();
    const settled = await Promise.allSettled(
      jobs.map((job) =>
        withDeadline(
          (signal) =>
            generate(
              job.context,
              cfg
                ? (msgs) =>
                    hedge ? callNimHedged(cfg, msgs, signal) : callNim(cfg, msgs, signal)
                : null,
            ),
          deadlineMs,
        ).then((output) => ({ output, tookMs: Date.now() - t0 })),
      ),
    );

    const results = settled.map((s, i) => {
      const job = jobs[i];
      const base = { player_id: job.player_id, ...(job.persona ? { persona: job.persona } : {}) };
      if (s.status === 'fulfilled') {
        return {
          ...base,
          output: s.value.output,
          took_ms: s.value.tookMs,
          fallback: s.value.output.reasoning.startsWith('fallback:'),
        };
      }
      const reason = s.reason instanceof Error ? s.reason.message : String(s.reason);
      return {
        ...base,
        output: fallbackOutput(job.context, reason),
        took_ms: Date.now() - t0,
        fallback: true,
      };
    });

    // agent_logs 기록 (§9.2 표). ref_id는 발화가 insert된 뒤에야 생기므로 선생성
    // 층이 채운다 — 여기서는 null로 남긴다. 기록 실패가 응답을 막아서는 안 된다.
    //
    // ★ 응답 **뒤로** 미룬다 (2026-08-06). LLM 이 답을 다 낸 뒤에 도는 Supabase
    //   왕복이라, await 하면 그만큼 봇이 할 말을 쥐고 가만히 있는다. after() 는
    //   응답을 먼저 보내고 런타임이 waitUntil 로 붙들어 준다 — 그냥 떼어 놓으면
    //   Workers 에서 잘려 기록이 조용히 빈다 (app/api/reveal 주석의 그 고장).
    if (roomId) {
      const rows = results.map((r) => ({
        room_id: roomId,
        player_id: r.player_id,
        ref_id: null,
        reasoning: r.output.reasoning,
        suspicion: r.output.suspicionOnMe,
        action: r.output.action,
      }));
      after(async () => {
        const { error: logErr } = await getServiceClient().from('agent_logs').insert(rows);
        if (logErr) console.error('[agent] agent_logs 기록 실패:', logErr.message);
      });
    }

    return Response.json({ ok: true, model: cfg?.model ?? null, results });
  } catch (e) {
    return apiError(e);
  }
}
