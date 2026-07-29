/**
 * 타이핑 지연 · 말투 관측. 소유: B (SPEC §2)
 *
 * 지연은 setTimeout으로 기다리는 게 아니라 visible_at에 시각으로 박는다.
 * 서버 함수가 6초를 기다릴 수 없기 때문이다 (SPEC §5.3).
 *
 * 여기 함수는 전부 순수(랜덤 없음)로 둔다 — 지터는 쓰는 쪽(generate)이 얹는다.
 * 그래야 그대로 테스트된다.
 */

/** 관측된 인간 말투. 봇이 방 분위기에 맞추는 근거. */
export interface StyleProfile {
  /** 평균 글자 수. */
  avgLength: number;
  /** 자주 쓰인 종결·감탄 표현. */
  markers: string[];
  /** 오타 빈도 0~1. */
  typoRate: number;
}

/** 아무도 말 안 한 방의 기본값 — 짧고 건조한 한국어 채팅 평균치. */
export const DEFAULT_STYLE: StyleProfile = {
  avgLength: 12,
  markers: ['ㅋㅋ'],
  typoRate: 0.2,
};

const MARKER_CANDIDATES = ['ㅋㅋ', 'ㅎㅎ', 'ㅠㅠ', 'ㄹㅇ', ';;', '~', '...', '!', '?'] as const;

/** 사람 메시지에서 StyleProfile을 뽑는다. */
export function observeStyle(texts: string[]): StyleProfile {
  if (texts.length === 0) return DEFAULT_STYLE;

  const avgLength = Math.round(
    texts.reduce((sum, t) => sum + t.length, 0) / texts.length,
  );

  const markers = MARKER_CANDIDATES.map((m) => ({
    m,
    n: texts.filter((t) => t.includes(m)).length,
  }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 3)
    .map((x) => x.m);

  // 초성체(ㄹㅇ, ㅇㅋ 같은 자모 덩어리)를 오타·대충 침의 근사치로 센다.
  // 웃음(ㅋㅎ)과 울음(ㅠㅜ)은 오타가 아니므로 걷어내고 잰다.
  const typo =
    texts.filter((t) => /[ㄱ-ㅎㅏ-ㅣ]{2,}/.test(t.replace(/[ㅋㅎㅠㅜ]/g, ''))).length /
    texts.length;

  return { avgLength, markers, typoRate: Math.min(1, typo) };
}

/** 즉답(0ms)은 그 자체로 봇 신호다 (I1). 사람은 읽고 생각하고 친다. */
export const MIN_TYPING_MS = 900;
/** 페이즈가 30초라 이 이상 끌면 발화가 페이즈 밖으로 밀린다 (SPEC §5). */
export const MAX_TYPING_MS = 6_500;

/** 글자 수를 반영한 타이핑 지연(ms). 결정적이다 — 지터는 호출자가 얹는다. */
export function typingDelayMs(text: string): number {
  return Math.min(MAX_TYPING_MS, MIN_TYPING_MS + text.length * 55);
}
