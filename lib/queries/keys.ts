/**
 * 쿼리 키 팩토리. 소유: A
 *
 * ┌─ 왜 키를 한 파일에 모으는가 ───────────────────────────────────────────────┐
 * │ 키를 호출부에서 배열 리터럴로 적으면 읽는 쪽과 무효화하는 쪽이 **조용히**   │
 * │ 갈린다. ['answers', roomId] 로 넣고 ['answer', roomId] 로 지우면 타입도     │
 * │ 통과하고 런타임 에러도 없다. 그냥 화면이 갱신되지 않을 뿐이다.              │
 * │ 오타를 컴파일 에러로 만들려고 함수로 감싼다.                               │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 두 번째 목적이 더 중요하다 — **방 스코프(I10)를 키의 모양으로 강제한다.**
 *   방에 속한 키는 전부 scope(roomId) 로 시작한다. 그래서
 *   invalidate(scope(roomId)) 한 번이면 그 방 것만 정확히 지워지고,
 *   다른 방 데이터는 애초에 같은 접두사를 가질 수 없다.
 */

/** 방 하나에 속한 모든 키의 뿌리. 무효화는 항상 이 접두사로 한다. */
const scope = (roomId: string) => ['room', roomId] as const;

export const roomKeys = {
  /**
   * 코드로 방 행을 찾는 쿼리.
   *
   * ★ 이것만 roomId 가 아니라 code 로 키를 잡는다 — 아직 id 를 모르는 유일한
   *   지점이기 때문이다. 그래서 scope(roomId) 접두사에 걸리지 않고,
   *   invalidateRoom() 이 이 키를 따로 챙긴다.
   */
  byCode: (code: string) => ['room', 'by-code', code.toUpperCase()] as const,

  scope,

  roster: (roomId: string) => [...scope(roomId), 'roster'] as const,
  me: (roomId: string) => [...scope(roomId), 'me'] as const,
  questions: (roomId: string) => [...scope(roomId), 'questions'] as const,
  answers: (roomId: string) => [...scope(roomId), 'answers'] as const,
  votes: (roomId: string) => [...scope(roomId), 'votes'] as const,
  messages: (roomId: string) => [...scope(roomId), 'messages'] as const,
  reveal: (roomId: string) => [...scope(roomId), 'reveal'] as const,
} as const;

/**
 * 서버 시각 (SPEC §12.5). 방과 무관하므로 스코프 밖이다.
 * 한 번 받아서 계속 쓴다 — 오프셋이지 시계가 아니다.
 */
export const serverTimeKey = ['server-time'] as const;

/** 로비의 열린 방 목록. 특정 방에 속하지 않는다. */
export const openRoomsKey = ['open-rooms'] as const;

/**
 * 대기방 프리셋 문구 목록 (SPEC §15-3-결정).
 * 방마다 다르지 않고 배포 전까지 바뀌지 않으므로 스코프 밖이다 —
 * scope(roomId) 안에 두면 방 무효화 때마다 같은 목록을 다시 받는다.
 */
export const lobbyLinesKey = ['lobby-lines'] as const;

/**
 * 내 계정 (SPEC §15-2-결정).
 *
 * ★ **scope(roomId) 밖이다. 안에 두면 안 된다.**
 *   계정은 방보다 오래 살고 여러 방에 걸쳐 같다. 방 스코프에 넣으면
 *   방을 옮길 때마다 다시 받고, 무엇보다 **계정과 방이 키 모양으로 묶인다** —
 *   여기서부터 "이 방의 그 계정" 같은 조회가 자연스러워 보이기 시작하고,
 *   그게 I1 이 무너지는 첫걸음이다. 계정 세계와 방 세계는 분리한다.
 */
export const authUserKey = ['auth-user'] as const;

/** 내 프로필. 익명 계정에는 없다(null). 계정과 같은 이유로 스코프 밖이다. */
export const profileKey = ['profile'] as const;

/**
 * 내 전적 — 레벨 · 승률 · 판수 · 최근 게임 (SPEC §15-2-결정).
 *
 * ★ profileKey 의 하위가 아니라 **형제**다. 하위로 두면 이름을 짓는 순간
 *   invalidate(profileKey) 가 전적까지 같이 지운다 — 이름과 전적은 같이 바뀌지 않는다.
 * ★ 계정과 같은 이유로 방 스코프 밖이다. 전적은 방보다 오래 산다.
 */
export const profileStatsKey = ['profile-stats'] as const;
