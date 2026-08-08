/**
 * 무응답 헤지 — 첫 토큰이 안 오는 연결에 컷을 통째로 태우지 않는다. 소유: B
 *
 * 공급자 무관 층이다. 여기는 "무엇을 부르는가"를 모르고 **언제 한 번 더 거는가**만 안다
 * (엔드포인트·모델·응답 모양은 app/api/agent/route.ts 안에 남는다, SPEC §9.2).
 *
 * ┌─ 왜 필요한가 (신고 2026-08-09: "3D 월드에서 AI 가 대답을 안 한다") ────────┐
 * │ world_agent_logs 를 읽어 보니 버려진 발화 63건 중 51건이었고, 그 중            │
 * │ **32건의 took_ms 가 정확히 컷 값(28000)** 이었다. 바로 다음 호출은 3.8초에     │
 * │ 답이 왔다 — 같은 방, 같은 모델, 5초 뒤다.                                     │
 * │                                                                            │
 * │ 즉 "모델이 느리다"가 아니라 **그 연결에 28초 동안 한 바이트도 안 왔다.**       │
 * │ 무료 티어가 요청을 큐에 세우면 헤더는 200 으로 바로 주고 본문이 안 흐른다.     │
 * │ 그래서 스트리밍도 salvage(parseOutput)도 건질 게 없고, 폴백 문구가 나가는데    │
 * │ 월드는 폴백을 버리므로(app/api/internal/world-agent) 그게 그대로 **침묵**이다. │
 * │                                                                            │
 * │ 늘려서 될 값이 아니다 — 컷을 10 → 22 → 28초로 세 번 올렸고 세 번 다 컷에       │
 * │ 붙었다 (route.ts 의 MAX_DEADLINE_MS 이력). 기다리는 대신 **다시 건다.**        │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ★ SPEC §12.3 의 "재시도 0"을 어기지 않는다. 그 규칙이 막는 건 **직렬 재시도**다
 *   ("재시도가 켜져 있으면 실제 대기가 8초 × (재시도+1)이 된다", SPEC 716줄).
 *   여기는 순차가 아니라 나란히라 전체 대기가 바깥 컷 그대로다. 그리고 **실패에는
 *   다시 걸지 않는다** — 첫 시도가 에러로 끝나면 그 에러가 그대로 답이다.
 *   늘어나는 건 요청 수뿐이고, 그것도 첫 요청이 이미 조용히 시간을 죽였을 때만이다.
 */

/**
 * 시도 하나.
 *
 * `onFirstToken` 은 **"이 연결이 살아 있다"는 유일한 신호**다 — 응답 헤더는 큐에
 * 걸린 요청도 즉시 주므로, 살아 있는지는 본문 첫 바이트로만 알 수 있다.
 * 한 번만 부르면 된다 (두 번 이상 불러도 결과는 같다).
 */
export type HedgeAttempt<T> = (signal: AbortSignal, onFirstToken: () => void) => Promise<T>;

/** 다른 연결이 먼저 답해서 접는 쪽에 실리는 사유. 바깥 컷과 구분하려고 따로 둔다. */
export const HEDGE_ABORT_REASON = '헤지 — 다른 연결이 먼저 답했다';

/**
 * `attempt` 를 걸고, `hedgeAfterMs` 안에 첫 토큰이 안 오면 **하나 더 나란히** 건다.
 * 먼저 성공하는 쪽을 돌려주고 나머지는 끊는다.
 *
 * - 첫 시도가 그 전에 끝나면(성공이든 실패든) 두 번째는 아예 걸지 않는다.
 * - 둘 다 실패하면 **첫 시도의 사유**를 던진다 — 폴백 reasoning 에 그게 실려야
 *   나중에 로그로 원인을 가릴 수 있다 (world_agent_logs.reasoning).
 * - 바깥 `signal` 은 두 시도 모두에 그대로 전달된다. 전체 대기는 늘지 않는다.
 */
export async function hedgeOnStall<T>(
  attempt: HedgeAttempt<T>,
  signal: AbortSignal,
  hedgeAfterMs: number,
): Promise<T> {
  /*
   * 이미 끊긴 채로 들어오면 **아무것도 걸지 않는다.** 시도에게 넘겨서 알아서
   * 끊기라고 두면, 끊긴 signal 을 안 보고 이벤트만 기다리는 구현이 영영 매달린다
   * (fetch 는 잘 끊지만 그건 fetch 의 예의지 이 함수의 보장이 아니다).
   */
  if (signal.aborted) throw signal.reason;

  /** 시도 하나를 바깥 signal 에 묶어서 띄운다. 각자 따로 끊을 수 있어야 한다. */
  const spawn = (onFirstToken: () => void): { promise: Promise<T>; abort: () => void } => {
    const ac = new AbortController();
    const relay = (): void => ac.abort(signal.reason);
    signal.addEventListener('abort', relay, { once: true });
    return {
      promise: attempt(ac.signal, onFirstToken).finally(() =>
        signal.removeEventListener('abort', relay),
      ),
      abort: () => ac.abort(new Error(HEDGE_ABORT_REASON)),
    };
  };

  let alive = false;
  const first = spawn(() => {
    alive = true;
  });

  // 첫 토큰이 오거나 첫 시도가 끝나면 여기서 null — 두 번째는 걸지 않는다.
  const second = await new Promise<{ promise: Promise<T>; abort: () => void } | null>((resolve) => {
    const timer = setTimeout(() => resolve(alive ? null : spawn(() => {})), hedgeAfterMs);
    void first.promise
      .catch(() => undefined)
      .then(() => {
        clearTimeout(timer);
        resolve(null);
      });
  });

  if (!second) return first.promise;

  /*
   * ★ 헤지가 걸렸다는 사실을 남긴다 (wrangler tail).
   *
   *   world_agent_logs 로는 이걸 볼 수 없다 — 거기 남는 건 "몇 초 걸렸나"뿐이라
   *   두 번째를 걸고도 못 건진 것인지, 애초에 안 걸린 것인지 구분이 안 된다.
   *   실제로 그 구분이 안 돼서 한 번 헛다리를 짚었다 (2026-08-09).
   *   자리·방을 싣지 않는다 — 운영자만 보는 로그지만 봇을 특정할 값은 안 넣는다 (I1).
   */
  const t0 = Date.now();
  console.warn(`[hedge] ${hedgeAfterMs}ms 무응답 — 두 번째 연결을 건다`);

  try {
    // Promise.any 는 **먼저 성공하는** 쪽을 준다 — 한쪽이 실패해도 다른 쪽을 기다린다.
    const winner = await Promise.any([first.promise, second.promise]);
    console.warn(`[hedge] 건짐 — 두 번째를 건 뒤 ${Date.now() - t0}ms`);
    return winner;
  } catch {
    console.warn(`[hedge] 둘 다 실패 — 두 번째를 건 뒤 ${Date.now() - t0}ms`);
    // 둘 다 실패. AggregateError 대신 첫 시도의 사유로 되돌린다 (위 머리말).
    return await first.promise;
  } finally {
    first.abort();
    second.abort();
  }
}
