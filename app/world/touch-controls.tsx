'use client';

/**
 * 손으로 하는 조작 — 가상 조이스틱 · 시야 드래그 · 버튼. 소유: 원상 (/world)
 *
 * 데스크톱의 WASD·마우스가 하던 일을 그대로 한다. 값은 전부 `./input` 의 `input`
 * 하나에만 쓰고, 3D 쪽(world-scene 의 LocalRig)은 그걸 읽을 뿐 **어디서 온 값인지
 * 모른다.** 그래서 이 파일을 지워도 키보드 조작은 멀쩡하다.
 *
 * ┌─ 왜 React 상태가 하나도 없나 ────────────────────────────────────────────┐
 * │ 엄지는 손가락을 뗄 때까지 매 프레임 움직인다. 그 좌표를 useState 에 담으면 │
 * │ 초당 60번 리렌더가 나고, 그 리렌더가 3D 캔버스까지 끌고 돈다.             │
 * │ 그래서 엄지 그림은 **ref 로 DOM transform 을 직접 만진다** —              │
 * │ app/world/store.ts 가 좌표를 Map 안에서 제자리 변형하는 것과 같은 이유다. │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 손가락 두 개를 **동시에** 받아야 한다(왼손 걷기 + 오른손 시야). touchstart 가
 *   아니라 Pointer Events 를 쓰고 `pointerId` 로 따로 추적하는 이유다.
 * ★ 판(투표·결과·역할 카드)이 떠 있는 동안에는 이 오버레이를 **아예 렌더하지
 *   않는다** (page.tsx 의 paused). 판 위의 버튼과 손가락을 두고 싸우지 않는다.
 */

import { useEffect, useRef } from 'react';

import {
  STICK_RADIUS,
  addLook,
  input,
  resetInput,
  stickKnob,
  stickVector,
} from './input';

/** 조이스틱을 받는 영역 — 화면 왼쪽 이만큼. 나머지는 시야 드래그다 */
const STICK_ZONE = 0.5;

/** 오른손 버튼 줄의 바닥 높이. 점프(TouchControls)와 💬(SpeakButton)가 같이 쓴다 */
const BTN_BOTTOM = `calc(1.75rem + env(safe-area-inset-bottom, 0px))`;
/** 💬 의 바닥 높이 — 점프(h-16 = 4rem) 위 gap 0.75rem. 점프가 사라져도 이 자리다 */
const SPEAK_BOTTOM = `calc(1.75rem + 4rem + 0.75rem + env(safe-area-inset-bottom, 0px))`;

/** 조이스틱 원의 기본 자리(가장자리에서 px). 손을 대면 그 자리로 옮겨 간다 */
const STICK_HOME_INSET = STICK_RADIUS + 30;

