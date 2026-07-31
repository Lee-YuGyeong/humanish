'use client';

/**
 * 월드 배경 음악. 소유: 원상 (/world)
 *
 * ┌─ 언제 나오나 ──────────────────────────────────────────────────────────┐
 * │ 스크린 영상이 **끝난 뒤에** 시작한다. 영상이 도는 동안 음악이 같이 나면 │
 * │ 둘 다 안 들린다. 그래서 이 모듈은 스스로 시작하지 않고, 영상 쪽        │
 * │ (warehouse.tsx 의 ScreenVideo)이 'ended' 를 받았을 때 startMusic() 을   │
 * │ 부른다.                                                                │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 왜 React 상태가 아니라 모듈인가: 소리를 내는 <audio> 는 R3F 캔버스 **밖**에
 *   있고, 시작 신호는 캔버스 **안**(영상)에서 온다. 둘 사이에 props 를 놓을 자리가
 *   없어서 모듈 하나를 공용 창구로 쓴다. 볼륨 UI 는 useSyncExternalStore 로 읽는다.
 *
 * ★ 자동재생 규칙: 소리는 사용자가 무언가 누른 뒤에만 난다. 월드는 들어와서
 *   화면을 한 번 클릭해야 조작이 시작되므로(포인터 잠금) 그 시점 이후에는 허용된다.
 *   그래도 play() 는 거절될 수 있어 실패를 조용히 삼킨다 — 음악은 부가물이다.
 */

const SRC = '/world/music.m4a';

/**
 * 기본 볼륨. **낮게 시작한다** — 들어오자마자 깔리는 소리라 크면 놀란다.
 * 더 듣고 싶은 사람은 걸으면서 `+` 로 올린다 (M 음소거 · − + 조절, page.tsx).
 * ★ 이 값을 바꾸면 page.tsx 의 useSyncExternalStore 서버 스냅샷도 같이 맞춘다.
 */
const DEFAULT_VOLUME = 0.18;

let audio: HTMLAudioElement | null = null;
let volume = DEFAULT_VOLUME;
let playing = false;

const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

function element(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio(SRC);
    audio.loop = true;
    audio.preload = 'none'; // 영상이 끝나기 전에는 받지 않는다 (첫 진입을 무겁게 하지 않는다)
    audio.volume = volume;
  }
  return audio;
}

/**
 * 음악을 켠다. 방에 들어오는 순간(카운트다운과 함께) 한 번, 영상이 끝난 뒤 한 번.
 * pause 로 멈춘 뒤에 다시 부르면 **멈춘 자리에서** 이어진다 (currentTime 을 안 건드린다).
 */
export function startMusic(): void {
  const el = element();
  el.volume = volume;
  void el.play().then(
    () => {
      playing = true;
      emit();
    },
    () => {
      // 브라우저가 막았다. 볼륨을 만지면 그때 다시 시도한다 (setVolume 참고)
      playing = false;
      emit();
    },
  );
}

/**
 * 영상이 나오는 동안 잠깐 비킨다. 둘이 같이 나면 둘 다 안 들린다.
 * 끄는 게 아니라 **멈추는** 것이라 영상이 끝나면 이어서 튼다.
 */
export function pauseMusic(): void {
  if (!audio) return;
  audio.pause();
  playing = false;
  emit();
}

/** 방을 나갈 때. 다음에 들어오면 처음부터 다시 시작한다 */
export function stopMusic(): void {
  if (!audio) return;
  audio.pause();
  audio.currentTime = 0;
  playing = false;
  emit();
}

export function getVolume(): number {
  return volume;
}

export function isPlaying(): boolean {
  return playing;
}

export function setVolume(next: number): void {
  volume = Math.min(1, Math.max(0, next));
  if (audio) {
    audio.volume = volume;
    // 막혀서 멈춰 있었다면 슬라이더를 만진 지금이 사용자 제스처다 — 다시 켠다
    if (!playing && volume > 0 && audio.currentTime > 0) startMusic();
  }
  emit();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
