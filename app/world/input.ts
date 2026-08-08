'use client';

/**
 * 월드 조작의 **단일 출처**. 소유: 원상 (/world)
 *
 * ┌─ 왜 이 파일이 생겼나 ────────────────────────────────────────────────────┐
 * │ 이 화면은 「마우스가 잠기면 논다 / 풀리면 멈춘다」 위에 세워져 있었다.     │
 * │ 그런데 **iOS 사파리에는 포인터 잠금이 아예 없다.** 폰으로 들어오면        │
 * │ 잠금이 영영 안 걸리고, 이동키를 받는 조건(pointerLockElement !== null)이   │
 * │ 영영 거짓이라 한 발짝도 못 걷는다. 화면 크기를 아무리 손봐도 안 고쳐진다. │
 * │                                                                          │
 * │ 그래서 **입력을 잠금에서 떼어낸다.** 키보드도 조이스틱도 여기 `input`     │
 * │ 하나에만 쓰고, world-scene 의 LocalRig 는 그것만 읽는다 —                │
 * │ **LocalRig 은 입력이 어디서 왔는지 모른다.**                              │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ★ zustand 에 넣지 않는다. 매 프레임 바뀌는 값이라 store.ts 머리말과 정확히 같은
 *   이유다 — 불변 업데이트로 바꾸면 초당 수십 번 리렌더가 난다. 여기 `input` 은
 *   **제자리에서 변형되는 가변 객체**고, 읽는 쪽은 useFrame 뿐이다.
 *   (구독이 필요한 건 "지금 터치 기기인가" 하나뿐이라 그것만 리스너를 둔다.)
 *
 * ★ 이 파일의 상수를 `lib/mp/constants.ts` 로 옮기지 않는다. 거기는 **클라와 워커가
 *   같이 읽는** 값의 자리인데, 워커는 조이스틱을 모른다. 감도·데드존은 화면 것이다.
 */

/* ─────────────────────────── 지금 조작 중인 손 ─────────────────────────── */

/**
 * 터치로 조작하는 중인가.
 *
 * ★ **한 번 정하고 끝내지 않는다.** 화면이 달린 노트북·키보드를 붙인 아이패드가
 *   있어서 기기 판정만으로는 틀린다. 처음엔 `(pointer: coarse)` 로 짐작하고,
 *   그다음부터는 **실제로 들어온 입력**을 보고 뒤집는다:
 *     손가락이 닿으면 → 터치 · 마우스를 움직이거나 이동키를 누르면 → 키보드
 *   그래서 아이패드에 키보드를 꽂는 순간 조이스틱이 사라지고, 손을 대면 돌아온다.
 */
let touch = false;

const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function setTouch(next: boolean): void {
  if (touch === next) return;
  touch = next;
  emit();
}

/** useSyncExternalStore 용. 구독 없이 값만 필요하면 이걸 부른다 */
export function getTouchMode(): boolean {
  return touch;
}

/** 서버 렌더 스냅샷. 서버는 손가락을 모르므로 늘 거짓이다 (마운트 뒤에 정해진다) */
export function getTouchModeServer(): boolean {
  return false;
}

export function subscribeTouchMode(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 지금 지켜보는 곳이 몇 군데인가. 두 번 부르면 리스너가 두 벌 붙으므로 센다 */
let watchers = 0;
let stopWatching: (() => void) | null = null;

/**
 * 입력 종류를 지켜본다. 마운트에서 한 번 부르고 언마운트에서 정리한다.
 * 여러 곳에서 불러도 리스너는 한 벌이다.
 *
 * ★ `navigator.maxTouchPoints` 를 첫 짐작에 쓰지 않는다 — 터치스크린 노트북이
 *   전부 걸려서 마우스를 쓰는 사람에게도 조이스틱이 뜬다. 첫 짐작은 **주 포인터**
 *   (`pointer: coarse`)로만 하고, 나머지는 실제 입력이 정한다.
 */
export function watchPointerKind(): () => void {
  if (typeof window === 'undefined') return () => {};

  watchers += 1;
  if (watchers > 1) {
    return () => {
      watchers -= 1;
      if (watchers === 0 && stopWatching) {
        stopWatching();
        stopWatching = null;
      }
    };
  }

  setTouch(window.matchMedia?.('(pointer: coarse)').matches === true);

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') setTouch(true);
    else if (e.pointerType === 'mouse') setTouch(false);
  };
  // 마우스를 **움직이기만** 해도 키보드 사용자다. 아이패드+트랙패드가 여기 걸린다.
  const onMouseMove = (e: MouseEvent) => {
    // 터치를 마우스로 흉내 낸 합성 이벤트는 movement 가 0이다 — 그건 무시한다
    if (e.movementX !== 0 || e.movementY !== 0) setTouch(false);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (MOVE_CODES.has(e.code)) setTouch(false);
  };

  window.addEventListener('pointerdown', onPointerDown, { passive: true });
  window.addEventListener('mousemove', onMouseMove, { passive: true });
  window.addEventListener('keydown', onKeyDown);
  stopWatching = () => {
    window.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('keydown', onKeyDown);
  };

  return () => {
    watchers -= 1;
    if (watchers === 0 && stopWatching) {
      stopWatching();
      stopWatching = null;
    }
  };
}

