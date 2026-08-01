/**
 * 전적을 숫자로 바꾸는 곡선 (lib/server/stats.ts). SPEC §15-2-결정.
 *
 * DB는 흉내 내지 않는다. 여기서 보는 것은 **순수 계산**뿐이고, 표와 정책
 * (match_results · match_stats · RLS)은 supabase/test.sh 가 진짜 Postgres에 물어본다.
 */
import { describe, expect, it } from 'vitest';

import { levelFromExp, toProfileStats } from '@/lib/server/stats';

describe('레벨 곡선', () => {
  it('경험치가 0이어도 1레벨이다 — 0레벨은 없다', () => {
    expect(levelFromExp(0)).toEqual({ level: 1, into: 0, need: 10, ratio: 0 });
  });

  // 레벨 L → L+1 에 10×L 이 든다. 누적 문턱은 0 · 10 · 30 · 60 · 100 …
  it.each([
    [9, 1],
    [10, 2],
    [29, 2],
    [30, 3],
    [59, 3],
    [60, 4],
    [100, 5],
  ])('누적 %i점이면 %i레벨', (exp, level) => {
    expect(levelFromExp(exp).level).toBe(level);
  });

  it('문턱을 딱 채운 순간 다음 레벨로 넘어간다 (경계에서 하나 어긋나지 않는다)', () => {
    // 제곱근 닫힌 식으로 짰다가 부동소수 오차로 여기서 한 칸 밀린 적이 있다.
    for (let level = 1; level <= 30; level += 1) {
      const threshold = (10 * level * (level - 1)) / 2;
      expect(levelFromExp(threshold).level).toBe(level);
      if (threshold > 0) expect(levelFromExp(threshold - 1).level).toBe(level - 1);
    }
  });

  it('레벨 안에서의 진행도는 0~1이다', () => {
    // 3레벨(30)에서 4레벨(60)까지는 30점. 45점이면 딱 절반이다.
    expect(levelFromExp(45)).toEqual({ level: 3, into: 15, need: 30, ratio: 0.5 });
  });

  it('음수·소수·NaN 이 와도 무너지지 않는다', () => {
    expect(levelFromExp(-100).level).toBe(1);
    expect(levelFromExp(10.9).level).toBe(2);
    expect(levelFromExp(Number.NaN).level).toBe(1);
  });
});

describe('전적 요약', () => {
  it('한 판도 없으면 승률이 null 이다 — 0% 가 아니다', () => {
    // 0% 로 접으면 아직 안 해 본 사람과 다 진 사람이 화면에서 같아진다.
    const stats = toProfileStats({ games: 0, wins: 0, exp: 0 }, []);
    expect(stats.win_rate).toBeNull();
    expect(stats.level).toBe(1);
  });

  it('다 진 사람은 승률 0 이다 — null 과 구분된다', () => {
    expect(toProfileStats({ games: 4, wins: 0, exp: 0 }, []).win_rate).toBe(0);
  });

  it('승률과 레벨을 집계에서 만든다', () => {
    const stats = toProfileStats({ games: 8, wins: 5, exp: 30 }, []);
    expect(stats.win_rate).toBe(5 / 8);
    expect(stats.level).toBe(3);
    expect(stats.exp).toBe(30);
  });

  it('최근 목록은 받은 그대로 넘긴다 (순서를 다시 만지지 않는다)', () => {
    // 정렬은 DB의 created_at desc 가 한다. 여기서 또 정렬하면 두 군데가 갈린다.
    const recent = [
      { room_id: 'b', role: 'spy' as const, won: true, score: 4, created_at: '2026-08-01T10:00:00Z' },
      { room_id: 'a', role: 'citizen' as const, won: false, score: 0, created_at: '2026-07-31T10:00:00Z' },
    ];
    expect(toProfileStats({ games: 2, wins: 1, exp: 4 }, recent).recent).toEqual(recent);
  });
});