export function TouchControls() {
  const rootRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);

  /** 걷기를 맡은 손가락. null 이면 아무도 안 짚고 있다 */
  const stick = useRef<{ id: number; ox: number; oy: number } | null>(null);
  /** 시야를 맡은 손가락. 직전 위치를 들고 있다가 차이만큼 돌린다 */
  const look = useRef<{ id: number; x: number; y: number } | null>(null);

  /** 조이스틱 원을 이 자리에 그린다 (오버레이 기준 px) */
  const placeRing = (x: number, y: number, active: boolean) => {
    const ring = ringRef.current;
    if (!ring) return;
    ring.style.left = `${x}px`;
    ring.style.top = `${y}px`;
    ring.style.opacity = active ? '0.85' : '0.3';
  };

  /** 엄지를 원 안에서 이만큼 옮긴다 */
  const placeKnob = (dx: number, dy: number) => {
    const knob = knobRef.current;
    if (!knob) return;
    const k = stickKnob(dx, dy);
    knob.style.transform = `translate(-50%, -50%) translate(${k.x}px, ${k.y}px)`;
  };

  /** 손을 뗐다 — 다리를 멈추고 원을 기본 자리로 되돌린다 */
  const releaseStick = () => {
    stick.current = null;
    input.moveX = 0;
    input.moveZ = 0;
    input.running = false;
    placeKnob(0, 0);
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) placeRing(STICK_HOME_INSET, rect.height - STICK_HOME_INSET, false);
  };

  // 기본 자리를 잡아 둔다. 화면을 돌리면 높이가 바뀌므로 그때마다 다시 잡는다.
  useEffect(() => {
    const home = () => {
      if (stick.current) return; // 짚고 있는 중에는 건드리지 않는다
      const rect = rootRef.current?.getBoundingClientRect();
      if (rect) placeRing(STICK_HOME_INSET, rect.height - STICK_HOME_INSET, false);
    };
    home();
    window.addEventListener('resize', home);
    window.addEventListener('orientationchange', home);
    return () => {
      window.removeEventListener('resize', home);
      window.removeEventListener('orientationchange', home);
    };
  }, []);

  /*
   * ★ 사라질 때 반드시 비운다. 판이 뜨는 순간 이 오버레이가 언마운트되는데,
   *   그때 조이스틱을 밀고 있었다면 pointerup 이 영영 오지 않는다 —
   *   `input.moveZ` 가 1인 채로 남아 **혼자 벽으로 계속 걸어간다.**
   */
  useEffect(() => () => resetInput(), []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (stick.current === null && x < rect.width * STICK_ZONE) {
      stick.current = { id: e.pointerId, ox: e.clientX, oy: e.clientY };
      placeRing(x, y, true);
      placeKnob(0, 0);
    } else if (look.current === null) {
      look.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    } else {
      return;
    }
    // 손가락이 이 요소 밖으로 나가도 계속 받는다 (원 밖으로 밀면 바로 이렇게 된다)
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = stick.current;
    if (s && s.id === e.pointerId) {
      const dx = e.clientX - s.ox;
      const dy = e.clientY - s.oy;
      const v = stickVector(dx, dy);
      input.moveX = v.x;
      input.moveZ = v.z;
      input.running = v.running;
      placeKnob(dx, dy);
      return;
    }

    const l = look.current;
    if (l && l.id === e.pointerId) {
      // 쌓아만 둔다. 카메라에 반영하는 건 다음 프레임의 LocalRig 이다
      addLook(e.clientX - l.x, e.clientY - l.y);
      l.x = e.clientX;
      l.y = e.clientY;
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (stick.current?.id === e.pointerId) releaseStick();
    else if (look.current?.id === e.pointerId) look.current = null;
  };

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-[28] select-none">
      {/*
        걷기·시야를 받는 면. 화면 전체를 덮지만 **판보다 아래**라(z-28) 투표 카드처럼
        위에 뜨는 것들이 손가락을 먼저 가져간다. touch-none 이 없으면 밀 때마다
        페이지가 스크롤되고 두 번 두드리면 확대된다.
      */}
      <div
        className="pointer-events-auto absolute inset-0 touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />

      {/* 조이스틱. 짚기 전에는 왼쪽 아래에 흐리게 서 있다가, 손을 대면 그 자리로 온다 */}
      <div
        ref={ringRef}
        aria-hidden
        className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/25 bg-black/25 backdrop-blur-[2px] transition-opacity duration-150"
        style={{ width: STICK_RADIUS * 2, height: STICK_RADIUS * 2, opacity: 0.3 }}
      >
        <div
          ref={knobRef}
          className="absolute left-1/2 top-1/2 h-11 w-11 rounded-full bg-[#d4a373]/70 shadow-[0_0_12px_rgba(212,163,115,0.35)]"
          style={{ transform: 'translate(-50%, -50%)' }}
        />
      </div>

      {/*
        오른손 버튼 — 점프 하나뿐이다. **💬 는 여기 없다** (아래 SpeakButton 상자).
        아래에서 safe-area 만큼 띄운다 — 아이폰 홈 인디케이터 위에 버튼이 겹치면
        누를 때마다 앱이 닫히려 한다.
      */}
      <div
        className="pointer-events-auto absolute right-5 flex flex-col items-end gap-3"
        style={{ bottom: BTN_BOTTOM }}
      >
        {/*
          점프. **누르고 있는 동안** 참이다 — 키보드의 Space 와 같은 뜻이라
          누른 채 착지하면 한 번 더 뛴다(기존 동작 그대로).
        */}
        <button
          type="button"
          onPointerDown={(e) => {
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            input.jump = true;
          }}
          onPointerUp={() => {
            input.jump = false;
          }}
          onPointerCancel={() => {
            input.jump = false;
          }}
          aria-label="점프"
          className="flex h-16 w-16 touch-none items-center justify-center rounded-full border border-white/20 bg-black/55 text-neutral-200 backdrop-blur active:bg-white/20"
        >
          <JumpIcon />
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────────── 말하기 버튼 ─────────────────────────────── */

/**
 * 💬 — 데스크톱의 Enter 자리. **TouchControls 밖에 따로 있다.**
 *
 * ┌─ 왜 조이스틱과 한 몸이 아닌가 ──────────────────────────────────────────┐
 * │ TouchControls 는 걷는 중(playing)에만 마운트된다 — 판이 뜨면 조이스틱이   │
 * │ 사라지는 게 맞다. 그런데 **지목 투표·판결·최후변론은 다리는 묶여도 입은   │
 * │ 열린 단계다** (mayChat). 데스크톱은 그때도 Enter 로 말하는데, 💬 가       │
 * │ 조이스틱과 같이 사라지면 폰 사람만 그 단계에 침묵한다 — 한쪽 입력의       │
 * │ 사람들만 조용한 단계가 생기면 그게 그대로 관측 신호가 된다 (I1).          │
 * │ 그래서 이 버튼은 말이 열려 있는 한(page.tsx 의 canSpeak) 판 위에도 떠     │
 * │ 있고, 자리는 걷는 중의 점프 위 그 칸 그대로다 — 손이 외운 자리를 지킨다.  │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * z-[45]: 투표·판결 패널(z-40)보다 위, 결과(z-50)보다 아래 — 걷는 중에 뜨는
 * 한 줄 입력(page.tsx ChatLine)과 같은 층이다. 결과에서는 말이 잠겨 안 뜬다.
 */
export function SpeakButton({ onSpeak }: { onSpeak: () => void }) {
  return (
    <button
      type="button"
      onPointerDown={(e) => {
        // 아래 시야 면(TouchControls)으로 흘러가지 않게 여기서 끊는다
        e.stopPropagation();
        onSpeak();
      }}
      aria-label="말하기"
      className="absolute right-5 z-[45] flex h-14 w-14 touch-none items-center justify-center rounded-full border border-[#d4a373]/50 bg-black/55 text-[#e8c9a0] backdrop-blur active:bg-[#d4a373]/30"
      style={{ bottom: SPEAK_BOTTOM }}
    >
      <SpeakIcon />
    </button>
  );
}

/* ─────────────────────────────── 메뉴 ─────────────────────────────── */

/**
 * ☰ 로 여는 판 — 데스크톱의 ESC 자리다.
 *
 * 걸으면서 키로 하던 것(M · − · + 소리, ESC 대화 기록, 퇴장)이 폰에는 키가 없어서
 * 갈 곳이 없다. 그걸 전부 여기 모은다. **이 판이 떠 있는 동안은 판정상 정지다**
 * (page.tsx 의 paused) — 데스크톱에서 ESC 를 눌러 멈추는 것과 같다.
 */
export function TouchMenu({
  roomLine,
  volume,
  onVolume,
  onClose,
  onLeave,
  notes,
  children,
}: {
  /** 방 코드 · 내 이름 · 정원 · 역할. 화면 위 헤더에 있던 줄이 폰에서는 여기로 온다 */
  roomLine: string;
  volume: number;
  onVolume: (next: number) => void;
  onClose: () => void;
  onLeave: () => void;
  /** 좌석 메모 (game-hud 의 SeatNotes). 폰에서는 이 판이 유일한 자리다 */
  notes?: React.ReactNode;
  /** 대화 기록 (game-hud 의 ChatTranscript). 여기서 만들지 않고 받아 끼운다 */
  children?: React.ReactNode;
}) {
  return (
    <div className="absolute inset-0 z-[46] flex flex-col bg-black/85 backdrop-blur">
      <div
        className="flex shrink-0 items-center justify-between gap-3 px-5 py-4"
        style={{ paddingTop: `calc(1rem + env(safe-area-inset-top, 0px))` }}
      >
        <span className="min-w-0">
          <span className="block text-[13px] font-bold tracking-wide text-neutral-200">
            잠깐 멈춤
          </span>
          {/* 방 정보. 걷는 동안에는 화면에 없다 — 3D 를 가리지 않으려고 여기로 옮겼다 */}
          <span className="block truncate font-mono text-[10px] text-neutral-500">{roomLine}</span>
        </span>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-full bg-white/10 px-4 py-2 text-[12px] font-bold text-neutral-100 active:bg-white/20"
        >
          게임으로
        </button>
      </div>

      {/* 좌석 메모 — 누구를 뭘로 찍어 뒀는지. 걸으면서는 못 누르니 여기가 그 자리다 */}
      {notes ? <div className="shrink-0 px-5 pb-4">{notes}</div> : null}

      {/* 소리 — 걸으면서 M · − · + 로 하던 것 */}
      <div className="shrink-0 px-5 pb-4">
        <p className="mb-2 text-[10px] tracking-[0.14em] text-neutral-500">소리</p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onVolume(volume > 0 ? 0 : 0.18)}
            className="shrink-0 rounded-lg bg-white/10 px-3 py-2 text-[12px] font-bold text-neutral-200 active:bg-white/20"
          >
            {volume > 0 ? '음소거' : '켜기'}
          </button>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(volume * 100)}
            onChange={(e) => onVolume(Number(e.target.value) / 100)}
            aria-label="소리 크기"
            className="min-w-0 flex-1 accent-[#d4a373]"
          />
          <span className="w-9 shrink-0 text-right font-mono text-[11px] text-neutral-400">
            {Math.round(volume * 100)}
          </span>
        </div>
      </div>

      {/* 대화 기록 — 남는 자리를 전부 준다 */}
      <div className="flex min-h-0 flex-1 flex-col px-5">{children}</div>

      <div
        className="shrink-0 px-5 py-4"
        style={{ paddingBottom: `calc(1rem + env(safe-area-inset-bottom, 0px))` }}
      >
        <button
          type="button"
          onClick={onLeave}
          className="w-full rounded-lg border border-red-500/30 py-2.5 text-[12px] font-bold text-red-300 active:bg-red-500/15"
        >
          현재 방에서 퇴장하기
        </button>
        <p className="mt-3 text-center text-[10px] leading-relaxed text-neutral-600">
          왼쪽을 밀어 이동 · 끝까지 밀면 달리기 · 오른쪽을 문질러 시야
        </p>
      </div>
    </div>
  );
}

/* ─────────────────────────────── 아이콘 ─────────────────────────────── */
/* CDN 대신 인라인 SVG — 배포본에서 외부 요청이 나가지 않는다 (page.tsx 와 같은 규칙) */

function SpeakIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M20 12a7 7 0 0 1-7 7H7l-3 2.5V12a7 7 0 0 1 7-7h2a7 7 0 0 1 7 7Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function JumpIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 19V6m0 0-5 5m5-5 5 5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** ☰ — 헤더에 놓는다. 데스크톱의 ESC 자리다 */
export function MenuIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
