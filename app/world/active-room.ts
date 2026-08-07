/**
 * "지금 들어가 있던 3D 월드 방"을 브라우저에 적어 둔다. 소유: 원상 (app/world/)
 *
 * ┌─ 왜 있나 (CEO 결정 2026-08-06) ────────────────────────────────────────────┐
 * │ 판 도중에 뒤로가기·헤더 퇴장으로 방을 나가도 **중도포기·자동 패배는 없다**  │
 * │ (SPEC §18.6 — 이탈은 자리를 그대로 둔다). 대신 로비(/main)로 돌아오면       │
 * │ **그 방으로 돌아갈지 물어본다** — 방이 끝나서 삭제되기 전까지는.            │
 * │ (2026-08-07 전에는 묻지 않고 자동으로 되돌렸다. 이유는 world-rejoin.tsx.)   │
 * │                                                                            │
 * │ 재입장 자체는 서버가 이미 player_token 쿠키로 해 준다(/api/room/join 이     │
 * │ 원래 자리를 200 으로 돌려준다). 빠진 건 **로비가 "어느 방으로 돌아갈지"를    │
 * │ 아는 것**뿐이라, 그 방 코드 하나만 여기(localStorage)에 남긴다.             │
 * │                                                                            │
 * │ · set   — 월드 방에 실제로 붙었을 때 (page.tsx enter)                       │
 * │ · clear — 판이 끝나 방을 접을 때 (page.tsx endGameToLobby) · 재입장 실패 시  │
 * │           · 물음에 「나가기」를 골랐을 때 (world-rejoin.tsx)                │
 * │ · get   — 로비가 마운트될 때 (app/main/world-rejoin.tsx)                    │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 방 **코드**만 담는다. 좌석·역할·정체는 절대 넣지 않는다 — localStorage 는
 *   같은 브라우저의 어떤 스크립트든 읽으므로, 정체가 들어가면 그게 곧 누출이다 (I1).
 *   코드는 입장하려면 어차피 알아야 하는 공개값이다.
 */

const KEY = 'world:activeRoom';

/** SSR·비브라우저에서 안전하게 접근한다. localStorage 는 사생활 모드에서 던질 수 있다. */
function safeStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** 이 방에 붙어 있다고 기록한다. 대문자 코드 하나. */
export function setActiveRoom(code: string): void {
  const trimmed = code.trim().toUpperCase();
  if (!trimmed) return;
  safeStorage()?.setItem(KEY, trimmed);
}

/** 돌아갈 방 코드. 없으면 null. */
export function getActiveRoom(): string | null {
  const v = safeStorage()?.getItem(KEY) ?? null;
  return v && v.trim() ? v : null;
}

/** 기록을 지운다. 판이 끝났거나(방 삭제) 재입장이 실패했을 때. */
export function clearActiveRoom(): void {
  safeStorage()?.removeItem(KEY);
}
