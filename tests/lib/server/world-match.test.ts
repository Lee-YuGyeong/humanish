/**
 * 월드 판 → 전적 행 (lib/server/match.ts 의 buildWorldMatchRows).
 *
 * §18.4의 진영 승패가 그대로 won 이 되고, 점수는 §15-2-결정 주석의
 * "이긴 판 3 · 진 판 1" 이다. DB 는 여기서 흉내 내지 않는다 — 제약(role check ·
 * humans >= 2)이 실제로 무는지는 supabase/test.sh 가 진짜 Postgres 에 물어본다.
 */
import { describe, expect, it } from 'vitest';

import { buildWorldMatchRows } from '@/lib/server/match';

const MATCH = '99999999-0000-0000-0000-000000000001';

const 시민 = (userId: string | null) => ({ userId, role: 'citizen' as const });
const 연기자 = (userId: string | null) => ({ userId, role: 'actor' as const });

describe('진영 승패가 그대로 won 이 된다 (§18.4)', () => {
  it('시민 승 — 시민만 이긴 판이다', () => {
    const rows = buildWorldMatchRows(MATCH, 'citizen', [시민('u1'), 시민('u2'), 연기자('u3')]);
    expect(rows.map((r) => [r.role, r.won])).toEqual([
      ['citizen', true],
      ['citizen', true],
      ['actor', false],
    ]);
  });

  it('연기자 승 — 연기자만 이긴 판이다', () => {
    const rows = buildWorldMatchRows(MATCH, 'actor', [시민('u1'), 시민('u2'), 연기자('u3')]);
    expect(rows.map((r) => [r.role, r.won])).toEqual([
      ['citizen', false],
      ['citizen', false],
      ['actor', true],
    ]);
  });

  it('AI 승 — 사람은 전부 진 판이다 (부결·지목 없음·시민 처형이 다 여기로 온다)', () => {
    const rows = buildWorldMatchRows(MATCH, 'ai', [시민('u1'), 시민('u2'), 연기자('u3')]);
    expect(rows.every((r) => !r.won)).toBe(true);
  });
});

describe('점수는 이긴 판 3 · 진 판 1 이다 (§15-2-결정 주석)', () => {
  it('★ 진 판에도 1을 준다 — 참가를 세지 않으면 계속 지는 사람의 레벨이 영영 안 오른다', () => {
    const rows = buildWorldMatchRows(MATCH, 'citizen', [시민('u1'), 연기자('u2')]);
    expect(rows.find((r) => r.won)?.score).toBe(3);
    expect(rows.find((r) => !r.won)?.score).toBe(1);
  });
});

describe('사람 2명 미만 판은 적지 않는다 (부정 유인 차단 — 2D 와 같은 규칙)', () => {
  it('혼자 판 → 빈 배열', () => {
    expect(buildWorldMatchRows(MATCH, 'citizen', [시민('u1')])).toEqual([]);
  });

  it('전원 봇 판(사람 0) → 빈 배열', () => {
    expect(buildWorldMatchRows(MATCH, 'ai', [])).toEqual([]);
  });
});

describe('계정 없는 좌석', () => {
  it('행에서는 빠지지만 humans 분모에는 남는다', () => {
    // 로그인 없이 들어온 사람과 둘이 한 판 — 적히는 건 한 줄이어도 2인 판이다.
    // 분모가 줄면 이 판이 "혼자 판"으로 접혀 통째로 사라진다.
    const rows = buildWorldMatchRows(MATCH, 'citizen', [시민('u1'), 시민(null)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].humans).toBe(2);
  });
});

describe('전적 키', () => {
  it('room_id 자리에 판 id(matchId)가 들어간다 — rematch 판마다 한 번씩 적히는 근거다', () => {
    const rows = buildWorldMatchRows(MATCH, 'citizen', [시민('u1'), 시민('u2')]);
    expect(rows.every((r) => r.room_id === MATCH)).toBe(true);
  });
});
