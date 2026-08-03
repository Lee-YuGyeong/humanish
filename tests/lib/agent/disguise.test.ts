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
  stretchLaugh,
  stripAvoidedPunct,
  toCasual,
  toPolite,
  typingDelayMs,
  enforceSpeech,
  type LaughStyle,
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

describe('stretchLaugh — 웃음 길이는 인물을 따라 흔들린다', () => {
  /*
   * 8b는 "웃음은 ㅋㅋ만 쓴다"를 **글자 수까지** 지켜서 매번 정확히 두 글자로 웃는다.
   * 사람은 ㅋ 하나로 툭 던지기도 하고 ㅋㅋㅋㅋㅋ까지 늘리기도 한다 — 늘 같은 길이로
   * 웃는 자리는 세어 보면 드러난다 (I1). 폭은 인물마다 다르다.
   */
  const easy: LaughStyle = { ch: 'ㅋ', base: 2, max: 5 };

  it('웃음을 안 쓰는 인물(laugh 없음)은 손대지 않는다', () => {
    expect(stretchLaugh('ㅋㅋ 뭐야', undefined, feed([0]))).toBe('ㅋㅋ 뭐야');
  });

  it('웃음이 없는 발화는 그대로다 — 없던 웃음을 만들지 않는다', () => {
    expect(stretchLaugh('밥 먹었어', easy, feed([0, 0]))).toBe('밥 먹었어');
  });

  it('인물이 안 쓰는 글자는 건드리지 않는다 — ㅋ 인물에게 ㅎㅎ는 남의 지문이다', () => {
    expect(stretchLaugh('ㅎㅎ 그러네', easy, feed([0, 0]))).toBe('ㅎㅎ 그러네');
  });

  it('가끔 한 글자로 툭 던진다', () => {
    expect(stretchLaugh('ㅋㅋ 뭐야', easy, feed([0, 0]))).toBe('ㅋ 뭐야');
  });

  it('대부분은 평소 길이 그대로다 — 매번 흔들리면 그것도 지문이다', () => {
    expect(stretchLaugh('ㅋㅋ 뭐야', easy, feed([0, 0.5]))).toBe('ㅋㅋ 뭐야');
  });

  it('신나면 그 인물의 max까지 늘어난다', () => {
    expect(stretchLaugh('ㅋㅋ 뭐야', easy, feed([0, 0.9, 0.99]))).toBe('ㅋㅋㅋㅋㅋ 뭐야');
  });

  it('base와 max가 같은 인물은 늘어나지 않는다 — 폭이 좁은 게 그 인물의 성격이다', () => {
    const flat: LaughStyle = { ch: 'ㅎ', base: 2, max: 2 };
    expect(stretchLaugh('ㅎㅎ 그러네', flat, feed([0, 0.99]))).toBe('ㅎㅎ 그러네');
  });

  it('웃음 말고는 한 글자도 안 바뀐다 — 이게 계약이다', () => {
    const src = 'ㅋㅋ 아까 그거 봤어? ㅋㅋ';
    const strip = (t: string) => t.replace(/ㅋ/g, '');
    for (let seed = 0; seed < 300; seed += 1) {
      const rand = () => ((seed * 7919 + 104729) % 65521) / 65521;
      expect(strip(stretchLaugh(src, easy, rand)), `seed ${seed}`).toBe(strip(src));
    }
  });

  it('한 발화에 하나만 흔든다 — 두 번 흔들면 사람이 아니라 고장 난 것이다', () => {
    const src = 'ㅋㅋ 아까 그거 봤어 ㅋㅋ';
    const runs = (t: string) => (t.match(/ㅋ+/g) ?? []).map((r) => r.length);
    const before = runs(src);
    for (let seed = 0; seed < 300; seed += 1) {
      const rand = () => ((seed * 9301 + 49297) % 233280) / 233280;
      const after = runs(stretchLaugh(src, easy, rand));
      expect(after.length, `seed ${seed}`).toBe(before.length);
      expect(after.filter((n, i) => n !== before[i]).length, `seed ${seed}`).toBeLessThanOrEqual(1);
    }
  });
});

