/**
 * 말투 관측 · 타이핑 지연. 소유: B (SPEC §2, §9)
 *
 * 여기 함수들은 순수(랜덤 없음)라서 그대로 검사된다. 지터는 generate가 얹으므로
 * 지터의 범위는 generate.test에서 본다.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STYLE,
  MAX_TYPING_MS,
  MIN_TYPING_MS,
  observeStyle,
  typingDelayMs,
} from '@/lib/agent/disguise';

describe('observeStyle — 사람 말투 관측', () => {
  it('빈 방이면 기본값을 준다', () => {
    expect(observeStyle([])).toEqual(DEFAULT_STYLE);
  });

  it('평균 길이와 자주 쓰는 표현을 뽑는다', () => {
    const style = observeStyle(['나는 무조건 엽떡 ㅋㅋ', '헐 나도 ㅋㅋ', '음 고민되네']);
    expect(style.avgLength).toBeGreaterThan(0);
    expect(style.markers).toContain('ㅋㅋ');
  });

  it('초성체(ㄹㅇ)는 오타 빈도로 세지만 웃음(ㅋㅋ)·울음(ㅠㅠ)은 안 센다', () => {
    expect(observeStyle(['ㅋㅋㅋㅋ', 'ㅎㅎ 그니까', 'ㅠㅠ']).typoRate).toBe(0);
    expect(observeStyle(['ㄹㅇ 국밥']).typoRate).toBe(1);
  });

  it('typoRate는 0~1을 벗어나지 않는다', () => {
    const style = observeStyle(['ㄹㅇ', 'ㅇㅋ', 'ㄴㄴ']);
    expect(style.typoRate).toBeGreaterThanOrEqual(0);
    expect(style.typoRate).toBeLessThanOrEqual(1);
  });
});

describe('typingDelayMs — 즉답은 봇 신호다 (I1)', () => {
  it('빈 문자열도 최소 지연은 있다', () => {
    expect(typingDelayMs('')).toBe(MIN_TYPING_MS);
  });

  it('긴 글일수록 오래 걸린다', () => {
    expect(typingDelayMs('국밥 먹고 싶다 진짜로')).toBeGreaterThan(typingDelayMs('ㅇㅇ'));
  });

  it('아무리 길어도 페이즈 안에서 끝나는 상한이 있다 (SPEC §5)', () => {
    expect(typingDelayMs('가'.repeat(500))).toBe(MAX_TYPING_MS);
  });

  it('결정적이다 — 같은 입력이면 같은 지연', () => {
    expect(typingDelayMs('아 잠깐만')).toBe(typingDelayMs('아 잠깐만'));
  });
});
