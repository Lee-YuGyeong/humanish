/**
 * chat 봇 반응 배선의 순수 부분 — pending 봇 메시지 → /api/agent 요청 조립. 소유: B (SPEC §17.5)
 *
 * DB 왕복(regenerateBotChatReply)은 여기서 안 본다 — DB는 목으로 흉내 내지
 * 않는다(CLAUDE.md). 그건 로컬 실플레이와 supabase 검사의 몫이다.
 */
import { describe, expect, it } from 'vitest';
import { buildChatReplyJobs, capChatReply } from '@/lib/agent/chat-reply';
import { personaForSeat } from '@/lib/agent/persona';
import { DEFAULT_STYLE } from '@/lib/agent/disguise';

const BOTS = [
  { id: 'b1', seat: 2 },
  { id: 'b2', seat: 4 },
];

describe('buildChatReplyJobs — pending 봇 메시지마다 요청을 만든다', () => {
  it('pending 수만큼 만들고 player_id를 보존한다', () => {
    const jobs = buildChatReplyJobs(
      [
        { id: 'm1', player_id: 'b1' },
        { id: 'm2', player_id: 'b2' },
      ],
      BOTS,
      [],
      [],
    );
    expect(jobs.map((j) => j.player_id)).toEqual(['b1', 'b2']);
  });

  it('자리(seat)로 페르소나를 배정하고, 봇 목록에 없는 pending은 거른다', () => {
    const jobs = buildChatReplyJobs(
      [
        { id: 'm1', player_id: 'b2' },
        { id: 'm2', player_id: 'ghost' }, // 경합으로 봇 목록에서 빠진 행
      ],
      BOTS,
      [],
      [],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].context.persona.id).toBe(personaForSeat(4).id);
  });

  it('question 없이 chat 페이즈로 만든다 — buildMessages의 끼어들기 분기를 탄다', () => {
    const history = [{ speaker: '익명1', text: '아 배고프다' }];
    const jobs = buildChatReplyJobs([{ id: 'm1', player_id: 'b1' }], BOTS, history, []);
    expect(jobs[0].context.phase).toBe('chat');
    expect(jobs[0].context.question).toBeUndefined();
    expect(jobs[0].context.visibleHistory).toEqual(history);
    expect(jobs[0].context.suspicionOnMe).toBe(0.2);
  });

  it('공개된 사람 발화로 말투를 관측하고, 없으면 기본값이다', () => {
    const withTexts = buildChatReplyJobs([{ id: 'm1', player_id: 'b1' }], BOTS, [], ['짧게 ㅋㅋ']);
    expect(withTexts[0].context.styleProfile.markers).toContain('ㅋㅋ');

    const empty = buildChatReplyJobs([{ id: 'm1', player_id: 'b1' }], BOTS, [], []);
    expect(empty[0].context.styleProfile).toEqual(DEFAULT_STYLE);
  });
});

describe('capChatReply — 풀 문구 길이대에 맞춘 공백 경계 컷 (I1 잔여 신호 완화)', () => {
  it('상한 이하면 그대로 둔다 (양끝 공백만 정리)', () => {
    expect(capChatReply(' 아 배고파 ')).toBe('아 배고파');
  });

  it('상한을 넘으면 공백 경계에서 자른다 — 중간에서 끊긴 단어는 어색하다', () => {
    const long = '나 어제 야식으로 엽떡 시켰는데 진짜 맛있었음 완전 추천함';
    const cut = capChatReply(long);
    expect(cut.length).toBeLessThanOrEqual(25);
    expect(long.startsWith(cut)).toBe(true);
    expect(long[cut.length]).toBe(' '); // 단어를 반 토막 내지 않았다
  });

  it('공백이 없으면 상한에서 자른다', () => {
    expect(capChatReply('ㅋ'.repeat(40))).toBe('ㅋ'.repeat(25));
  });
});
