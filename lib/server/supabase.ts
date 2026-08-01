/**
 * Supabase 클라이언트 팩토리. 소유: A (SPEC §2)
 *
 * SPEC §12.2 — 요청마다 만들지 말고 모듈 스코프에서 재사용한다.
 * 서버리스에서 요청당 새 클라이언트를 만들면 커넥션이 바닥난다.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createBrowserClient, createServerClient } from '@supabase/ssr';

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

/**
 * anon 키와 프로젝트 주소를 어디서 가져오는가 — **실행 위치에 따라 다르다.**
 *
 * ┌────────────┬──────────────────────────┬────────────────────────────────────┐
 * │ 서버       │ process.env 를 그대로     │ 로컬은 .env.local, 배포는 워커 변수 │
 * │ 브라우저   │ GET /api/config           │ 브라우저엔 process.env 가 없다      │
 * └────────────┴──────────────────────────┴────────────────────────────────────┘
 *
 * ★ 브라우저에서 `process.env.NEXT_PUBLIC_*` 을 읽지 않는다. 읽어도 되는 것처럼
 *   보이지만, 그 값은 **빌드할 때 박힌 것**이라 배포된 워커의 변수를 고쳐도 바뀌지
 *   않는다. 빌드 기계의 .env.local 이 비어 있으면 그 자리는 조용히 undefined 가
 *   되고 — 빌드는 에러 없이 통과한다 — 브라우저에서야 터진다. 실제로 그렇게 한 번
 *   배포됐다. 그래서 브라우저 경로는 통로를 서버 하나로 좁혔다 (app/api/config).
 */
async function browserConfig(): Promise<{ url: string; anonKey: string }> {
  if (typeof window === 'undefined') {
    return {
      url: requireEnv('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL),
      anonKey: requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    };
  }

  const res = await fetch('/api/config', { cache: 'no-store' });
  if (!res.ok) {
    // 라우트는 실패할 때 { error } 를 준다 (lib/server/auth.ts apiError).
    // 그 문구가 "어느 변수가 비었는지"를 이미 말해주므로 그대로 올린다.
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `/api/config ${res.status}`);
  }
  const { supabaseUrl, supabaseAnonKey } = (await res.json()) as {
    supabaseUrl: string;
    supabaseAnonKey: string;
  };
  return { url: supabaseUrl, anonKey: supabaseAnonKey };
}

/**
 * 만들어진 클라이언트가 아니라 **약속**을 붙들어 둔다.
 * 화면이 뜨자마자 여러 쿼리가 동시에 이걸 부르는데, 클라이언트만 캐싱하면
 * 첫 응답이 오기 전에 들어온 호출들이 저마다 /api/config 를 때린다.
 */
let browserClient: Promise<SupabaseClient> | null = null;

/**
 * 브라우저용. anon 키를 쓰므로 RLS(supabase/policies.sql)가 그대로 적용된다.
 *
 * ┌─ 세션을 **쿠키**에 담는다 (SPEC §15-2-결정) ───────────────────────────────┐
 * │ 원래 이 클라이언트는 persistSession: false 였다 — 익명 플레이라 로그인이   │
 * │ 없었기 때문이다. 계정이 붙으면서 그대로 두면 새로고침 한 번에 세션이       │
 * │ 사라진다.                                                                 │
 * │                                                                           │
 * │ localStorage 가 아니라 쿠키인 이유는 **서버도 읽어야 하기 때문**이다.      │
 * │   · /api/room/join 이 players.user_id 를 찍는다                            │
 * │   · 구글 콜백이 PKCE 검증값을 읽어야 한다 (localStorage 면 서버가 못 본다) │
 * │ 쿠키로 두면 기존 lib/api/* 의 fetch 가 한 줄도 안 바뀐다 — 요청마다 헤더를 │
 * │ 붙이는 방식은 새 라우트를 만들 때마다 빠뜨릴 수 있다.                      │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 세션 쿠키는 httpOnly 가 아니다. player_token(§17.4)과 헷갈리지 않는다 —
 *   그쪽은 서버만 보는 비밀값이고, 이쪽은 브라우저의 supabase-js 가 직접 읽어야
 *   하는 JWT 다. 둘은 역할이 다르고 **둘 다 있어야 한다.**
 */
export function getBrowserClient(): Promise<SupabaseClient> {
  browserClient ??= browserConfig()
    .then(({ url, anonKey }) => {
      const db = createBrowserClient(url, anonKey, {
        // SPEC §12.4 — 채팅 구간에서 클라이언트가 이벤트에 잠기지 않게 상한을 둔다.
        realtime: { params: { eventsPerSecond: 10 } },
      });

      /*
       * ★ 실시간 연결에도 새 토큰을 물려준다.
       *
       *   Realtime 은 붙을 때 쥔 토큰을 계속 쓴다. 액세스 토큰은 1시간이면 만료되는데,
       *   갱신된 토큰을 소켓에 안 넘기면 그 시각부터 **에러 없이 이벤트만 안 온다** —
       *   구독은 SUBSCRIBED 그대로다. 페이즈가 안 넘어가는 증상으로만 보이고
       *   원인을 코드에서 찾게 된다. supabase-js 가 대개 알아서 하지만,
       *   조용히 깨지는 종류의 실패라 여기서 한 번 더 못 박는다 (SPEC §7.3 참고).
       */
      db.auth.onAuthStateChange((_event, session) => {
        db.realtime.setAuth(session?.access_token ?? anonKey);
      });

      return db;
    })
    .catch((e: unknown) => {
      // 실패한 약속을 붙들고 있으면 설정을 고쳐도 새로고침 전까지 계속 같은 에러다.
      browserClient = null;
      throw e;
    });
  return browserClient;
}

/**
 * 서버에서 **요청자의 세션**을 읽는 클라이언트 (SPEC §15-2-결정).
 *
 * anon 키를 쓰므로 RLS가 그대로 걸린다. getServiceClient 와 헷갈리지 않는다 —
 * 이쪽은 "이 요청을 보낸 사람이 누구인가"를 알아내는 용도이고,
 * 실제 쓰기는 여전히 service role 이 한다 (I9).
 *
 * ★ 요청마다 새로 만든다. 모듈 스코프에 캐싱하면 **다른 사람의 쿠키를 붙든 채**
 *   재사용되어 서로의 계정이 섞인다. §12.2(요청마다 만들지 말 것)의 예외다 —
 *   그 규칙은 상태가 없는 클라이언트를 위한 것이다.
 */
export async function getServerAuthClient(): Promise<SupabaseClient> {
  if (typeof window !== 'undefined') {
    throw new Error('getServerAuthClient는 서버에서만 호출한다.');
  }
  const { cookies } = await import('next/headers');
  const store = await cookies();

  return createServerClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL),
    requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    {
      cookies: {
        getAll: () => store.getAll(),
        setAll: (list) => {
          // Server Component 에서는 쿠키를 쓸 수 없어 던진다. 그 경우는 읽기 전용이라
          // 무시해도 된다 — 토큰 갱신은 Route Handler 쪽에서 일어난다.
          try {
            for (const { name, value, options } of list) store.set(name, value, options);
          } catch {
            /* Server Component — 무시 */
          }
        },
      },
    },
  );
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
