'use client';

/**
 * 주제 공개 안내 음성 — "첫 번째 주제 …" / "두 번째 주제 …". 소유: 원상 (/world)
 *
 * ┌─ 언제 나오나 ──────────────────────────────────────────────────────────────┐
 * │ 주제 문구가 **스크린에 실제로 뜨는 순간**(speak 단계) 딱 한 번, 라운드      │
 * │ 번호에 맞는 파일 하나 (page.tsx 의 「주제가 실제로 뜨면」 효과).            │
 * │ 그 앞의 topic 단계는 「곧 주제가 나온다」로 뜸 들이는 6초라, 거기서 울리면   │
 * │ 안내가 주제보다 6초 빠르다.                                                │
 * │                                                                            │
 * │ 같은 자리에서 대화 기록에도 안내 한 줄이 쌓인다 — 소리를 못 듣는 환경        │
 * │ (음소거·자리 비움)에서도 주제가 바뀐 걸 알아야 한다.                       │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 배경 음악(music.ts)과 **따로 논다.** 음악은 멈춰도 이 안내는 나와야 하고,
 *   반대로 안내가 끝나도 음악을 건드리지 않는다. 다만 **음소거는 따른다** —
 *   M 으로 소리를 껐는데 안내만 튀어나오면 그게 더 놀랍다.
 * ★ 자동재생이 막혀도 **다시 시도하지 않는다.** 음악(armRetryOnGesture)과 다른
 *   점이 이것이다: 4초짜리 안내는 제때가 지나면 의미가 없고, 다음 클릭에
 *   뒤늦게 울리면 그때 뜬 주제와 번호가 어긋난다.
 */

import { getVolume as getMusicVolume } from './music';

/** 라운드 번호(1-based) → 파일. 주제 라운드는 2개다 (ROUND_TOPIC_ROUNDS) */
const SRC: Record<number, string> = {
  1: '/world/topic-1.m4a',
  2: '/world/topic-2.m4a',
};

/**
 * 안내 음량. 음악(기본 0.18) 위에 얹히는 말이라 그보다 훨씬 크게 잡는다 —
 * 음악과 같은 값으로 두면 말이 배경에 묻혀서 안 들린다.
 */
const VOICE_VOLUME = 0.85;

/** 라운드별로 하나씩 들고 있는다. 매번 new Audio 를 만들면 겹쳐 울린다 */
const cache = new Map<number, HTMLAudioElement>();

function element(round: number): HTMLAudioElement | null {
  const src = SRC[round];
  if (!src) return null;
  let el = cache.get(round);
  if (!el) {
    el = new Audio(src);
    el.preload = 'auto';
    cache.set(round, el);
  }
  return el;
}

/**
 * 주제 공개 안내를 튼다. 아는 라운드가 아니면 아무것도 안 한다.
 * 앞의 안내가 아직 울리는 중이면(빠른 전환) 처음으로 되감아 새로 튼다.
 */
export function playTopicVoice(round: number): void {
  // M 으로 음소거한 사람에게는 울리지 않는다 (머리말)
  if (getMusicVolume() <= 0) return;

  const el = element(round);
  if (!el) return;
  el.volume = VOICE_VOLUME;
  el.currentTime = 0;
  // 막히면 조용히 삼킨다 — 안내는 부가물이고, 뒤늦게 울리면 번호가 어긋난다
  void el.play().catch(() => {});
}

/** 방을 나갈 때. 울리던 안내가 로비까지 따라가지 않게 한다 */
export function stopTopicVoice(): void {
  for (const el of cache.values()) {
    el.pause();
    el.currentTime = 0;
  }
}
