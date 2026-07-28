/**
 * 테스트 러너 설정. 소유: A (SPEC §14.1)
 *
 * `npm test` — 순수 함수와 화면 조각을 검사한다.
 *
 * ┌─ 여기서 검사하지 않는 것 ───────────────────────────────────────────────┐
 * │ DB · RLS · 상태머신 동시성  →  ./supabase/test.sh (일회용 Postgres)     │
 * │ 라우트 왕복 · anon 침투     →  ./supabase/e2e.sh  (개발 서버 + 실 DB)   │
 * │                                                                        │
 * │ 나눈 이유는 속도가 아니라 **거짓 통과** 때문이다. DB 동작을 목으로     │
 * │ 흉내 내면 로컬만 초록불이 된다 — 이 저장소는 이미 그걸로 두 번 데였다  │
 * │ (supabase/checks.sh 머리말). DB가 하는 일은 진짜 DB에 물어본다.        │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * 테스트는 `tests/` 아래에 소스 구조를 그대로 따라 둔다. 소스 옆에 두지 않는 이유는
 * 폴더 소유권 때문이다 (CLAUDE.md) — 남의 폴더에 파일을 만들지 않아도 되게.
 */
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // 소스가 쓰는 `@/` 별칭. tsconfig.json의 paths와 같은 값이어야 한다.
    alias: { '@': fileURLToPath(new URL('./', import.meta.url)) },
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    // 기본은 node다. DOM이 필요한 파일만 맨 위에 `// @vitest-environment jsdom`을 적는다.
    // 전부 jsdom으로 돌리면 순수 함수 테스트까지 느려진다.
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
  },
});
