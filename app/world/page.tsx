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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { spawnFor } from '@/lib/mp/spawn';
import type { Role } from '@/lib/game/types';
import { WorldConnection, type WorldEvents } from './net/connection';
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

export default function WorldPage() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [locked, setLocked] = useState(false);
  const [draft, setDraft] = useState('');

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
      onMoved: (id, x, z, heading, anim) =>
        useWorldStore.getState().applyMove(id, x, z, heading, anim, performance.now()),
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

  // 잠금 중에 Enter를 누르면 마우스를 풀고 입력창으로 보낸다.
  // 포인터 락 상태에서는 input에 포커스를 줄 수 없다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Enter' || !locked) return;
      e.preventDefault();
      document.exitPointerLock();
      // 락 해제가 끝난 뒤에 포커스를 준다
      setTimeout(() => inputRef.current?.focus(), 0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [locked]);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    conn.sendChat(text);
    setDraft('');
  }, [conn, draft]);

  const spawn = useMemo(
    () => (ticket ? spawnFor(ticket.self.seat, ticket.room.capacity) : { x: 0, z: 0 }),
    [ticket],
  );

  const live = status === 'live' && ticket !== null;

  return (
    <main className="relative h-screen w-full overflow-hidden bg-[#07050a]">
      {ticket ? (
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

      {/* 채팅 */}
      {live ? (
        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 p-5">
          <div className="pointer-events-none flex max-h-40 flex-col justify-end gap-1 overflow-hidden">
            {messages.slice(-6).map((m) => (
              <p key={m.key} className="text-[12px] text-neutral-300 drop-shadow-[0_1px_4px_rgba(0,0,0,0.9)]">
                <span className="font-bold text-amber-300">{m.nickname}</span>{' '}
                <span className="text-neutral-200">{m.text}</span>
              </p>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                send();
              }}
              maxLength={200}
              placeholder={locked ? 'Enter — 말하기' : '메시지를 입력하고 Enter'}
              className="max-w-md flex-1 rounded-full bg-black/60 px-4 py-2 text-[13px] text-neutral-100 ring-1 ring-white/15 outline-none backdrop-blur focus:ring-amber-500/50"
            />
            <p className="rounded-full bg-black/40 px-3 py-1.5 text-[11px] text-neutral-400 backdrop-blur">
              {locked ? 'WASD 이동 · Shift 달리기 · ESC 마우스 풀기' : '화면을 클릭하면 걸어다닙니다'}
            </p>
          </div>
        </div>
      ) : null}
    </main>
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
