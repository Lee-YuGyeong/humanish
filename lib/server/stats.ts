/**
 * 전적을 사람이 읽는 숫자로 바꾼다. 소유: A (SPEC §15-2-결정 「아직 안 한 것」)
 *
 * ┌─ 순수 함수만 둔다 ─────────────────────────────────────────────────────────┐
 * │ DB · 네트워크 · Date.now() 를 쓰지 않는다. 그래서 npm test 가 화면도 DB도   │
 * │ 없이 곡선을 직접 검사한다 (tests/lib/server/stats.test.ts).                 │
 * │ 읽고 쓰는 쪽은 lib/server/match.ts 다.                                      │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ★ lib/game/ 이 아니라 여기 있는 이유: 레벨은 **게임 규칙이 아니다.** 한 판의
 *   승패에 아무 영향이 없고 화면에만 나온다. lib/game/ 은 B 소유이고 규칙만 담는다
 *   (I7). 계산은 서버에서 끝나므로 이 곡선은 클라이언트 번들에 갈 일이 없다.
 *   **모양(ProfileStats · RecentMatch)은 lib/game/types.ts 에 있다** — 도메인 타입은
 *   거기서만 정의한다 (I8).
 */

import type { ProfileStats, RecentMatch } from '@/lib/game/types';

/**
 * 레벨 L 에서 L+1 로 가는 데 드는 경험치 = STEP × L.
 *
 * 경험치는 **그 판에서 얻은 점수 그대로**다 (한 판 최대 4점, lib/game/rules.ts).
 * 따로 환산하지 않는 이유: 환산표를 두면 점수 규칙을 고칠 때 두 군데가 갈린다.
 * **누적은 줄 수도 있다** — 월드 판은 지면 -1 이다 (2026-08-07, lib/server/match.ts).
 * 아래 levelFromExp 가 0 에서 잘라서 레벨이 1 밑으로는 안 내려간다.
 *
 * 10 을 고른 근거는 "잘한 판 서너 번에 한 레벨" 이다 — 초반이 빨리 오르고
 * 뒤로 갈수록 느려진다. 판수가 아니라 점수에 붙였으므로 방을 많이 여는 것만으로는
 * 안 오른다.
 */
const STEP = 10;

/** 레벨 L 에 도달하는 데 필요한 **누적** 경험치. L=1 이면 0. */
function expAtLevel(level: number): number {
  return (STEP * level * (level - 1)) / 2;
}

export interface LevelProgress {
  /** 1부터. 경험치가 0이어도 1이다 — 0레벨은 없다. */
  level: number;
  /** 이번 레벨 안에서 지금까지 쌓은 양 */
  into: number;
  /** 이번 레벨을 채우는 데 필요한 양 */
  need: number;
  /** into / need. 0~1. 화면의 EXP 막대가 이 값을 쓴다 */
  ratio: number;
}

/**
 * 누적 경험치 → 레벨과 그 안에서의 진행도.
 *
 * ★ 닫힌 식(제곱근) 대신 루프다. 제곱근은 경계값에서 부동소수 오차로 레벨이
 *   하나 어긋날 수 있는데, 그러면 "10점을 채웠는데 아직 1레벨" 이 된다.
 *   경험치는 판수에 비례해서 늘고 레벨은 그 제곱근으로 늘어나므로 루프는 짧다.
 */
export function levelFromExp(exp: number): LevelProgress {
  const safe = Number.isFinite(exp) ? Math.max(0, Math.floor(exp)) : 0;

  let level = 1;
  while (safe >= expAtLevel(level + 1)) level += 1;

  const into = safe - expAtLevel(level);
  const need = STEP * level;
  return { level, into, need, ratio: into / need };
}

/** 집계 세 값과 최근 목록을 화면이 쓰는 모양으로 합친다. */
export function toProfileStats(
  totals: { games: number; wins: number; exp: number },
  recent: RecentMatch[],
): ProfileStats {
  const { games, wins, exp } = totals;
  const progress = levelFromExp(exp);

  return {
    games,
    wins,
    win_rate: games > 0 ? wins / games : null,
    exp,
    level: progress.level,
    level_into: progress.into,
    level_need: progress.need,
    level_ratio: progress.ratio,
    recent,
  };
}