/* ─────────────────────────────── 입력 상태 ─────────────────────────────── */

export interface InputState {
  /** 오른쪽이 양수. **길이가 1을 넘을 수 있다** (키보드 대각선) — 읽는 쪽이 줄인다 */
  moveX: number;
  /** 앞이 양수 */
  moveZ: number;
  /** 달리는 중인가 */
  running: boolean;
  /**
   * 점프 버튼(키)이 **눌려 있는가**. 한 번짜리 신호가 아니라 눌림 상태다 —
   * 누른 채로 착지하면 다시 뛰던 기존 동작을 그대로 두기 위해서다.
   */
  jump: boolean;
  /**
   * 아직 카메라에 반영하지 않은 시야 변화(라디안). **읽는 쪽이 0으로 비운다.**
   * 데스크톱에서는 PointerLockControls 가 카메라를 직접 돌리므로 늘 0이다.
   */
  lookX: number;
  lookY: number;
}

/** ★ 제자리에서 변형된다. 이 객체를 복사해 들고 있지 말 것 (머리말) */
export const input: InputState = {
  moveX: 0,
  moveZ: 0,
  running: false,
  jump: false,
  lookX: 0,
  lookY: 0,
};

/**
 * 전부 놓은 상태로 되돌린다. 말하기로 들어갈 때·창을 벗어날 때 부른다.
 *
 * ★ **눌린 키 목록까지 비운다.** W 를 누른 채 Enter 를 치면 그 W 의 keyup 은
 *   입력창이 가져가서 여기로 오지 않는다 — 목록에 true 가 남아 있으면 말을 끝내고
 *   아무 키나 누르는 순간 다시 걸어간다.
 */
export function resetInput(): void {
  for (const k of Object.keys(keys)) delete keys[k];
  input.moveX = 0;
  input.moveZ = 0;
  input.running = false;
  input.jump = false;
  input.lookX = 0;
  input.lookY = 0;
}

/** 시야를 이만큼 더 돌린다 (터치 드래그가 부른다). 실제 반영은 다음 프레임이다 */
export function addLook(dx: number, dy: number): void {
  input.lookX += dx;
  input.lookY += dy;
}

/* ─────────────────────────────── 키보드 ─────────────────────────────── */

const MOVE_CODES = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

/** 지금 눌려 있는 키. 키보드는 한 벌뿐이라 모듈에 둔다 (resetInput 이 같이 비운다) */
const keys: Record<string, boolean> = {};

function recompute(): void {
  input.moveX = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
  input.moveZ = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
  input.running = Boolean(keys.ShiftLeft || keys.ShiftRight);
  input.jump = Boolean(keys.Space || keys.KeyE);
}

/**
 * 키보드를 `input` 에 연결한다. 반환값은 정리 함수다.
 *
 * ★ 눌린 키 목록을 들고 **이벤트마다 다시 계산한다.** 키다운에서 곧장 moveX 를
 *   더하면 D→A 를 겹쳐 눌렀다 D 를 뗐을 때 왼쪽으로 안 간다.
 * ★ 입력창에 치는 동안은 조작키가 아니다. 이 가드가 없으면 "왜"를 치다가 걸어가고
 *   Space 를 칠 때마다 뛴다.
 */
export function attachKeyboard(): () => void {
  const typing = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    const tag = el?.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable === true;
  };

  const down = (e: KeyboardEvent) => {
    if (typing(e)) return;
    // Space 는 브라우저가 스크롤·마지막 버튼 재클릭에 쓴다. 여기선 점프다
    if (e.code === 'Space') e.preventDefault();
    keys[e.code] = true;
    recompute();
  };
  const up = (e: KeyboardEvent) => {
    keys[e.code] = false;
    recompute();
  };
  // 탭을 벗어나면 눌린 키가 그대로 남아 혼자 계속 걷는다
  const blur = () => resetInput();

  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  window.addEventListener('blur', blur);
  return () => {
    window.removeEventListener('keydown', down);
    window.removeEventListener('keyup', up);
    window.removeEventListener('blur', blur);
    resetInput();
  };
}

/* ─────────────────────────── 조이스틱 (순수 함수) ─────────────────────────── */

/** 조이스틱 반경(px). 엄지 하나가 편하게 닿는 거리다 */
export const STICK_RADIUS = 56;

/** 이 안쪽은 안 민 것으로 본다. 엄지를 얹기만 해도 걸어가지 않게 */
export const STICK_DEADZONE = 0.18;

/**
 * 여기까지 밀면 달린다. 별도 달리기 버튼을 두지 않는 이유는 엄지가 둘뿐이라서다 —
 * 버튼이 늘수록 하나도 제대로 못 누른다.
 */
export const STICK_RUN = 0.85;

export interface StickVector {
  /** 오른쪽이 양수. 길이는 0~1 */
  x: number;
  /** 앞이 양수 */
  z: number;
  running: boolean;
}

