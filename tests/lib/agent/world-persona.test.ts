/**
 * 월드(라운지) 페르소나 — 게임 어휘 격리와 자리 배정. 소유: B
 *
 * "진짜 사람 같은가"는 여기서 못 잰다 — 그건 /world 실플레이의 몫.
 * 여기서 재는 것은 구조다: 게임 문구 오염 없음 · 말버릇 배타성 · 자리 매핑.
 */
import { describe, expect, it } from 'vitest';
import { WORLD_PERSONAS, worldPersonaForSeat } from '@/lib/agent/world-persona';

describe('WORLD_PERSONAS — 라운지 인물 4명', () => {
  it('최소 4종이고 id가 겹치지 않는다', () => {
    expect(WORLD_PERSONAS.length).toBeGreaterThanOrEqual(4);
    expect(new Set(WORLD_PERSONAS.map((p) => p.id)).size).toBe(WORLD_PERSONAS.length);
  });

  it('게임 어휘가 없다 — "게임 중이 아니다" 같은 부정문도 없다 (무대는 setting이 깐다)', () => {
    for (const p of WORLD_PERSONAS) {
      for (const word of ['게임', '투표', '의심', '봇', '스파이']) {
        expect(p.system, `${p.id}에 "${word}"`).not.toContain(word);
      }
    }
  });

  it('말버릇이 서로 배타적이다 — ㅋㅋ만 쓰는 인물과 ㅋㅋ를 금지한 인물이 공존한다', () => {
    // 같은 모델이 여러 명을 연기하면 그냥 두면 서로 닮는다 — 금칙이 그 수렴을 막는다
    const easy = WORLD_PERSONAS.find((p) => p.id === 'world-easy');
    const warm = WORLD_PERSONAS.find((p) => p.id === 'world-warm');
    expect(easy?.system).toContain('ㅋㅋ만 쓴다');
    expect(warm?.system).toContain('절대 안 쓰는 것: ㅋㅋ');
  });

  it('인물마다 이름이 있다 — 물어보면 댈 이름이 있어야 한다', () => {
    // 이름을 **먼저** 말하지 않는 규칙은 generate.ts의 CONDUCT_RULES가 얹는다.
    // 여기서 재는 건 "댈 이름이 있는가"뿐이다.
    for (const p of WORLD_PERSONAS) {
      expect(p.system, `${p.id}에 이름이 없다`).toMatch(/너는 \d+살 "[^"]+"(다|이다)\./);
    }
  });

  it('지문이 겹치지 않는다 — 초성체·마침표·존댓말은 각각 한 명뿐이다', () => {
    // 같은 지문을 둘이 나눠 가지면 화면에서 그 둘이 안 갈린다. 8b에서 실제로 겹친다.
    const owns = (re: RegExp) => WORLD_PERSONAS.filter((p) => re.test(p.system)).length;
    expect(owns(/초성체를 주로 쓴다/), '초성체를 주력으로 쓰는 인물').toBe(1);
    expect(owns(/마침표를 찍는다/), '마침표를 찍는 인물').toBe(1);
    expect(owns(/처음부터 끝까지 존댓말이다/), '끝까지 존댓말인 인물').toBe(1);
  });

  it('웃음 길이의 폭도 인물마다 다르다 — 둘 다 ㅋㅋ면 길이로도 안 갈린다', () => {
    const easy = WORLD_PERSONAS.find((p) => p.id === 'world-easy');
    const warm = WORLD_PERSONAS.find((p) => p.id === 'world-warm');
    expect(easy?.laugh?.ch).toBe('ㅋ');
    expect(warm?.laugh?.ch).toBe('ㅎ');
    expect(easy?.laugh?.max).not.toBe(warm?.laugh?.max);
  });

  it('laugh는 그 인물이 실제로 쓰는 글자다 — 금지해 둔 웃음에 폭을 주지 않는다', () => {
    // 여기가 어긋나면 "ㅋㅋ 안 쓰는 인물"의 ㅋㅋ가 길어진다 — 지문 표가 통째로 무너진다.
    for (const p of WORLD_PERSONAS) {
      if (!p.laugh) continue;
      const banned = p.system.match(/절대 안 쓰는 것: (.*)/)?.[1] ?? '';
      expect(banned, `${p.id}가 금지한 글자에 laugh가 걸렸다`).not.toContain(p.laugh.ch);
      expect(p.laugh.base, p.id).toBeGreaterThanOrEqual(1);
      expect(p.laugh.max, p.id).toBeGreaterThanOrEqual(p.laugh.base);
    }
  });

  it('name이 system 속 이름과 같다 — 어긋나면 자기소개 그물이 헛돈다', () => {
    for (const p of WORLD_PERSONAS) expect(p.system, p.id).toContain(`"${p.name}"`);
  });

  it('avoidPunct는 인물이 "절대 안 쓰는 것"에 적어 둔 부호뿐이다', () => {
    const word: Record<string, string> = { '!': '느낌표', '~': '물결', '.': '마침표' };
    for (const p of WORLD_PERSONAS) {
      for (const ch of p.avoidPunct ?? []) expect(p.system, `${p.id}: ${ch}`).toContain(word[ch]);
    }
  });

  it('worldPersonaForSeat — 연속한 자리 4개가 전부 다른 인물이다', () => {
    const ids = [1, 2, 3, 4].map((s) => worldPersonaForSeat(s).id);
    expect(new Set(ids).size).toBe(4);
  });

  it('worldPersonaForSeat — 자리가 0이거나 음수여도 안전하다', () => {
    for (const seat of [0, -1, -7, 100]) {
      expect(WORLD_PERSONAS).toContain(worldPersonaForSeat(seat));
    }
  });
});
