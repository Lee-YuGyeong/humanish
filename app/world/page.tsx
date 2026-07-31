'use client';

/**
 * /world — 여러 명이 같은 3D 공간에서 함께 있는 화면. 소유: 원상
 *
 * 흐름:
 *   방 만들기·입장 (기존 /api/room, /api/room/join — 좌석·역할은 DB가 정한다)
 *     → /api/world/ticket 으로 60초짜리 서명 티켓을 받고
 *     → 워커(Durable Object)에 WebSocket으로 붙는다
 *
 * 이 화면은 Supabase를 직접 읽지 않는다. 게임 규칙·페이즈는 /room/[code]의 몫이고,
 * 여기는 **같이 있는 것**만 책임진다.
 */

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { spawnFor } from '@/lib/mp/spawn';
import type { Role } from '@/lib/game/types';
import { WorldConnection, type WorldEvents } from './net/connection';
import {
  getVolume as getMusicVolume,
  setVolume as setMusicVolume,
  subscribe as musicSubscribe,
} from './music';
import { useWorldStore } from './store';

const WorldScene = dynamic(() => import('./world-scene'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-[#07050a]">
      <p className="font-mono text-[11px] tracking-widest text-neutral-600">LOADING WORLD...</p>
    </div>
  ),
});

interface Ticket {
  ticket: string;
  ws_url: string;
  self: { id: string; room_id: string; seat: number; nickname: string; mask_id: string };
  room: { id: string; code: string; capacity: number; phase: string };
  role: Role | null;
}

