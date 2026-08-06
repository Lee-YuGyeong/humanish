'use client';

/**
 * 로비에 들어오면, 판 도중 나갔던 3D 월드 방으로 자동 재입장시킨다. 소유: 원상
 *
 * CEO 결정 2026-08-06: 뒤로가기·퇴장으로 월드 방을 나가도 중도포기·자동 패배는
 * 없다 (SPEC §18.6). 대신 로비로 오면 그 방으로 자동으로 다시 들어간다 —
 * 방이 끝나서 삭제되기 전까지는. 돌아갈 방 코드는 app/world/active-room.ts 가
 * localStorage 에 남겨 둔다.
 *
 * ┌─ 왜 화면을 안 그리나 ──────────────────────────────────────────────────────┐
 * │ 이 컴포넌트는 null 을 반환한다 — 로비 화면(Lobby)은 그대로 두고, 마운트    │
 * │ 시 한 번만 판단해서 돌려보낸다. router.replace 라 히스토리에 /main 을 쌓지 │
 * │ 않는다(로비↔월드 뒤로가기 핑퐁 방지).                                      │
 * │                                                                            │
 * │ 방이 이미 삭제됐으면? /world 의 enter 가 /api/room/join 에서 실패하고,      │
 * │ 그 catch 가 기록을 지운다(page.tsx). 그래서 죽은 방으로 되돌린 경우엔 한    │
 * │ 번 튕겼다가 다음 로비 방문부터는 안 끌려간다 — 무한 루프가 없다.           │
 * └────────────────────────────────────────────────────────────────────────────┘
 */

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

import { getActiveRoom } from '@/app/world/active-room';

export function WorldRejoin() {
  const router = useRouter();
  // StrictMode 이중 마운트·리렌더에도 딱 한 번만 판단한다.
  const decided = useRef(false);

  useEffect(() => {
    if (decided.current) return;
    decided.current = true;

    const code = getActiveRoom();
    if (!code) return;

    // /world 의 자동 입장 효과가 ?code 를 읽어 join→ticket→connect 를 잇는다.
    router.replace(`/world?code=${encodeURIComponent(code)}`);
  }, [router]);

  return null;
}
