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
}

export async function fetchAgentLines(
  env: Env,
  roomId: string,
  playerIds: string[],
  history: ChatLine[],
  /** 반응을 부른 사람 발화. 스스로 말을 꺼내는 거면 null — 그때는 흐름에 끼어드는 게 맞다. */
  trigger: string | null,
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
      body: JSON.stringify({ room_id: roomId, player_ids: playerIds, history, trigger }),
      // speakAt을 넘겨 오는 답은 쓸 데가 없다. 호출부가 남은 시간을 그대로 넘긴다.
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.warn(`[world-agent] ${res.status} ${roomId} — 이번 발화는 거른다`);
      return [];
    }

    const body = (await res.json()) as { results?: AgentLine[] };
    if (!Array.isArray(body.results)) return [];
    return body.results.filter(
      (r): r is AgentLine => typeof r?.player_id === 'string' && typeof r?.text === 'string',
    );
  } catch (e) {
    // 시간 초과가 대부분이다. 정상 경로이므로 조용히 물러난다.
    console.warn(`[world-agent] 실패 ${roomId}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
