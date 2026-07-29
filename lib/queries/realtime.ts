'use client';

/**
 * Supabase Realtime → 쿼리 무효화. 소유: A
 *
 * ★ I10 — 구독에 반드시 방 필터를 건다. 필터가 없으면 **다른 방의 전환 이벤트가
 *   내 화면에 들어와** 엉뚱한 타이밍에 화면이 넘어간다. 채널 이름도 code 가 아니라
 *   room_id 다 (SPEC §6.3) — 코드는 방이 정리되면 재사용된다 (SPEC §16.4).
 *
 * 무엇이 바뀌었는지는 보지 않는다. phase_seq 든 roster_seq 든 바뀌었으면
 * 그 방 쿼리를 통째로 무효화하고, 무엇을 다시 읽을지는 react-query 가 정한다
 * (구독 중인 쿼리만 실제로 다시 나간다 — 이게 예전 refresh() 와 다른 점이다).
 */

import { useEffect, useRef } from 'react';

import { getBrowserClient } from '@/lib/server/supabase';

export function useRoomRealtime(roomId: string | undefined, onChange: () => void): void {
  /**
   * 콜백을 ref 에 담아 둔다. 의존성에 직접 넣으면 렌더마다 채널을 끊고 다시 연다 —
   * 그 사이에 온 이벤트는 사라지고, 재구독이 잦으면 Realtime 쪽에서 끊긴다.
   */
  const handler = useRef(onChange);
  handler.current = onChange;

  useEffect(() => {
    if (!roomId) return;
    const db = getBrowserClient();

    const channel = db
      .channel(`room:${roomId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` },
        () => handler.current(),
      )
      .subscribe();

    return () => {
      void db.removeChannel(channel);
    };
  }, [roomId]);
}
