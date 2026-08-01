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
import { useState } from 'react';

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

/*
 * ★ 익명 계정을 자동으로 만들지 않는다 (SPEC §15-2-결정).
 *
 *   한때 여기서 signInAnonymously() 를 걸었다. 로그인 화면 없이 놀게 하려던
 *   설계였고, 그 결정이 뒤집혔다 — 이제 게임에 들어가려면 /login 을 지난다
 *   (components/require-login.tsx).
 *
 *   자동 익명 로그인을 남겨두면 **누가 방문할 때마다 아무도 안 쓰는 계정이
 *   하나씩 쌓인다.** Supabase 는 그걸 자동으로 지우지 않는다.
 */

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(createQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
