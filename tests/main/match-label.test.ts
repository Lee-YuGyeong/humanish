/**
 * 판 문구 · 경과 시간 (app/main/match-label.ts).
 *
 * 왼쪽 기둥의 「최근 게임」과 「기록」 탭이 **같은 것을 읽는다.** 여기가 그 하나다 —
 * 두 벌로 갈렸을 때 같은 판이 두 자리에서 다른 말로 불렸고, 그게 이 모듈이 생긴 이유다.
 */
import { describe, expect, it } from 'vitest';

import { MATCH_LABEL, ROLE_NAME, timeAgo } from '@/app/main/match-label';

describe('판 문구', () => {
  it("★ 'spy'(옛 2D)와 'actor'(월드)는 같은 말로 접힌다 — 지난 행을 고쳐 쓰지 않아서 둘 다 온다", () => {
    expect(ROLE_NAME.spy).toBe(ROLE_NAME.actor);
    expect(MATCH_LABEL.spy).toEqual(MATCH_LABEL.actor);
  });

  it('이긴 판과 진 판이 다른 말이다', () => {
    for (const role of ['citizen', 'spy', 'actor'] as const) {
      expect(MATCH_LABEL[role].won).not.toBe(MATCH_LABEL[role].lost);
    }
  });
});

describe('경과 시간', () => {
  const NOW = Date.UTC(2026, 7, 7, 12, 0, 0);
  const ago = (ms: number) => timeAgo(new Date(NOW - ms).toISOString(), NOW);

  it('분 · 시간 · 일로 접는다', () => {
    expect(ago(30_000)).toBe('방금');
    expect(ago(5 * 60_000)).toBe('5분 전');
    expect(ago(3 * 3600_000)).toBe('3시간 전');
    expect(ago(2 * 86_400_000)).toBe('2일 전');
  });

  it('★ 시계가 어긋나 미래로 나와도 "방금" 이다 — "-3분 전" 은 고장으로 보인다', () => {
    expect(ago(-3 * 60_000)).toBe('방금');
  });

  it('날짜가 깨져 있어도 무너지지 않는다', () => {
    expect(timeAgo('그런 시각 없음', NOW)).toBe('방금');
  });
});
