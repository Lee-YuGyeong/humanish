/**
 * 봇 반응 한 줄을 Next에서 가져온다. 소유: A
 *
 * POST {NEXT_ORIGIN}/api/internal/world-agent
 *   Authorization: Bearer <WORLD_SHARED_SECRET>      ← room-meta.ts와 같은 규약
 *
 * ┌─ 왜 워커가 LLM을 직접 부르지 않는가 (I4) ──────────────────────────────────┐
 * │ LLM API 키는 서버에서만 읽고, 호출 경로는 app/api/agent 하나뿐이다.          │
 * │ 워커는 키를 모르고, 페르소나 프롬프트도 모른다 — 둘 다 Next 쪽에 산다.       │
 * │ 여기서 나가는 건 "이 방의 이 봇이, 이 대화 뒤에 한마디 한다"는 사실뿐이다.   │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 실패는 전부 삼킨다 ───────────────────────────────────────────────────────┐
 * │ 부르는 시점에 이미 **발화 자리가 잡혀 있다** (bots.ts의 scheduleSpeech).     │
 * │ 여기가 뭘 실패하든 봇은 제 시각까지 서 있다 간다 — 다만 할 말이 없으니 이번엔 │
 * │ 아무 말도 안 한다. 하드코딩 문구로 때우던 예전과 달라진 점이 이거 하나다.     │
 * │ 어느 쪽이든 **타이밍은 같다**, 그게 I1이 요구하는 전부다.                    │
 * │ 던지면 그 자리 계산이 흐트러지므로 던지지 않고 빈 배열을 돌려준다.            │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

import type { Env } from './bindings';

/** 대화 맥락 한 줄. human이 false면 봇 발화다 — 말투 관측에서 빠진다. */
export interface ChatLine {
  nickname: string;
  text: string;
  human: boolean;
}

export interface AgentLine {
  player_id: string;
  text: string;
  /**
   * 이 발화 **직후에 이어 칠 한 줄**. LLM이 두 줄을 냈을 때의 뒷줄이다.
   * 오리진이 상한 검사까지 마쳐서 넘겨 준다. 보통 null이다.
   */
  tail?: string | null;
  /**
   * 이 봇이 지금까지 지어낸 사실의 **전체 명단** (증분이 아니다).
   *
   * ★ 워커는 이 값을 **해석하지 않는다.** 받아서 보관했다가 다음 요청에 그대로
   *   실어 보낸다. 합치는 규칙(먼저 말한 것이 이긴다 · 상한 · 걸러내기)은 전부
   *   오리진의 lib/agent/facts.ts 한 곳에 있다 — 여기 한 벌 더 두면 그 순간 갈린다.
   */
  facts?: string[];
}

/**
 * 지금 이 방에서 **판이 도는가**, 돈다면 화면에 무슨 주제가 떠 있는가.
 *
 * ┌─ 왜 이걸 보내야 하는가 (신고: "주제가 나와도 가만히 있는다") ───────────────┐
 * │ 오리진은 월드 AI 를 `synthetic` 하나로만 판별해서 **늘 라운지 무대**를 깔았다  │
 * │ (lib/agent/generate.ts 의 WORLD_RULES: "지금은 판이 시작되기 전이고 … 아직    │
 * │ 아무도 질문을 받지 않았다"). 그런데 월드의 판은 rooms.phase 를 'lobby' 로     │
 * │ 둔 채 돈다 (app/api/room/start-world) — 즉 **주제가 떠 있는 45초 동안에도**   │
 * │ AI 는 "판은 아직 시작 전"이라고 들었다. 주제는 [지금 답할 질문]이 아니라      │
 * │ [방금 너한테 온 말]로 들어갔고, 제 규칙과 어긋나는 답은 오리진의 거르개       │
 * │ (fallback·isEvasive·상한)에 걸려 통째로 버려졌다 — 그래서 침묵이다.          │
 * │                                                                            │
 * │ 무대를 가르는 건 `synthetic` 이 아니라 **판이 도는가**다 (AgentContext.setting │
 * │ 의 주석이 처음부터 그렇게 적어 두었다). 그 사실을 아는 건 워커뿐이라 여기서   │
 * │ 실어 보낸다.                                                                │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
export interface RoundContext {
  /** 판이 돌고 있는가. 라운지면 false. */
  active: boolean;
  /**
   * speak 창에 떠 있는 주제. 그 밖의 단계면 null.
   *
   * trigger 와 **같은 문자열일 때만** "주제에 답하는 차례"다 — 같은 speak 창이라도
   * 사람 말에 대꾸하는 발화는 trigger 가 그 사람 말이라 여기와 다르다.
   */
  topic: string | null;
}

