/**
 * 타이핑 지연 · 메시지 분할 · 오타. 소유: B (SPEC §2)
 *
 * 지연은 setTimeout으로 기다리는 게 아니라 visible_at에 시각으로 박는다.
 * 서버 함수가 6초를 기다릴 수 없기 때문이다 (SPEC §5.3).
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

/** TODO(B): 사람 메시지에서 StyleProfile을 뽑는다. */
export function observeStyle(_texts: string[]): StyleProfile {
  throw new Error('observeStyle: 미구현 (B)');
}

/** TODO(B): 글자 수와 페르소나를 반영한 타이핑 지연(ms). */
export function typingDelayMs(_text: string): number {
  throw new Error('typingDelayMs: 미구현 (B)');
}
