/**
 * 실전 배선의 순수 부분 — 봇 목록 → /api/agent 요청 조립. 소유: B (SPEC §17.5)
 *
 * DB 왕복(regenerateBotAnswers)은 여기서 안 본다 — DB는 목으로 흉내 내지
 * 않는다(CLAUDE.md). 그건 로컬 실플레이와 supabase 검사의 몫이다.
 */
import { describe, expect, it } from 'vitest';
import { buildPrefillJobs } from '@/lib/agent/prefill';
import { personaForSeat } from '@/lib/agent/persona';
import { DEFAULT_STYLE } from '@/lib/agent/disguise';

const BOTS = [
  { id: 'b1', seat: 2 },
  { id: 'b2', seat: 4 },
  { id: 'b3', seat: 5 },
];

describe('buildPrefillJobs — 봇마다 다른 페르소나로 요청을 만든다', () => {
  it('봇 수만큼 만들고 player_id를 보존한다', () => {
    const jobs = buildPrefillJobs(BOTS, 'question', '야식 뭐 먹어?', []);
    expect(jobs.map((j) => j.player_id)).toEqual(['b1', 'b2', 'b3']);
  });

  it('자리(seat)로 페르소나를 배정한다 — 봇끼리 성격이 갈려야 한다', () => {
    const jobs = buildPrefillJobs(BOTS, 'question', undefined, []);
    for (let i = 0; i < BOTS.length; i++) {
      expect(jobs[i].context.persona.id).toBe(personaForSeat(BOTS[i].seat).id);
    }
    // 자리가 다르면 페르소나도 다르다 (정원 8 ≤ 페르소나 4 × 2 순환)
    expect(new Set(jobs.map((j) => j.context.persona.id)).size).toBe(BOTS.length);
  });

  it('질문·페이즈가 컨텍스트에 실리고, 답이 안 보이는 페이즈라 기록은 비운다 (§13-4)', () => {
    const jobs = buildPrefillJobs(BOTS, 'target', '지목 질문이다', []);
    for (const j of jobs) {
      expect(j.context.phase).toBe('target');
      expect(j.context.question).toBe('지목 질문이다');
      expect(j.context.visibleHistory).toEqual([]);
      expect(j.context.suspicionOnMe).toBe(0.2);
    }
  });

  it('공개된 사람 발화로 말투를 관측하고, 없으면 기본값이다', () => {
    const withTexts = buildPrefillJobs(BOTS, 'question', 'q', ['짧게 ㅋㅋ', '나도 ㅋㅋ']);
    expect(withTexts[0].context.styleProfile.markers).toContain('ㅋㅋ');

    const empty = buildPrefillJobs(BOTS, 'question', 'q', []);
    expect(empty[0].context.styleProfile).toEqual(DEFAULT_STYLE);
  });
});
