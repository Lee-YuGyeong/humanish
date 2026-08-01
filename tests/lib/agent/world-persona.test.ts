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
