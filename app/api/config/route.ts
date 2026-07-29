/**
 * 브라우저가 필요로 하는 공개 설정. 소유: A
 *
 * GET /api/config  →  { supabaseUrl, supabaseAnonKey }
 *
 * ┌─ 왜 라우트가 하나 더 있는가 ───────────────────────────────────────────────┐
 * │ 브라우저에는 process.env 가 없다. Next 가 값을 브라우저까지 보내는 방법은   │
 * │ **빌드할 때 JS 안에 문자열로 박아 넣는 것** 하나뿐이고, 그 재료는 빌드하는  │
 * │ 기계의 .env.local 에서 온다. 즉 Cloudflare 대시보드에 넣은 Workers 변수는   │
 * │ 브라우저에 절대 닿지 못한다 — 워커가 요청을 처리할 때만 존재하기 때문이다. │
 * │                                                                            │
 * │ 그래서 통로를 하나 만든다. 이 라우트는 서버(=워커)에서 돌므로 Workers 변수를│
 * │ 읽을 수 있고, 그걸 브라우저에 내려준다. 값이 어디서 왔는지는 신경 쓰지      │
 * │ 않는다 — 로컬에서는 .env.local, 배포에서는 Workers 변수가 같은 자리에 온다. │
 * │ 덕분에 배포할 때 "빌드 전에 채워야 하는 값"이 없어진다.                     │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ★ process.env 를 통째로 내보내지 않는다. 아래 두 개만, 이름을 손으로 적어서 준다.
 *   전개(spread)나 필터로 만들면 다음에 누가 env 를 하나 더 넣는 순간 같이 새어 나간다 —
 *   SUPABASE_SERVICE_ROLE_KEY 가 새면 RLS 가 통째로 무의미해지고(I9),
 *   NVIDIA_NIM_API_KEY 가 새면 I4 가 깨진다. **새 값을 더할 때마다
 *   "이게 브라우저에 보여도 되는가"를 먼저 묻는다.**
 *
 *   여기 있는 둘은 원래 공개값이다. supabase 프로젝트 주소와 anon 키는 설계상
 *   브라우저에 실려 나가고(그래서 이름이 NEXT_PUBLIC_ 이다), 권한은 키가 아니라
 *   RLS(supabase/policies.sql)가 지킨다.
 */

import { ApiError, apiError } from '@/lib/server/auth';

export const dynamic = 'force-dynamic';

export interface PublicConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export async function GET(): Promise<Response> {
  try {
    // 리터럴 접근으로 하나씩 읽는다. process.env[name] 같은 동적 접근은
    // 번들러가 추적하지 못해서 조용히 undefined 가 되는 자리다.
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      throw new ApiError(
        503,
        'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY 가 없다. ' +
          '로컬은 .env.local, 배포는 워커 변수에 넣는다 (.env.local.example 참고)',
      );
    }

    return Response.json(
      { supabaseUrl, supabaseAnonKey } satisfies PublicConfig,
      // no-store 인 이유 — 값을 바꾸면(키 교체·프로젝트 이전) 다음 요청부터 바로
      // 반영되어야 한다. 브라우저는 이걸 한 번만 부른다 (lib/server/supabase.ts 가
      // 모듈 스코프에 붙들어 둔다). 페이지 로드당 왕복 한 번이 캐시를 안 두는 값이다.
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    return apiError(e);
  }
}
