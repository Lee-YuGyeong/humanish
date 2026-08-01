'use client';

/**
 * 전역 프로바이더. 소유: A (계층 인프라)
 *
 * ★ QueryClient 를 모듈 스코프에 만들지 않는다.
 *   서버에서 모듈은 여러 요청이 공유하므로, 거기에 캐시를 두면 **다른 사람의 방
 *   데이터가 내 응답에 섞인다.** useState 의 초기화 함수는 클라이언트 트리마다
 *   한 번만 도므로 탭 하나당 캐시 하나가 된다.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { ensureSession } from '@/lib/auth';

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        /**
         * 기본은 짧게 둔다. 이 게임의 화면은 대부분 초 단위로 바뀌고,
         * 오래된 값을 그리면 "내 답만 안 올라간다"처럼 보인다.
         * 방 화면은 여기에 더해 staleTime 0 을 쓴다 (lib/queries/room.ts 의 LIVE).
         */
        staleTime: 5_000,
        /**
         * 백그라운드 탭에서 돌아오면 다시 읽는다 (SPEC §12.1 2번).
         * 예전에는 화면마다 visibilitychange 리스너를 직접 달았다.
         */
        refetchOnWindowFocus: true,
        /**
         * 한 번만 재시도한다. 기본값(3회)은 지수 백오프까지 붙어서, 방이 없는
         * 코드로 들어왔을 때 "그런 방이 없다"가 뜨기까지 몇 초가 걸린다.
         */
        retry: 1,
      },
      mutations: {
        // 쓰기는 재시도하지 않는다. 답변·투표가 두 번 들어가는 편이 훨씬 나쁘다.
        retry: 0,
      },
    },
  });
}

/**
 * 익명 계정을 깐다 (SPEC §15-2-결정).
 *
 * ┌─ 왜 여기인가 ──────────────────────────────────────────────────────────────┐
 * │ 앱의 모든 화면이 이 프로바이더를 지난다. 방에 들어가기 **전에** 세션이     │
 * │ 있어야 /api/room/join 이 players.user_id 를 찍을 수 있다 — 방 화면에서     │
 * │ 부르면 이미 늦다.                                                          │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 사용자는 아무것도 누르지 않는다. 로그인 화면이 없다는 것이 이 설계의 핵심이다.
 *
 * ★ 실패해도 아무 일도 하지 않는다 (ensureSession 이 던지지 않는다).
 *   계정을 못 만들어도 게임은 그대로 돌아가고 players.user_id 가 null 이 될 뿐이다.
 *   여기서 막으면 대시보드 설정 하나 때문에 게임 전체가 멈춘다.
 *
 * ★ 렌더를 막지 않는다. await 하지 않고 띄워만 둔다 — 계정을 기다리느라
 *   첫 화면이 늦어질 이유가 없다.
 */
function useAnonymousSession(): void {
  useEffect(() => {
    void ensureSession();
  }, []);
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(createQueryClient);
  useAnonymousSession();
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