export async function fetchAgentLines(
  env: Env,
  roomId: string,
  playerIds: string[],
  history: ChatLine[],
  /** 반응을 부른 사람 발화. 스스로 말을 꺼내는 거면 null — 그때는 흐름에 끼어드는 게 맞다. */
  trigger: string | null,
  /**
   * 발화가 아니라 **사건**에 대한 반응일 때의 한 줄 ("익명3이 방금 들어왔다").
   * trigger와 같이 보내지 않는다 — 오리진은 사람 말을 먼저 본다.
   */
  event: string | null,
  /**
   * 봇마다 지금까지 쌓인 사실. `{ player_id: [...] }`. 오리진이 합쳐서 돌려준다.
   * 보관만 하는 값이라 워커는 내용을 들여다보지 않는다 (AgentLine.facts).
   */
  facts: Record<string, string[]>,
  /** 판 상황. 오리진이 무대(라운지/게임)와 질문 틀을 이걸로 고른다. */
  round: RoundContext,
  timeoutMs: number,
): Promise<AgentLine[]> {
  const url = `${env.NEXT_ORIGIN.replace(/\/$/, '')}/api/internal/world-agent`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.WORLD_SHARED_SECRET}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        room_id: roomId,
        player_ids: playerIds,
        history,
        trigger,
        event,
        facts,
        in_round: round.active,
        round_topic: round.topic,
      }),
      // speakAt을 넘겨 오는 답은 쓸 데가 없다. 호출부가 남은 시간을 그대로 넘긴다.
      // ★ 반드시 정수로 자른다. speakAt 은 읽는 시간(rand)이 섞여 **소수**라, 그대로
      //   넘기면 `AbortSignal.timeout` 이 "delay must be an integer" 로 **던진다** —
      //   그러면 아래 catch 가 삼켜서 그 봇은 조용히 LLM 없이 지나간다. 실측으로 잡았다.
      signal: AbortSignal.timeout(Math.max(0, Math.round(timeoutMs))),
    });
    if (!res.ok) {
      console.warn(`[world-agent] ${res.status} ${roomId} — 이번 발화는 거른다`);
      return [];
    }

    const body = (await res.json()) as { results?: AgentLine[] };
    if (!Array.isArray(body.results)) return [];
    return body.results
      .filter((r): r is AgentLine => typeof r?.player_id === 'string' && typeof r?.text === 'string')
      // tail·facts 는 나중에 붙은 필드다. 모양이 아니면 없는 것으로 본다 — 구 오리진과
      // 새 워커가 섞여 돌아도 발화 자체는 그대로 나간다.
      .map((r) => ({
        ...r,
        tail: typeof r.tail === 'string' ? r.tail : null,
        // 빈 배열과 "안 왔다"를 구분한다 — 구 오리진이면 기존 명단을 지우면 안 된다.
        facts: Array.isArray(r.facts) ? r.facts.filter((f) => typeof f === 'string') : undefined,
      }));
  } catch (e) {
    // 시간 초과가 대부분이다. 정상 경로이므로 조용히 물러난다.
    console.warn(`[world-agent] 실패 ${roomId}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