describe('stripAvoidedPunct — 인물이 안 쓰는 부호는 걷어낸다', () => {
  /*
   * 실측: 느낌표를 금지한 선영이 "안녕하세요!"로 인사했다. 8b는 인사·감탄 자리에서
   * 금칙을 놓친다. 부호 하나가 새면 그 인물이 다른 인물과 안 갈린다 (지문 표).
   */
  it('금지 목록이 없으면 그대로다', () => {
    expect(stripAvoidedPunct('안녕하세요!', undefined)).toBe('안녕하세요!');
    expect(stripAvoidedPunct('안녕하세요!', [])).toBe('안녕하세요!');
  });

  it('느낌표를 금지한 인물의 인사에서 느낌표가 빠진다', () => {
    expect(stripAvoidedPunct('안녕하세요!', ['!'])).toBe('안녕하세요');
  });

  it('여러 부호를 한 번에 걷는다', () => {
    expect(stripAvoidedPunct('그러네~ 진짜!', ['!', '~'])).toBe('그러네 진짜');
  });

  it('부호를 뺀 자리의 겹공백을 정리한다 — 빈칸 두 개는 사람이 안 친다', () => {
    expect(stripAvoidedPunct('아 ! 그래', ['!'])).toBe('아 그래');
  });

  it('한글은 한 글자도 안 건드린다 — 자모(ㅋㅋ)는 여기서 지우지 않는다', () => {
    expect(stripAvoidedPunct('내일 봐요 ㅋㅋ', ['!', '~', '.'])).toBe('내일 봐요 ㅋㅋ');
  });
});

/*
 * 어체 그물 — 프롬프트 두 겹으로 막다 뚫린 자리다 (disguise.ts의 상자).
 * 실측 문장을 그대로 검사에 옮긴다. 여기 있는 예는 전부 8b가 실제로 낸 것이다.
 */
describe('toCasual — 반말 인물이 존댓말로 답한 걸 되돌린다', () => {
  it('실측: 질문을 받자 반말 인물들이 한꺼번에 존댓말로 답했다', () => {
    expect(toCasual('창고에서 살고 있어요')).toBe('창고에서 살고 있어');
    expect(toCasual('평일은 대학교에 다니고 주말에 집에 있어요')).toBe(
      '평일은 대학교에 다니고 주말에 집에 있어',
    );
    expect(toCasual('아주 멀리서 살고 있어요. 서울입니다')).toBe('아주 멀리서 살고 있어. 서울이야');
  });

  it('1인칭만 존대로 남는 게 제일 흔하다 — 사용자가 처음 신고한 문장', () => {
    expect(toCasual('뭐야? 저한테 뭘 묻고 있어?')).toBe('뭐야? 나한테 뭘 묻고 있어?');
    expect(toCasual('제가 전북 익산에 살고 있어요.')).toBe('내가 전북 익산에 살고 있어.');
  });

  it('지정사는 "요"를 떼기 전에 본다 — 안 그러면 "이에요"가 "이에"로 남는다', () => {
    expect(toCasual('사람이에요')).toBe('사람이야');
    expect(toCasual('저는 여기 처음이에요')).toBe('나는 여기 처음이야');
  });

  it('어미가 아닌 "요"는 건드리지 않는다 — "필요"가 "필"이 되면 안 된다', () => {
    expect(toCasual('그거 필요')).toBe('그거 필요');
    expect(toCasual('별로 안 중요')).toBe('별로 안 중요');
  });

  it('이미 반말인 문장은 그대로 둔다', () => {
    expect(toCasual('뭔 소리야 나 사람인데')).toBe('뭔 소리야 나 사람인데');
    expect(toCasual('ㅇㅇ 아까 먹음')).toBe('ㅇㅇ 아까 먹음');
  });
});

