/**
 * 무응답 헤지 (lib/agent/hedge.ts).
 *
 * 여기서 잡으려는 고장은 하나다 — **첫 토큰이 안 오는 연결에 컷을 통째로 태우는 것.**
 * 실제 신고(2026-08-09 "3D 월드에서 AI 가 대답을 안 한다")의 모양이 그거였고,
 * 공급자가 멀쩡할 때는 재현되지 않아서 실측으로는 확인할 수 없다. 그래서 멈추는
 * 시도를 여기서 만들어 놓고 검사한다.
 *
 * 가짜 타이머를 쓴다 — 6초를 진짜로 기다리지 않는다.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { HEDGE_ABORT_REASON, hedgeOnStall } from '@/lib/agent/hedge';

const HEDGE_AFTER = 6_000;

afterEach(() => {
  vi.useRealTimers();
});

/** 절대 첫 토큰을 내지 않고, 끊길 때까지 매달려 있는 시도. */
function stalls(onAbort?: (reason: unknown) => void) {
  return (signal: AbortSignal) =>
    new Promise<string>((_, reject) => {
      signal.addEventListener('abort', () => {
        onAbort?.(signal.reason);
        reject(signal.reason);
      });
    });
}

/** `afterMs` 뒤에 첫 토큰을 내고 `doneMs` 에 답하는 시도. */
function answers(text: string, firstTokenMs: number, doneMs: number) {
  return (signal: AbortSignal, onFirstToken: () => void) =>
    new Promise<string>((resolve, reject) => {
      const t1 = setTimeout(onFirstToken, firstTokenMs);
      const t2 = setTimeout(() => resolve(text), doneMs);
      signal.addEventListener('abort', () => {
        clearTimeout(t1);
        clearTimeout(t2);
        reject(signal.reason);
      });
    });
}

describe('hedgeOnStall', () => {
  it('첫 토큰이 제때 오면 두 번째를 걸지 않는다', async () => {
    vi.useFakeTimers();
    const attempts: number[] = [];
    const p = hedgeOnStall(
      (signal, onFirstToken) => {
        attempts.push(1);
        return answers('첫 시도 답', 1_000, 3_000)(signal, onFirstToken);
      },
      new AbortController().signal,
      HEDGE_AFTER,
    );

    await vi.advanceTimersByTimeAsync(3_000);
    await expect(p).resolves.toBe('첫 시도 답');
    expect(attempts).toHaveLength(1);
  });

  it('첫 시도가 컷 전에 끝나면(실패해도) 다시 걸지 않는다 — 직렬 재시도가 아니다', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const p = hedgeOnStall(
      () => {
        calls += 1;
        return Promise.reject(new Error('NIM 500'));
      },
      new AbortController().signal,
      HEDGE_AFTER,
    );

    await expect(p).rejects.toThrow('NIM 500');
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER * 2);
    expect(calls).toBe(1);
  });

  it('첫 시도가 멈추면 두 번째를 걸고 그쪽 답을 쓴다 — 이게 침묵을 막는 자리다', async () => {
    vi.useFakeTimers();
    let n = 0;
    const p = hedgeOnStall(
      (signal, onFirstToken) => {
        n += 1;
        return n === 1
          ? stalls()(signal)
          : answers('두 번째 답', 500, 2_000)(signal, onFirstToken);
      },
      new AbortController().signal,
      HEDGE_AFTER,
    );

    await vi.advanceTimersByTimeAsync(HEDGE_AFTER + 2_000);
    await expect(p).resolves.toBe('두 번째 답');
    expect(n).toBe(2);
  });

  it('첫 시도가 늦게라도 답하면 그걸 쓴다 — 두 번째가 안 와도 침묵하지 않는다', async () => {
    vi.useFakeTimers();
    let n = 0;
    const p = hedgeOnStall(
      (signal, onFirstToken) => {
        n += 1;
        // 첫 시도는 첫 토큰이 늦게(9초) 오지만 결국 답한다. 두 번째는 영영 멈춘다.
        return n === 1 ? answers('늦은 첫 답', 9_000, 10_000)(signal, onFirstToken) : stalls()(signal);
      },
      new AbortController().signal,
      HEDGE_AFTER,
    );

    await vi.advanceTimersByTimeAsync(11_000);
    await expect(p).resolves.toBe('늦은 첫 답');
    expect(n).toBe(2);
  });

  it('이긴 쪽이 정해지면 진 쪽을 끊는다 — 남겨 두면 남의 지갑만 쓴다', async () => {
    vi.useFakeTimers();
    const aborted: unknown[] = [];
    let n = 0;
    const p = hedgeOnStall(
      (signal, onFirstToken) => {
        n += 1;
        return n === 1
          ? stalls((r) => aborted.push(r))(signal)
          : answers('두 번째 답', 500, 2_000)(signal, onFirstToken);
      },
      new AbortController().signal,
      HEDGE_AFTER,
    );

    await vi.advanceTimersByTimeAsync(HEDGE_AFTER + 2_000);
    await expect(p).resolves.toBe('두 번째 답');
    expect(aborted).toHaveLength(1);
    expect((aborted[0] as Error).message).toBe(HEDGE_ABORT_REASON);
  });

  it('둘 다 멈추면 **첫 시도의 사유**를 던진다 — 로그로 원인을 가려야 한다', async () => {
    vi.useFakeTimers();
    const outer = new AbortController();
    const p = hedgeOnStall((signal) => stalls()(signal), outer.signal, HEDGE_AFTER);
    // 아무도 답하지 않은 채 바깥 컷이 먼저 끊는다 (withDeadline 이 하는 일).
    await vi.advanceTimersByTimeAsync(HEDGE_AFTER + 1_000);
    outer.abort(new Error('시간 초과 (28000ms)'));

    await expect(p).rejects.toThrow('시간 초과 (28000ms)');
  });

  it('바깥 컷은 두 시도 모두를 끊는다 — 전체 대기가 늘지 않는다', async () => {
    vi.useFakeTimers();
    const aborted: unknown[] = [];
    const outer = new AbortController();
    const p = hedgeOnStall((signal) => stalls((r) => aborted.push(r))(signal), outer.signal, HEDGE_AFTER);

    await vi.advanceTimersByTimeAsync(HEDGE_AFTER + 1_000);
    outer.abort(new Error('시간 초과 (28000ms)'));
    await expect(p).rejects.toThrow('시간 초과');

    expect(aborted).toHaveLength(2);
    for (const r of aborted) expect((r as Error).message).toBe('시간 초과 (28000ms)');
  });

  it('이미 끊긴 signal 로 들어오면 시도를 걸지 않고 곧바로 끊긴다', async () => {
    const outer = new AbortController();
    outer.abort(new Error('이미 끝났다'));
    let calls = 0;
    await expect(
      hedgeOnStall(
        (signal) => {
          calls += 1;
          return stalls()(signal);
        },
        outer.signal,
        HEDGE_AFTER,
      ),
    ).rejects.toThrow('이미 끝났다');
    expect(calls).toBe(0);
  });
});