const ROLE_LABEL: Record<Role, string> = {
  citizen: '인간',
  spy: '스파이 — AI인 척해야 한다',
  ai: 'AI',
};

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${url}`);
  return data;
}

/**
 * 마우스를 잡는다. 실패하면 잠시 뒤 다시 두드린다.
 *
 * ★ 크롬은 **ESC 로 사용자가 직접 푼 잠금**을 곧바로 다시 잡아주지 않는다
 *   (대략 1.25초). 그 사이 요청은 pointerlockerror 로 조용히 튕긴다. 한 번만
 *   요청하면 "ESC 를 눌렀는데 안 돌아간다"가 되므로, 튕길 때마다 간격을 두고
 *   두 번 더 시도한다. 그래도 안 되면 화면은 이미 걷기 모드고(키 조작은 된다)
 *   시야만 안 돌아간다 — 그때는 「게임으로」를 한 번 더 누르면 된다.
 */
function requestLock(tries = 3, delayMs = 1400): void {
  const canvas = document.querySelector('canvas');
  if (!canvas) return;

  const onError = () => {
    document.removeEventListener('pointerlockchange', onSettled);
    if (tries > 1) window.setTimeout(() => requestLock(tries - 1, delayMs), delayMs);
  };
  const onSettled = () => document.removeEventListener('pointerlockerror', onError);
  document.addEventListener('pointerlockerror', onError, { once: true });
  document.addEventListener('pointerlockchange', onSettled, { once: true });

  try {
    // 최신 크롬은 Promise 를 준다. 거절은 위 이벤트로도 오므로 여기선 삼킨다
    const p = canvas.requestPointerLock() as unknown;
    if (p instanceof Promise) p.catch(() => {});
  } catch {
    /* 이벤트 쪽에서 재시도한다 */
  }
}

export default function WorldPage() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [locked, setLocked] = useState(false);
  const [draft, setDraft] = useState('');
  /** ESC 로 마우스를 푼 뒤에만 보이는 판들. 채팅은 기본으로 열어 둔다 */
  const [chatOpen, setChatOpen] = useState(true);
  /**
   * 설정판을 띄울 것인가. **잠금 상태와 따로 둔다.**
   *
   * 예전엔 `!locked` 로 판을 그렸는데, 크롬은 ESC 로 푼 잠금을 **1.25초쯤 다시
   * 잡아주지 않는다.** 그래서 ESC 를 한 번 더 눌러도 잠금이 거절돼 locked 가
   * false 로 남았고, 판이 화면에 붙어 있었다. 이제 판은 이 상태만 보고,
   * 잠금은 뒤에서 재시도한다 (requestLock).
   */
  const [settingsOpen, setSettingsOpen] = useState(false);

  const status = useWorldStore((s) => s.status);
  const errorText = useWorldStore((s) => s.errorText);
  const messages = useWorldStore((s) => s.messages);

  const connRef = useRef<WorldConnection | null>(null);
  if (connRef.current === null) connRef.current = new WorldConnection();
  const conn = connRef.current;
  const inputRef = useRef<HTMLInputElement>(null);

  /** WS 콜백은 스토어를 **구독하지 않고** getState()로 부른다 (store.ts 머리말). */
  const events = useMemo<WorldEvents>(
    () => ({
      onWelcome: (selfId, players) =>
        useWorldStore.getState().applyWelcome(selfId, players, performance.now()),
      onJoined: (player) => useWorldStore.getState().addPlayer(player, performance.now()),
      onLeft: (id) => useWorldStore.getState().removePlayer(id),
      onMoved: (id, x, z, y, heading, anim) =>
        useWorldStore.getState().applyMove(id, x, z, y, heading, anim, performance.now()),
      onChat: (id, nickname, text, ts) =>
        useWorldStore.getState().applyChat(id, nickname, text, ts, performance.now()),
      onError: (codeText) =>
        useWorldStore.getState().setStatus('error', errorMessage(codeText)),
      onClose: () => useWorldStore.getState().setStatus('error', '연결이 끊겼다'),
    }),
    [],
  );

  const enter = useCallback(
    async (roomCode?: string) => {
      setBusy(true);
      try {
        // 방을 옮길 때는 이전 방 상태를 전부 지운다. 안 지우면 새 방에 새어 나온다
        conn.close();
        useWorldStore.getState().reset();
        useWorldStore.getState().setStatus('connecting');

        const room = roomCode
          ? await postJson<{ room: { id: string } }>('/api/room/join', { code: roomCode.toUpperCase() })
          : await postJson<{ room: { id: string } }>('/api/room', {});

        const t = await postJson<Ticket>('/api/world/ticket', { room_id: room.room.id });
        setTicket(t);
        setCode(t.room.code);
        useWorldStore.getState().setSelf(t.self.id, {
          seat: t.self.seat,
          nickname: t.self.nickname,
          maskId: t.self.mask_id,
        });
        conn.connect(t.ws_url, t.room.id, t.ticket, events);
      } catch (e) {
        useWorldStore.getState().setStatus('error', e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [conn, events],
  );

  useEffect(() => () => conn.close(), [conn]);

  /** 세계가 실제로 떠 있는가. 아래 효과들이 전부 이 값을 본다 (선언이 먼저여야 한다) */
  const live = status === 'live' && ticket !== null;

  /*
   * ★ 입력창에 포커스를 **강제하지 않는다.** 포커스를 억지로 뺏으면 다시 걷기로
   *   돌아가 카메라를 돌리려 할 때 방해가 된다(포커스가 창에 묶여 조작이 어긋난다).
   *   "설정/대화 중에 몸이 걸어다니는" 문제는 포커스가 아니라 **포인터 잠금 상태**로
   *   막는다 — world-scene.tsx 의 LocalRig 가 잠금이 풀린 동안 이동키를 무시한다.
   *   말을 하려면 입력창을 한 번 클릭해 포커스를 준다(그래야 카메라도 자유롭다).
   */

  /*
   * 브라우저가 잠금을 **풀었다** = 사용자가 ESC 를 눌렀다 = 설정을 열라는 뜻이다.
   * (잠금 해제는 ESC 말고는 일어나지 않는다 — 클릭으로 잡지도, 풀지도 않는다.)
   *
   * '잠긴 적이 있다가 풀렸을 때'만 연다. 그냥 `!locked` 로 열면 입장 직후
   * 아직 한 번도 안 잠긴 순간에 판이 번쩍 떴다 사라진다.
   */
  const wasLocked = useRef(false);
  useEffect(() => {
    if (locked) {
      wasLocked.current = true;
      setSettingsOpen(false);
    } else if (wasLocked.current) {
      wasLocked.current = false;
      setSettingsOpen(true);
    }
  }, [locked]);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    conn.sendChat(text);
    setDraft('');
  }, [conn, draft]);

  /**
   * 설정을 닫고 걷기로 돌아간다.
   *
   * **판은 즉시 사라진다.** 잠금이 잡히는지와 상관없이 닫는다 — 예전엔 잠금이
   * 걸려야 판이 사라지는 구조라, 크롬이 거절하는 동안 판이 화면에 남았다.
   * 잠금은 requestLock 이 뒤에서 몇 번 더 두드린다.
   */
  const backToWalking = useCallback(() => {
    inputRef.current?.blur();
    setSettingsOpen(false);
    requestLock();
  }, []);

  const spawn = useMemo(
    () => (ticket ? spawnFor(ticket.self.seat, ticket.room.capacity) : { x: 0, z: 0 }),
    [ticket],
  );

  /*
   * 들어오면 **바로 걷는다.** 예전엔 화면을 한 번 클릭해야 마우스가 잡혔는데,
   * 그 클릭이 document 전체에 걸려 있어서 설정을 열어 놓고 볼륨을 만지려 해도
   * 다시 잠겨 버렸다 (world-scene.tsx 의 selector 주석). 이제 모드는 클릭이 아니라
   * **설정창이 열려 있는가**로만 갈린다.
   *
   * 잠금 요청은 사용자 제스처가 필요하다. 여기까지 온 건 「입장」 버튼을 누른
   * 직후라(크롬은 그 활성화를 몇 초 유지한다) 대개 받아준다. 연결이 오래 걸려
   * 거절당하면 잠기지 않은 채로 도크가 뜨고, 「게임으로」를 누르면 된다.
   */
  useEffect(() => {
    if (!live) return;
    const id = requestAnimationFrame(() => backToWalking());
    return () => cancelAnimationFrame(id);
  }, [live, backToWalking]);

  /*
   * ESC 는 스위치다.
   *   잠긴 상태  → 브라우저가 알아서 푼다. 그 해제를 위 효과가 '설정 열기'로 받는다.
   *   설정 열림  → 닫고 걷기로. (판은 잠금과 무관하게 **바로** 사라진다)
   *   둘 다 아님 → 입장 직후 잠금이 거절된 경우다. 여기서라도 설정을 열어 준다.
   * 입력창 안에서 누른 ESC 는 그 입력창이 처리한다 — 여기서 겹쳐 잡지 않는다.
   */
  useEffect(() => {
    if (!live) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const el = e.target as HTMLElement | null;
      if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable) return;
      if (locked) return;
      if (settingsOpen) backToWalking();
      else setSettingsOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [live, locked, settingsOpen, backToWalking]);

  return (
    <main className="relative h-screen w-full overflow-hidden bg-[#07050a]">
      {/*
        ★ 씬은 **입장이 실제로 끝난 뒤(live)** 에 마운트한다. 예전엔 ticket 이 오는
        순간(=아직 connecting, 입장 오버레이가 화면을 덮고 있는 동안) 마운트해서,
        스크린 카운트다운(warehouse.tsx COUNTDOWN_SEC)이 사용자가 보기도 전에
        흘러가 버렸다 — 연결이 조금만 걸려도 20→0 과 영상이 다 지나간 뒤에야 화면이
        보였다. live 로 미루면 세계가 나타나는 순간에 카운트다운이 20부터 시작된다.
      */}
      {live ? (
        <WorldScene conn={conn} spawn={spawn} onLockChange={setLocked} />
      ) : (
        <div className="h-full w-full bg-[#07050a]" />
      )}

      {/* 헤더 */}
      <header className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-4 p-6">
        <div>
          <Link
            href="/"
            className="pointer-events-auto text-xs text-neutral-500 transition-colors hover:text-neutral-200"
          >
            ← 작업 보드
          </Link>
          <h1 className="mt-2 text-2xl font-black tracking-tight text-neutral-200 drop-shadow-[0_2px_12px_rgba(0,0,0,0.9)]">
            3D 월드
          </h1>
          {ticket ? (
            <p className="mt-1 font-mono text-[11px] text-neutral-500">
              {ticket.room.code} · {ticket.self.nickname} · {ticket.room.capacity}인
              {ticket.role ? ` · ${ROLE_LABEL[ticket.role]}` : ''}
            </p>
          ) : null}
        </div>
        {/* 볼륨은 ESC 로 마우스를 푼 뒤 아래 도크에서 바로 조절한다 (창 없음) */}
        {live ? <StatusChip /> : null}
      </header>

      {/* 입장 패널 */}
      {!live ? (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <div className="w-full max-w-sm rounded-2xl bg-black/70 p-6 ring-1 ring-white/10 backdrop-blur">
            <h2 className="text-sm font-bold text-neutral-200">방에 들어가기</h2>
            <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
              같은 방 코드로 들어온 사람들이 같은 공간에서 서로를 봅니다. 빈자리는 채워집니다.
            </p>

            <div className="mt-4 flex gap-2">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 4))}
                placeholder="ABCD"
                className="w-28 rounded-lg bg-white/5 px-3 py-2 text-center font-mono text-sm tracking-[0.3em] text-neutral-100 ring-1 ring-white/15 outline-none focus:ring-amber-500/50"
              />
              <button
                type="button"
                disabled={busy || code.length !== 4}
                onClick={() => void enter(code)}
                className="flex-1 rounded-lg bg-amber-500/90 px-4 py-2 text-sm font-bold text-black transition-colors hover:bg-amber-400 disabled:opacity-40"
              >
                입장
              </button>
            </div>

            <button
              type="button"
              disabled={busy}
              onClick={() => void enter()}
              className="mt-2 w-full rounded-lg bg-white/10 px-4 py-2 text-sm font-bold text-neutral-200 transition-colors hover:bg-white/20 disabled:opacity-40"
            >
              새 방 만들기
            </button>

            {status === 'connecting' ? (
              <p className="mt-3 text-[11px] text-neutral-500">연결 중…</p>
            ) : null}
            {errorText ? (
              <p className="mt-3 text-[11px] leading-relaxed text-red-400">{errorText}</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {/*
        ┌─ 걸을 때와 만질 때를 나눈다 ─────────────────────────────────────────┐
        │ 마우스가 잠긴 동안(걷는 중)에는 판을 띄우지 않는다. 판이 떠 있으면    │
        │ 시야를 가리고, 무엇보다 **클릭이 판에 먹혀** 다시 걸을 수가 없다.     │
        │ ESC 로 마우스를 풀면 그때 아이콘이 나오고, 거기서 채팅과 소리를      │
        │ 소리를 만진다. ESC 를 한 번 더 누르거나 「게임으로」를 누르면 걷기로   │
        │ 돌아간다 — **화면 클릭으로는 돌아가지 않는다.** 설정을 만지는 클릭과   │
        │ 겹쳤기 때문이다. 즉 ESC 하나가 '조작 ↔ 설정' 스위치다.               │
        └──────────────────────────────────────────────────────────────────────┘
      */}
      {live ? (
        <>
          {/* 걷는 중에도 남의 말은 보여야 한다. 판이 아니라 글자만 흐른다 */}
          {!settingsOpen && messages.length > 0 ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-24 flex flex-col items-start gap-1 px-6">
              {messages.slice(-5).map((m) => (
                <p
                  key={m.key}
                  className="text-[12px] text-neutral-300 drop-shadow-[0_1px_4px_rgba(0,0,0,0.9)]"
                >
                  <span className="font-bold text-[#d4a373]">{m.nickname}</span>{' '}
                  <span className="text-neutral-200">{m.text}</span>
                </p>
              ))}
            </div>
          ) : null}

          {/* 마우스를 푼 동안의 판들 (볼륨은 창이 아니라 아래 도크에서 바로 조절한다) */}
          {settingsOpen ? (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-end justify-start gap-6 p-6 pb-24 pt-28">
              {chatOpen ? (
                <ChatPanel
                  messages={messages}
                  draft={draft}
                  inputRef={inputRef}
                  onDraft={setDraft}
                  onSend={send}
                  onClose={() => setChatOpen(false)}
                  onLeave={backToWalking}
                />
              ) : null}
            </div>
          ) : null}

          {/* 아래 가운데 — 상태와 스위치 */}
          <div className="absolute inset-x-0 bottom-6 z-30 flex justify-center">
            {!settingsOpen ? (
              <p className="rounded-full border border-white/10 bg-black/60 px-5 py-2.5 text-[12px] text-neutral-300 backdrop-blur">
                WASD 이동 · Shift 달리기 · Space 점프 ·{' '}
                <span className="text-[#d4a373]">ESC 로 대화 · 설정</span>
              </p>
            ) : (
              <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-white/10 bg-black/60 p-1.5 backdrop-blur">
                <DockButton
                  active={chatOpen}
                  onClick={() => setChatOpen((v) => !v)}
                  label="방 채팅"
                  badge={messages.length > 0 ? messages.length : undefined}
                >
                  <ChatIcon />
                </DockButton>
                <VolumeControl />
                {/*
                  걷기로 돌아가는 **유일한** 길. 화면 아무 데나 클릭해서 돌아가던
                  길은 없앴다 — 그 클릭이 설정을 만지는 손과 겹쳤다.
                */}
                <button
                  type="button"
                  onClick={backToWalking}
                  className="rounded-full px-3 py-1.5 text-[12px] font-bold text-neutral-300 transition-colors hover:bg-white/10 hover:text-white"
                >
                  게임으로 <span className="text-neutral-500">ESC</span>
                </button>
              </div>
            )}
          </div>
        </>
      ) : null}
    </main>
  );
}

/* ─────────────────────────────── 아래 스위치 ─────────────────────────────── */

function DockButton({
  active,
  onClick,
  label,
  badge,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  badge?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={`relative flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
        active ? 'bg-[#d4a373] text-black' : 'text-neutral-400 hover:bg-white/10 hover:text-white'
      }`}
    >
      {children}
      {badge ? (
        <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-[#d4a373] px-1 text-[9px] font-bold leading-4 text-black">
          {badge > 99 ? '99+' : badge}
        </span>
      ) : null}
    </button>
  );
}

/* ─────────────────────────────── 채팅 판 ─────────────────────────────── */

const PANEL = 'pointer-events-auto flex flex-col overflow-hidden rounded-xl border border-white/10 bg-[rgba(28,24,22,0.85)] shadow-2xl backdrop-blur-md';

function ChatPanel({
  messages,
  draft,
  inputRef,
  onDraft,
  onSend,
  onClose,
  onLeave,
}: {
  messages: { key: string; nickname: string; text: string }[];
  draft: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onDraft: (v: string) => void;
  onSend: () => void;
  onClose: () => void;
  /** 말하기를 끝내고 다시 걷기로 (ESC). Enter 는 보내기만 하고 머문다 */
  onLeave: () => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);

  // 새 말이 오면 아래로 붙인다. 위를 읽고 있었어도 방금 온 말은 봐야 한다
  useEffect(() => {
    const el = scroll.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  return (
    <div className={`${PANEL} h-[420px] w-full max-w-md`}>
      <header className="flex items-center justify-between border-b border-white/10 bg-black/20 px-5 py-3.5">
        <div className="flex items-center gap-3">
          <span className="text-[#d4a373]">
            <ChatIcon />
          </span>
          <h2 className="text-[15px] font-bold text-white">방 채팅</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="채팅 닫기"
          className="text-neutral-500 transition-colors hover:text-white"
        >
          <CloseIcon />
        </button>
      </header>

      <div ref={scroll} className="flex-1 overflow-y-auto p-5">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center opacity-60">
            <span className="mb-3 text-neutral-500">
              <ChatIcon size={34} />
            </span>
            <p className="text-[13px] text-neutral-400">아직 메시지가 없어요.</p>
            <p className="text-[13px] text-neutral-400">같은 방 사람들과 이야기해 보세요.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {messages.map((m) => (
              <div key={m.key} className="flex items-start gap-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-black/40 text-[11px] font-bold text-neutral-400">
                  {m.nickname.slice(-1)}
                </span>
                <div className="min-w-0">
                  <p className="mb-1 text-[11px] text-neutral-500">{m.nickname}</p>
                  <div className="rounded-lg rounded-tl-none border border-white/5 bg-black/40 px-3 py-2 text-[13px] leading-relaxed text-neutral-100">
                    {m.text}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-white/10 bg-black/30 p-4">
        <div className="relative">
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={(e) => {
              /*
                Enter 는 보내고 **대화창에 그대로 머문다** — 연달아 말할 수 있게
                마우스를 다시 잡지 않는다. 걷기로 돌아가려면 ESC 를 누르거나
                아래 「게임으로」를 누른다. 화면 클릭으로는 돌아가지 않는다.
              */
              if (e.key === 'Enter') {
                e.preventDefault();
                onSend();
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                onLeave();
              }
            }}
            maxLength={200}
            placeholder="메시지 입력 후 Enter · ESC 로 걷기"
            className="w-full rounded-lg border border-white/10 bg-black/50 py-3 pl-4 pr-11 text-[13px] text-white outline-none transition-colors placeholder:text-neutral-600 focus:border-[#d4a373]"
          />
          <button
            type="button"
            onClick={onSend}
            aria-label="보내기"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 transition-colors hover:text-[#d4a373]"
          >
            <SendIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────── 볼륨 ─────────────────────────────── */

/**
 * 도크에 바로 붙는 볼륨 조절기. **창을 열지 않는다** — 곡이 하나뿐이라
 * 목록·재생상태를 보여줄 판이 필요 없다. 음소거 토글 + 슬라이더가 전부다.
 * (곡이 여러 개가 되면 그때 판을 되살린다. music.ts 가 파일을 쥔다.)
 *
 * 볼륨은 useSyncExternalStore 로 music.ts 에서 직접 읽는다 — React 상태로
 * 복제하지 않아 다른 곳에서 setVolume 해도 여기 슬라이더가 같이 움직인다.
 */
function VolumeControl() {
  const volume = useSyncExternalStore(musicSubscribe, getMusicVolume, () => 0.45);

  return (
    <div className="flex items-center gap-2 pl-1.5 pr-1">
      <button
        type="button"
        onClick={() => setMusicVolume(volume > 0 ? 0 : 0.45)}
        aria-label={volume > 0 ? '음소거' : '소리 켜기'}
        className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-white/10 hover:text-white"
      >
        {volume > 0 ? <VolumeIcon /> : <MuteIcon />}
      </button>
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(volume * 100)}
        aria-label="음악 볼륨"
        onChange={(e) => setMusicVolume(Number(e.target.value) / 100)}
        className="h-1.5 w-24 cursor-pointer appearance-none rounded-full bg-white/15 accent-[#d4a373]"
      />
    </div>
  );
}

/* ─────────────────────────────── 아이콘 ─────────────────────────────── */
/* CDN(font-awesome) 대신 인라인 SVG — 배포본에서 외부 요청이 나가지 않는다 */

function ChatIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M14 9.5a2 2 0 01-2 2H5l-3 2.5V4a2 2 0 012-2h8a2 2 0 012 2v5.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function VolumeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3 6h2.5L9 3v10L5.5 10H3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M11.5 5.5a3.5 3.5 0 010 5M13.4 3.6a6 6 0 010 8.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function MuteIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3 6h2.5L9 3v10L5.5 10H3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M11.5 6l3 4M14.5 6l-3 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden>
      <path d="M1 1l11 11M12 1L1 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M15 1L7.5 8.5M15 1l-5 14-2.5-6.5L1 6l14-5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

/** 지금 방에 몇 명이 보이는지. 좌표가 아니라 **멤버십**만 구독한다 */
function StatusChip() {
  const version = useWorldStore((s) => s.playersVersion);
  const count = useWorldStore((s) => s.players.size);
  void version;
  return (
    <div className="rounded-full bg-black/50 px-3 py-1.5 font-mono text-[11px] text-neutral-300 backdrop-blur">
      함께 있는 사람 {count + 1}
    </div>
  );
}

function errorMessage(code: string): string {
  switch (code) {
    case 'version_mismatch':
      return '워커와 클라이언트의 프로토콜 버전이 다르다. 워커를 먼저 배포할 것 (worker/README.md)';
    case 'unauthorized':
      return '이 방의 자리가 아니다. 다시 입장할 것';
    case 'room_full':
      return '방이 가득 찼다';
    case 'room_unavailable':
      return '워커가 좌석 명단을 못 받았다. NEXT_ORIGIN이 밖에서 닿는 주소인지 확인하고 다시 배포할 것 (npm run world:deploy)';
    case 'connection_failed':
      return '월드 서버에 붙지 못했다. 워커가 떠 있는지 확인할 것 (npm run world:dev)';
    default:
      return code;
  }
}
