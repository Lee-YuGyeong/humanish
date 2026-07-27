/**
 * Supabase 클라이언트 팩토리. 소유: A (SPEC §2)
 *
 * SPEC §12.2 — 요청마다 만들지 말고 모듈 스코프에서 재사용한다.
 * 서버리스에서 요청당 새 클라이언트를 만들면 커넥션이 바닥난다.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Next는 `process.env.X` 형태의 리터럴 접근만 클라이언트 번들에 인라인한다.
 * `process.env[name]`처럼 동적으로 읽으면 브라우저에서 undefined가 된다.
 * 그래서 이름과 값을 따로 받는다.
 */
function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`환경변수 ${name}이(가) 비어 있다. .env.local.example 참고.`);
  }
  return value;
}

let browserClient: SupabaseClient | null = null;

/** 브라우저용. anon 키를 쓰므로 RLS(supabase/policies.sql)가 그대로 적용된다. */
export function getBrowserClient(): SupabaseClient {
  if (browserClient) return browserClient;

  browserClient = createClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL),
    requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    {
      auth: { persistSession: false },
      // SPEC §12.4 — 채팅 구간에서 클라이언트가 이벤트에 잠기지 않게 상한을 둔다.
      realtime: { params: { eventsPerSecond: 10 } },
    },
  );
  return browserClient;
}

let serviceClient: SupabaseClient | null = null;

/**
 * 서버 전용. RLS를 우회하므로 절대 클라이언트 번들에 들어가면 안 된다.
 * 모든 쓰기(방 생성, 답변 제출, 페이즈 전환)는 이 클라이언트를 거친다.
 */
export function getServiceClient(): SupabaseClient {
  if (typeof window !== 'undefined') {
    throw new Error('getServiceClient는 서버에서만 호출한다. service role 키가 노출된다.');
  }
  if (serviceClient) return serviceClient;

  serviceClient = createClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  return serviceClient;
}
