/**
 * 인물별 폴백 — 공용 세 줄("ㅇㅇ" · "아 잠깐만" · "나도 몰루")을 모두가 나눠 쓰면
 * 인물이 뭉개지고, 인물이 뭉개지면 자리도 같이 묶인다 (I1).
 *
 * 폴백은 드물지 않다 — 8b가 형식을 놓치거나 그물에 걸릴 때마다 나온다.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_STYLE } from '@/lib/agent/disguise';
import { FALLBACK_POOL, fallbackOutput, isFallbackLine, parseOutput } from '@/lib/agent/generate';
import { PERSONAS } from '@/lib/agent/persona';
import { WORLD_PERSONAS } from '@/lib/agent/world-persona';

const ALL = [...PERSONAS, ...WORLD_PERSONAS];

function ctxFor(persona: (typeof ALL)[number]) {
  return {
    persona,
    phase: 'chat' as const,
    visibleHistory: [],
    styleProfile: DEFAULT_STYLE,
    suspicionOnMe: 0.2,
  };
}

describe('인물마다 제 폴백을 쓴다', () => {
  it('모든 인물이 폴백을 갖고 있다 — 하나라도 비면 그 자리만 공용 풀로 말한다', () => {
    for (const p of ALL) {
      expect(p.fallbacks, p.id).toBeTruthy();
      expect(p.fallbacks!.length, p.id).toBeGreaterThan(1);
    }
  });

  it('폴백이 공용 풀과 겹치지 않는다 — 겹치면 그 줄만 다시 모두의 말이 된다', () => {
    for (const p of ALL) {
      for (const line of p.fallbacks ?? []) {
        expect(FALLBACK_POOL, `${p.id}: ${line}`).not.toContain(line);
      }
    }
  });

  it('인물끼리도 폴백이 겹치지 않는다 — 두 자리가 같은 말을 하면 묶인다', () => {
    for (const group of [PERSONAS, WORLD_PERSONAS]) {
      const seen = new Map<string, string>();
      for (const p of group) {
        for (const line of p.fallbacks ?? []) {
          expect(seen.get(line), `${line}: ${seen.get(line)} vs ${p.id}`).toBeUndefined();
          seen.set(line, p.id);
        }
      }
    }
  });

  it('폴백이 그 인물의 어체를 지킨다', () => {
    const polite = WORLD_PERSONAS.find((p) => p.id === 'world-polite')!;
    for (const line of polite.fallbacks!) expect(line, line).toMatch(/(요|죠|니다)/);

    // 마침표를 찍는 인물은 폴백도 문장을 맺는다
    const period = WORLD_PERSONAS.find((p) => p.id === 'world-period')!;
    for (const line of period.fallbacks!) expect(line, line).toMatch(/\.$/);
  });

  it('폴백이 그 인물이 안 쓰기로 한 부호를 쓰지 않는다', () => {
    for (const p of ALL) {
      for (const ch of p.avoidPunct ?? []) {
        for (const line of p.fallbacks ?? []) {
          expect(line.includes(ch), `${p.id} "${line}"에 ${ch}`).toBe(false);
        }
      }
    }
  });
});

describe('폴백이 실제로 그 인물 것으로 나간다', () => {
  it('빈 응답이면 그 인물의 폴백이 나온다', () => {
    for (const p of ALL) {
      const out = parseOutput('{"messages":[]}', ctxFor(p));
      expect(p.fallbacks, `${p.id}: ${out.messages[0]}`).toContain(out.messages[0]);
    }
  });

  it('정체 자백은 그 인물의 폴백으로 바뀐다 — 공용 풀이 아니다', () => {
    const p = WORLD_PERSONAS.find((x) => x.id === 'world-period')!;
    const out = parseOutput('{"messages":["나는 인공지능이야"]}', ctxFor(p));
    expect(p.fallbacks).toContain(out.messages[0]);
  });

  it('fallbackOutput도 인물을 보면 그 인물 것을 쓴다', () => {
    const p = WORLD_PERSONAS.find((x) => x.id === 'world-jamo')!;
    expect(p.fallbacks).toContain(fallbackOutput(ctxFor(p), '시간 초과').messages[0]);
  });

  it('인물을 모르면 공용 풀 — route의 catch 같은 자리다', () => {
    expect(FALLBACK_POOL).toContain(fallbackOutput(undefined, '알 수 없음').messages[0]);
  });
});

describe('isFallbackLine — 공용 풀만 보면 그물이 샌다', () => {
  it('인물별 폴백도 폴백으로 알아본다', () => {
    const p = WORLD_PERSONAS.find((x) => x.id === 'world-polite')!;
    const line = p.fallbacks![0];
    expect(isFallbackLine(line, p)).toBe(true);
    // 인물을 안 넘기면 못 잡는다 — 부르는 쪽이 인물을 같이 줘야 하는 이유다
    expect(isFallbackLine(line)).toBe(false);
  });

  it('공용 풀은 인물과 무관하게 잡는다', () => {
    for (const line of FALLBACK_POOL) expect(isFallbackLine(line)).toBe(true);
  });

  it('평범한 발화는 폴백이 아니다', () => {
    expect(isFallbackLine('대전쪽에 살고 있어')).toBe(false);
  });
});

/*
 * 접객 말투 — 신고된 발화: "안녕하세요, 즐겁게 놀러와서 감사합니다."
 * 어체는 맞았고 **입장**이 틀렸다. 놀러 온 사람이 손님을 맞이하고 있다.
 */
describe('접객 말투는 폴백으로 바뀐다 — 정체 자백과 같은 취급', () => {
  const anyPersona = WORLD_PERSONAS[0];

  it('신고된 그 문장이 걸린다', () => {
    const out = parseOutput(
      JSON.stringify({ messages: ['안녕하세요, 즐겁게 놀러와서 감사합니다'] }),
      ctxFor(anyPersona),
    );
    expect(out.messages[0]).not.toContain('감사');
    expect(isFallbackLine(out.messages[0], anyPersona)).toBe(true);
  });

  it('가게 주인 말투를 걷는다', () => {
    for (const line of ['환영합니다', '즐거운 시간 되세요', '무엇을 도와드릴까요', '잘 부탁드립니다']) {
      const out = parseOutput(JSON.stringify({ messages: [line] }), ctxFor(anyPersona));
      expect(isFallbackLine(out.messages[0], anyPersona), line).toBe(true);
    }
  });

  /*
   * ★ "어서 와"도 막는다. 한때 "어서 오세요"만 막고 반말 쪽은 "어서 와"로 바꿔서
   *   통과시켰는데, 그건 고친 게 아니라 옮긴 것이었다 — 반말 옷을 입었을 뿐
   *   맞이하는 입장은 그대로다. 친구 집에 가면 **주인이** "어서 와"라고 한다.
   */
  it('맞이하는 말은 반말이어도 막는다 — 옷만 갈아입은 것이다', () => {
    for (const line of ['어서 와', '어서 오세요', '어서 왔어', '편하게 계세요']) {
      const out = parseOutput(JSON.stringify({ messages: [line] }), ctxFor(anyPersona));
      expect(isFallbackLine(out.messages[0], anyPersona), line).toBe(true);
    }
  });

  it('접객이 화제인 건 막지 않는다 — 카페 알바가 손님 얘기를 할 수 있다', () => {
    const cafe = PERSONAS.find((p) => p.name === '하늘')!;
    const out = parseOutput(JSON.stringify({ messages: ['오늘 손님 진짜 많았어'] }), ctxFor(cafe));
    expect(out.messages[0]).toContain('손님');
  });
});
