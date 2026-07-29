'use client';

/**
 * 카운트다운과 만료 감지 (SPEC §5.2, §12.5). 소유: A
 *
 * ┌─ I2 — 여기 있는 시계는 **표시용이다** ─────────────────────────────────────┐
 * │ 남은 초를 그리고, 0이 되면 서버에게 "전환할 때가 된 것 같다"고 **물어본다.** │
 * │ 전환 여부는 서버가 정한다 (advance_phase). 내 시계가 조금 빠르면 서버가     │
 * │ advanced:false 를 주고, 그건 정상이다.                                     │
 * └────────────────────────────────────────────────────────────────────────────┘
 */

import { useEffect, useRef, useState } from 'react';

import type { Room } from '@/lib/game/types';

/** 0.5초마다 그린다. 1초로 하면 숫자가 한 칸씩 건너뛰는 게 보인다. */
const TICK_MS = 500;

export function usePhaseCountdown(
  room: Room | null | undefined,
  serverNow: () => number,
  requestAdvance: (expectedSeq: number) => Promise<{ advanced: boolean } | undefined>,
): number | null {
  const [remainMs, setRemainMs] = useState<number | null>(null);

  /** 같은 phase_seq 로 전환을 두 번 부르지 않게 하는 표시 (I6) */
  const askedSeq = useRef<number | null>(null);
  const ask = useRef(requestAdvance);
  ask.current = requestAdvance;

  const endsAt = room?.phase_ends_at;
  const roomId = room?.id;
  const seq = room?.phase_seq;

  useEffect(() => {
    if (!endsAt || !roomId || seq == null) {
      setRemainMs(null);
      return;
    }
    const deadline = new Date(endsAt).getTime();

    const tick = () => {
      const left = deadline - serverNow();
      setRemainMs(left);

      if (left > 0 || askedSeq.current === seq) return;

      // 요청이 나가 있는 동안 다시 부르지 않게 **먼저** 찍는다 (I6)
      askedSeq.current = seq;

      void ask
        .current(seq)
        .then((result) => {
          /**
           * ★ 실패했으면 무장을 푼다.
           *
           * 내 시계가 조금 빨라서 만료 전에 부르면 서버가 advanced:false 를 준다.
           * 그때 이 표시를 그대로 두면 **그 페이즈에서는 다시는 전환을 시도하지
           * 않는다.** 방에 사람이 나뿐이면 워치독이 훑을 때까지 화면이 0초에 멈춘다.
           * I6 이 막아야 하는 건 중복 전환이지 재시도가 아니다.
           */
          if (result?.advanced === false) askedSeq.current = null;
        })
        .catch(() => {
          askedSeq.current = null; // 네트워크 실패도 재시도 대상이다
        });
    };

    tick();
    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, [roomId, seq, endsAt, serverNow]);

  return remainMs;
}