describe('toPolite — 존댓말 인물이 반말로 답한 걸 올린다', () => {
  it('실측: 유일한 존댓말 인물이 반말로 답했다', () => {
    expect(toPolite('나는 사람이야')).toBe('저는 사람이에요');
    expect(toPolite('서울 강북에 살고 있어')).toBe('서울 강북에 살고 있어요');
  });

  it('어미가 아닌 자리는 건드리지 않는다 — 틀리면 없는 말이 된다', () => {
    expect(toPolite('누가 그랬는지 몰라')).toBe('누가 그랬는지 몰라요');
    expect(toPolite('사람 많다')).toBe('사람 많다'); // '다'는 손대지 않는다
  });
});

describe('enforceSpeech — 인물의 어체 쪽으로만 민다', () => {
  it('speech가 없으면 반말이다 — 인물 대부분이 반말이라 존댓말만 적는다', () => {
    expect(enforceSpeech('살고 있어요', undefined)).toBe('살고 있어');
    expect(enforceSpeech('살고 있어요', 'casual')).toBe('살고 있어');
  });

  it('존댓말 인물은 반대로 민다', () => {
    expect(enforceSpeech('살고 있어', 'polite')).toBe('살고 있어요');
  });
});

describe('toCasual — 인사말은 하세요체라 어미 규칙으로 안 잡힌다', () => {
  /*
   * 종결 '요' 떼기는 '세'를 건드리지 않는다 ("하세요"→"하세"가 되니까).
   * 그런데 인사말은 거의 전부 하세요체라, 그물에 인사 크기의 구멍이 있었다.
   * 아래는 전부 반말 인물이 인사 자리에서 실제로 낸 문장이다.
   */
  it('실측: 반말 인물이 인사에서만 존댓말로 튀었다', () => {
    expect(toCasual('안녕하세요 쫀쫀해')).toBe('안녕 쫀쫀해');
    expect(toCasual('안녕하셨어?')).toBe('안녕?');
  });

  /*
   * ★ "어서 오세요"는 여기서 안 바꾼다. 한때 "어서 와"로 내렸는데, 그건 고친 게
   *   아니라 **옮긴 것**이었다 — 반말 옷을 입었을 뿐 맞이하는 입장은 그대로다.
   *   맞이하는 말은 generate.ts 의 SERVICE_TALK 가 통째로 걷어낸다.
   */
  it('맞이하는 말은 어체만 바꿔 통과시키지 않는다', () => {
    expect(toCasual('어서 오세요')).toBe('어서 오세요');
  });

  it('8b가 내는 인사 변형을 전부 "안녕"으로 모은다 (실측된 모양들)', () => {
    for (const s of ['안녕하세요', '안녕하세용', '안녕하세여', '안녕하세', '안녕해요', '안녕해']) {
      expect(toCasual(s), s).toBe('안녕');
    }
  });

  it('긴 것부터 본다 — "하세"가 앞이면 "하세요"가 "안녕요"가 된다', () => {
    expect(toCasual('안녕하세요')).not.toBe('안녕요');
  });

  it('반갑습니다·고맙습니다도 내린다', () => {
    expect(toCasual('반갑습니다')).toBe('반가워');
    expect(toCasual('고맙습니다')).toBe('고마워');
  });

  it('이미 반말인 인사는 그대로 둔다', () => {
    expect(toCasual('안녕')).toBe('안녕');
    expect(toCasual('어서 와')).toBe('어서 와');
    expect(toCasual('반가워')).toBe('반가워');
  });
});

describe('toPolite — 존댓말 인물이 만든 없는 말', () => {
  it('"안녕요"는 없는 말이다 — 반말 인사에 요만 붙인 것', () => {
    expect(toPolite('안녕요')).toBe('안녕하세요');
    expect(toPolite('저도 안녕요')).toBe('저도 안녕하세요');
  });

});
