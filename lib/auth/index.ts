/**
 * 계정 계층의 바깥 문. 소유: A (SPEC §15-2-결정)
 *
 * 화면은 `@/lib/auth` 로만 import 한다. 안쪽 파일을 직접 가리키면 계층을 건너뛰게 된다
 * (CLAUDE.md 「상태는 어디에 두는가」와 같은 규칙).
 *
 * ★ 여기 있는 것은 전부 **브라우저용**이다. 서버에서 요청자를 알아내는 것은
 *   lib/server/auth.ts 의 currentUser() 이고, 그쪽은 쿠키 세션을 직접 확인한다.
 */

export {
  getCurrentUser,
  signInWithGoogle,
  signOut,
  type AuthUser,
} from './session';
