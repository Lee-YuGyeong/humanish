/**
 * 현실 앵커 — "지금 몇 시야"는 심문자 단골이다.
 *
 * 안 알려 주면 봇이 지어내고, **봇마다 따로** 지어낸다. 같은 방에서 "새벽 3시"와
 * "오후 2시"가 같이 나오는 순간 한 명이 아니라 둘 다 걸린다 (I1).
 */
import { describe, expect, it } from 'vitest';
import { describeNow } from '@/lib/agent/clock';

/** 2026-08-03(월) 12:34 KST = 03:34Z */
const MON_NOON = '2026-08-03T03:34:00.000Z';

describe('describeNow — KST로 읽는다', () => {
  it('UTC가 아니라 한국 시각으로 말한다', () => {
    expect(describeNow(MON_NOON)).toBe('8월 3일 월요일, 낮 12시 30분쯤');
  });

  /*
   * 실행 환경의 로컬 시간대가 무엇이든 같은 값이어야 한다. 로컬은 KST, 배포는
   * workerd(UTC)라 — 여기가 흔들리면 배포본만 9시간 어긋난 시각을 말한다.
   */
  it('실행 환경의 시간대를 타지 않는다 — 오프셋을 손으로 더한다', () => {
    // 같은 순간을 다른 표기로 줘도 결과가 같다
    expect(describeNow('2026-08-03T03:34:00Z')).toBe(describeNow('2026-08-03T12:34:00+09:00'));
  });

  it('자정을 넘기면 날짜와 요일이 같이 넘어간다', () => {
    // 8/3(월) 23:30Z = 8/4(화) 08:30 KST
    expect(describeNow('2026-08-03T23:30:00Z')).toBe('8월 4일 화요일, 아침 8시 30분쯤');
  });
});

describe('사람이 말하는 모양으로 준다', () => {
  it('24시간제로 말하지 않는다 — "14시"가 아니라 "오후 2시"', () => {
    expect(describeNow('2026-08-03T05:00:00Z')).toBe('8월 3일 월요일, 오후 2시쯤');
  });

  it('시간대 이름이 한국어 감각을 따른다', () => {
    const at = (utcHour: number) =>
      describeNow(`2026-08-03T${String(utcHour).padStart(2, '0')}:00:00Z`)?.split(', ')[1] ?? '';
    expect(at(18)).toContain('새벽'); // 03시
    expect(at(23)).toContain('아침'); // 08시
    expect(at(3)).toContain('낮'); //   12시
    expect(at(7)).toContain('오후'); // 16시
    expect(at(10)).toContain('저녁'); // 19시
    expect(at(13)).toContain('밤'); //  22시
  });

  /*
   * 5분으로 뭉개는 건 두 가지를 같이 해결한다 —
   * 사람은 "9시 53분"이라고 안 하고, 같은 방의 두 봇이 몇 초 차이로 답해도 같은 값이 된다.
   */
  it('분을 5분 단위로 내린다 — 같은 방의 두 봇이 같은 값을 말한다', () => {
    const a = describeNow('2026-08-03T03:31:10.000Z');
    const b = describeNow('2026-08-03T03:34:59.000Z');
    expect(a).toBe(b);
    expect(a).toContain('30분');
  });

  it('올림이 아니라 내림이다 — 59분에서 시·날짜가 넘어가면 안 된다', () => {
    expect(describeNow('2026-08-03T14:59:00Z')).toBe('8월 3일 월요일, 밤 11시 55분쯤');
  });

  it('정각이면 분을 말하지 않는다', () => {
    expect(describeNow('2026-08-03T03:02:00Z')).toBe('8월 3일 월요일, 낮 12시쯤');
  });

  it('자정과 정오는 0시가 아니라 12시다', () => {
    expect(describeNow('2026-08-03T15:00:00Z')).toContain('12시'); // 00:00 KST
    expect(describeNow('2026-08-03T03:00:00Z')).toContain('12시'); // 12:00 KST
  });
});

describe('못 읽는 값', () => {
  it('null을 준다 — 그러면 프롬프트에 블록이 안 붙는다', () => {
    expect(describeNow('어제')).toBeNull();
    expect(describeNow('')).toBeNull();
  });
});