const STOPPED: StickVector = { x: 0, z: 0, running: false };

/**
 * 조이스틱 중심에서 손가락까지의 화면 거리(px)를 이동 벡터로 바꾼다.
 *
 * @param dx 오른쪽으로 민 거리(px)
 * @param dy **화면 아래로** 민 거리(px). 화면 좌표라 아래가 양수고, 앞으로 가려면
 *           위로 밀어야 하므로 z 는 부호가 뒤집힌다.
 *
 * ★ 데드존 밖에서는 **금방 최고 속도에 닿게** 한다(STICK_RUN 에서 1). 엄지로 속도를
 *   정밀하게 맞추는 건 애초에 불가능해서, 연속으로 주면 "왜 느리지"만 남는다.
 */
export function stickVector(dx: number, dy: number, radius = STICK_RADIUS): StickVector {
  const dist = Math.hypot(dx, dy);
  if (dist <= 0) return STOPPED;

  const mag = Math.min(1, dist / radius);
  if (mag < STICK_DEADZONE) return STOPPED;

  const speed = Math.min(1, (mag - STICK_DEADZONE) / (STICK_RUN - STICK_DEADZONE));
  return {
    x: (dx / dist) * speed,
    z: (-dy / dist) * speed,
    running: mag >= STICK_RUN,
  };
}

/** 엄지 그림이 원 밖으로 나가지 않게 자른 위치(px). 그리기 전용이다 */
export function stickKnob(dx: number, dy: number, radius = STICK_RADIUS): { x: number; y: number } {
  const dist = Math.hypot(dx, dy);
  if (dist <= radius) return { x: dx, y: dy };
  return { x: (dx / dist) * radius, y: (dy / dist) * radius };
}

/* ─────────────────────────────── 시야 ─────────────────────────────── */

/** 드래그 1px 당 몇 라디안 도는가. 화면 폭이 아니라 CSS 픽셀 기준이라 기기별로 같다 */
export const LOOK_SENSITIVITY = 0.0035;

/** 고개를 젖힐 수 있는 한계(rad). 넘으면 화면이 뒤집힌다 */
export const MAX_PITCH = (85 * Math.PI) / 180;

/* ─────────────────────────── 세로 화면의 시야각 ─────────────────────────── */

/**
 * three.js 의 `fov` 는 **세로** 시야각이다. 60 으로 고정해 두면 화면 비율에 따라
 * 가로 시야각이 이렇게 벌어진다:
 *
 *   가로 16:9 → 약 91°   (옆에 선 사람이 보인다)
 *   세로 9:16 → 약 36°   (망원경으로 보는 수준 — 옆 사람이 화면에 없다)
 *
 * 세로로 들고 하면 게임이 안 되는 건 화면이 작아서가 아니라 이것 때문이다.
 * 그래서 **가로 시야각을 목표로 두고 세로 fov 를 역산한다.**
 *
 * ★ 완전히 보정하지는 않는다(9:16 이면 fov 가 122 까지 간다 — 가장자리가 어안렌즈처럼
 *   휜다). 82 에서 끊는다: 9:16 에서 가로 58° 쯤 나와 36° 보다 훨씬 낫다.
 *
 * ┌─ ★★ 기준을 16:9 가 아니라 **4:3** 으로 잡는다 ──────────────────────────┐
 * │ 처음엔 16:9 로 잡았다. 그러면 16:9 에서만 정확히 60 이 나오고, **그보다   │
 * │ 조금이라도 좁은 창은 전부 넓어진다** — 4:3 창이면 75, 16:10 창이면 65.    │
 * │ 창을 최대화하지 않은 데스크톱은 거의 다 여기 걸려서, 폰을 고치려다 이미    │
 * │ 하던 게임의 화면을 바꿔 놓는 셈이었다.                                    │
 * │                                                                        │
 * │ 4:3 을 기준으로 두면 그 아래(=60) 로 잘리는 구간이 넓어져서, **가로가     │
 * │ 4:3 보다 넓은 창은 전부 정확히 60 이다** — 16:9 도, 16:10 도, 울트라와이드 │
 * │ 도. 넓히는 건 4:3 보다 **좁은** 화면, 즉 세로로 든 폰뿐이다.             │
 * └────────────────────────────────────────────────────────────────────────┘
 */
export const BASE_FOV = 60;
const MAX_FOV = 82;
/**
 * 지키려는 가로 시야각의 절반(rad) — 4:3 에서 fov 60 이 만드는 값(가로 75°).
 * 이보다 넓은 창에서는 계산 결과가 60 아래라 그냥 60 으로 잘린다 (위 상자).
 */
const HALF_H_FOV = Math.atan(Math.tan((BASE_FOV / 2) * (Math.PI / 180)) * (4 / 3));

export function fovForAspect(aspect: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0) return BASE_FOV;
  const deg = 2 * Math.atan(Math.tan(HALF_H_FOV) / aspect) * (180 / Math.PI);
  return Math.min(MAX_FOV, Math.max(BASE_FOV, deg));
}
