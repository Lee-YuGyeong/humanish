/**
 * 말투 관측 · 타이핑 지연. 소유: B (SPEC §2, §9)
 *
 * 여기 함수들은 순수(랜덤 없음)라서 그대로 검사된다. 지터는 generate가 얹으므로
 * 지터의 범위는 generate.test에서 본다.
 */
import { describe, expect, it } from 'vitest';
import {
  applyTypo,
  DEFAULT_STYLE,
  MAX_TYPING_MS,
  MIN_TYPING_MS,
  observeStyle,
  typingDelayMs,
} from '@/lib/agent/disguise';

/** 난수를 손으로 먹인다 — applyTypo가 rand를 인자로 받는 이유가 이거다 (파일 규약: 순수). */
function feed(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

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

describe('applyTypo — 오타는 띄어쓰기 붙이기 하나뿐이다', () => {
  /*
   * 모델한테 시키면 "스클린", "야요", "민준야" 처럼 **한국어가 서툰 사람**이 나온다
   * (8b 실측). 그렇다고 자판 인접키로 자모를 바꾸는 것도 물렀다 — 낱말 첫 글자를
   * 피하고 정정 줄까지 붙였는데도 "있오", "나더" 는 그냥 글이 깨진 것으로 읽혔다.
   * 띄어쓰기를 붙이는 건 흔하고, 무엇보다 **읽는 데 지장이 없다.**
   */
  const style = { ...DEFAULT_STYLE, typoRate: 1 }; // 상한(TYPO_MAX)으로 눌린다

  it('난수가 높으면 원문 그대로다 — 대부분의 발화는 안 틀린다', () => {
    expect(applyTypo('밥 먹었어', style, feed([0.99]))).toBe('밥 먹었어');
  });

  it('너무 짧은 발화는 건드리지 않는다', () => {
    expect(applyTypo('ㅇㅇ', style, feed([0]))).toBe('ㅇㅇ');
  });

  it('공백도 쌍시옷 받침도 없으면 손댈 데가 없다 — 원문 그대로 나간다', () => {
    expect(applyTypo('배고프다', style, feed([0, 0, 0]))).toBe('배고프다');
  });

  it('쌍시옷 받침을 흘린다 — "있어"를 "잇어"로', () => {
    // 공백이 없는 문장이라 후보가 받침 하나뿐이다
    expect(applyTypo('맛있어', style, feed([0, 0]))).toBe('맛잇어');
    expect(applyTypo('먹었는데', style, feed([0, 0]))).toBe('먹엇는데');
    expect(applyTypo('갔다왔어', style, feed([0, 0]))).toBe('갓다왔어');
  });

  it('받침을 흘려도 한글 한 글자다 — 자모가 흩어지지 않는다', () => {
    const src = '어제 갔었는데 진짜 맛있었어';
    for (let seed = 0; seed < 300; seed += 1) {
      const rand = () => ((seed * 6151 + 30011) % 32749) / 32749;
      const out = applyTypo(src, style, rand);
      expect(out, `seed ${seed}`).not.toMatch(/[ㄱ-ㅎㅏ-ㅣ]/);
      expect(out.length, `seed ${seed}`).toBeGreaterThanOrEqual(src.length - 1);
    }
  });

  it('한 발화에 최대 하나 — 두 번 붙으면 그냥 안 띄어 쓴 사람이 된다', () => {
    const src = '아까 스크린 봤는데 좀 이상하더라';
    const spaces = (t: string) => [...t].filter((c) => c === ' ').length;
    for (let seed = 0; seed < 300; seed += 1) {
      const rand = () => ((seed * 9301 + 49297) % 233280) / 233280;
      const out = applyTypo(src, style, rand);
      expect(spaces(src) - spaces(out), `seed ${seed}`).toBeLessThanOrEqual(1);
    }
  });

  it('바뀌는 건 공백 아니면 ㅆ받침뿐이다 — 다른 글자는 절대 안 건드린다', () => {
    /*
     * 이게 계약이다. 깨진 글자가 나올 길이 구조적으로 없다 —
     * 공백을 빼거나, ㅆ받침을 ㅅ으로 내리거나(코드포인트 -1) 둘 중 하나다.
     */
    const src = '아침에 도시락 싸서 먹었어';
    const loosen = (t: string) =>
      [...t.replace(/ /g, '')]
        .map((c) => {
          const cp = c.charCodeAt(0);
          const ssang = cp >= 0xac00 && cp <= 0xd7a3 && (cp - 0xac00) % 28 === 20;
          return ssang ? String.fromCharCode(cp - 1) : c;
        })
        .join('');
    for (let seed = 0; seed < 300; seed += 1) {
      const rand = () => ((seed * 7919 + 104729) % 65521) / 65521;
      const out = applyTypo(src, style, rand);
      expect(loosen(out), `seed ${seed}`).toBe(loosen(src));
    }
  });
});
