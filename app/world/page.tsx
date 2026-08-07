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
 *
 * 조작은 전부 키다 — WASD·Shift·Space 로 움직이고, Enter 로 말하고, M·−·+ 로
 * 소리를 맞춘다. **열고 닫는 판이 없다** (아래 「판은 없다」 상자).
 */

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { WORLD_SEAT_SLOTS, isMovementLocked, mayChat } from '@/lib/mp/constants';
import { spawnFor } from '@/lib/mp/spawn';
import type { Role } from '@/lib/game/types';
import { WorldConnection, type WorldEvents } from './net/connection';
import GameHud, { ChatTranscript, SeatNotes } from './game-hud';
import {
  getVolume as getMusicVolume,
  setVolume as setMusicVolume,
  subscribe as musicSubscribe,
} from './music';
import { playTopicVoice, stopTopicVoice } from './topic-voice';
import { useWorldStore } from './store';
import { useQueryClient } from '@tanstack/react-query';

import { matchHistoryKey, profileStatsKey } from '@/lib/queries/keys';
import { roleCardOpen, useRoundtableStore } from './roundtable-store';
import { setActiveRoom, clearActiveRoom } from './active-room';

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

/** 소리 한 칸. 0.05 면 0→100 이 스무 번이라 길게 누르면 금방 닿는다 */
const VOLUME_STEP = 0.05;

/** 0~1 안에서 한 칸 움직인다. 부동소수 찌꺼기가 쌓이지 않게 두 자리에서 자른다 */
function step(current: number, delta: number): number {
  return Math.round(Math.min(1, Math.max(0, current + delta)) * 100) / 100;
}

/**
 * 화면 아래로 흐르는 대화 줄 수. 끝까지 읽는 건 ChatTranscript 가 맡는다.
 *
 * 8명이 한 바퀴 도는 동안 앞사람 말이 안 밀려 나가는 최소치가 이 근처다.
 * 더 늘리면 3D 화면이 글자에 묻힌다 — 오래된 줄을 흐리게 하는 것도 그래서다.
 */
const AMBIENT_LINES = 12;

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

/** 캔버스가 DOM 에 나타나기를 기다리는 간격 · 횟수 (≈5초) */
const CANVAS_WAIT_MS = 120;
const CANVAS_WAIT_TRIES = 40;

/**
 * 마우스를 잡는다. 실패하면 잠시 뒤 다시 두드린다.
 *
 * ★ 캔버스가 **아직 없을 수 있다.** 씬은 dynamic import 라, `live` 가 된 뒤에도
 *   청크(three.js)가 도착하기 전까지 화면에 있는 건 로딩 문구뿐이고 <canvas> 는
 *   없다. 예전엔 여기서 그냥 돌아갔고 재시도도 없었다 — 그래서 **처음 입장한
 *   사람만** 잠금 요청이 한 번도 나가지 않아 걷지도(이동키는 잠금 상태를 본다)
 *   시야를 돌리지도 못했다. 두 번째부터는 청크가 캐시돼 멀쩡했으므로 재현이
 *   "처음 한 번"으로만 보였다. 이제 캔버스가 생길 때까지 짧게 기다린다.
 *
 * ★ 크롬은 **ESC 로 사용자가 직접 푼 잠금**을 곧바로 다시 잡아주지 않는다
 *   (대략 1.25초). 그 사이 요청은 pointerlockerror 로 조용히 튕긴다. 한 번만
 *   요청하면 "ESC 를 눌렀는데 안 돌아간다"가 되므로, 튕길 때마다 간격을 두고
 *   두 번 더 시도한다. 그래도 안 되면 화면은 이미 걷기 모드고(키 조작은 된다)
 *   시야만 안 돌아간다 — 그때는 화면을 한 번 클릭하면 된다.
 */
/**
 * 이 문서에서 잠금을 한 번이라도 잡아 봤는가. 크롬은 그 뒤로는 클릭 제스처 없이도
 * (짧은 쿨다운만 지나면) 되잡게 해 준다 — 아래 「뻔한 거절」 판정에 쓴다.
 */
let hasLockedOnce = false;

function requestLock(tries = 3, delayMs = 1400, waitTries = CANVAS_WAIT_TRIES): void {
  const canvas = document.querySelector('canvas');
  if (!canvas) {
    if (waitTries > 0) {
      window.setTimeout(() => requestLock(tries, delayMs, waitTries - 1), CANVAS_WAIT_MS);
    }
    return;
  }
  // 이미 잡혀 있으면 다시 두드리지 않는다 (걷는 중의 클릭이 여기로도 온다)
  if (document.pointerLockElement === canvas) return;

  /*
   * ★ 거절이 뻔한 요청은 보내지 않는다. 클릭 제스처(transient activation)가 만료됐고
   *   이 문서에서 잠금을 잡아 본 적도 없으면 브라우저는 반드시 거절하는데, 그때마다
   *   three(PointerLockControls)가 콘솔에 "Unable to use Pointer Lock API" 에러를
   *   찍는다. 특히 첫 입장의 자동 잠금이 그렇다 — 개발 서버는 청크 컴파일이 길어서
   *   입장 클릭의 제스처가 로딩 중에 만료된다. 이 경우의 복구는 어차피 화면 클릭뿐이고
   *   그 클릭이 다시 이리로 오므로, 조용히 물러나도 잃는 것이 없다.
   *   (userActivation 이 없는 브라우저는 예전처럼 일단 두드린다.)
   */
  const activation = navigator.userActivation;
  if (activation && !activation.isActive && !hasLockedOnce) return;

  const onError = () => {
    document.removeEventListener('pointerlockchange', onSettled);
    if (tries > 1) window.setTimeout(() => requestLock(tries - 1, delayMs), delayMs);
  };
  const onSettled = () => {
    document.removeEventListener('pointerlockerror', onError);
    if (document.pointerLockElement) hasLockedOnce = true;
  };
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

/*
 * 정원 선택은 없앴다 (2026-08-06 결정). 모든 방이 **사람 8자리 + 시작할 때 AI 1대**라
 * 고를 것이 없다 — 서버가 정한다 (lib/game/rules.ts 의 MAX_HUMANS_PER_ROOM).
 * 화면마다 두던 정원 범위 복사본도 같이 사라졌다.
 */

/**
 * 결과(reveal)가 뜬 뒤 **자동으로 방을 접고 로비(/main)로 나가기까지**의 시간(ms).
 * 결과 오버레이가 한 겹씩 열리는 시간(game-hud 의 REVEAL_STEP_MS × 3 ≈ 2.7초)을
 * 읽을 여유를 준다.
 *
 * ★ 이 사이 「한 판 더」를 누르면 서버가 새 판(topic)을 쏘고 reveal 이 비워지므로
 *   (roundtable-store 의 applyRound), 아래 타이머 효과가 정리돼 **삭제가 취소된다** —
 *   그래서 재대국과 자동 삭제가 부딪히지 않는다.
 */
const RESULT_TO_LOBBY_MS = 12_000;

export default function WorldPage() {
  const router = useRouter();
  const [code, setCode] = useState('');
  /** 새 방 이름 — **이 이름이 곧 입장 코드다** (lib/server/room.ts codeFromName). 비우면 랜덤 4자 */
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [locked, setLocked] = useState(false);
  /**
   * 이 방에서 **한 번이라도 잠금을 잡은 적이 있나.**
   *
   * ┌─ 「화면을 클릭하면 계속」을 언제 띄우는가 (사용자 결정 2026-08-06) ────────┐
   * │ 이 안내는 두 상황에서 같이 떴다:                                           │
   * │   ① ESC 로 잠깐 멈춘 상태 — 안내가 필요하다. 왜 멈췄는지 알려줘야 한다.     │
   * │   ② **막 들어온 순간** — 브라우저가 자동 잠금을 거절하면(다른 페이지에서    │
   * │      넘어온 새 문서라 사용자 조작이 없다) 들어서자마자 이 문구가 뜬다.       │
   * │                                                                          │
   * │ ②는 "접속했는데 안내문부터 본다"라 걷어낸다. 잠금은 그대로 시도하고(대개    │
   * │ 성공한다), 거절돼도 **아무 데나 클릭하면 조용히 잡힌다** — 클릭 경로는       │
   * │ 그대로 살아 있으므로 동작이 줄지는 않는다.                                 │
   * │                                                                          │
   * │ 그래서 안내의 조건을 "지금 안 잠겼다"가 아니라 **"잡았다가 풀렸다"** 로      │
   * │ 바꾼다. 그게 곧 ①이다.                                                    │
   * └──────────────────────────────────────────────────────────────────────────┘
   */
  const [everLocked, setEverLocked] = useState(false);
  const [draft, setDraft] = useState('');
  /**
   * 캔버스가 실제로 DOM 에 붙었는가. `status === 'live'` 는 **welcome 이 왔다**는
   * 뜻일 뿐이고, 씬 청크는 그 뒤에 도착한다. 잠금은 이 값을 보고 건다.
   */
  const [sceneReady, setSceneReady] = useState(false);
  /**
   * 한 마디 하는 중인가 (걷기 안의 '말하기' 모드).
   *
   * ★ **잠금을 그대로 둔 채** 입력줄에 포커스만 준다. 포인터 잠금은 마우스만
   *   잡고 키보드는 잡지 않으므로, 잠긴 상태에서 <input> 에 포커스를 줘도
   *   타이핑이 되고 **시야도 계속 돈다** (실측: focus 후에도 pointerLockElement 유지).
   *   그래서 말 한 마디에 모드가 바뀌지 않고, requestLock 을 다시 부를 일도 없다
   *   — 크롬의 재잠금 거절·쿨다운이 대화 경로에서 통째로 빠진다.
   *   대신 타이핑 중에는 다리가 멈춘다 (WASD 가 글자로 들어가니 어쩔 수 없다).
   */
  const [composing, setComposing] = useState(false);
  /** 볼륨을 방금 건드렸다 — 잠깐 떴다 사라지는 표시용 (VolumeHud) */
  const [volumeHud, setVolumeHud] = useState(false);
  /** 헤더의 「현재 방에서 퇴장하기」를 눌렀다 — 실수 방지로 한 번 더 묻는다 */
  const [confirmLeave, setConfirmLeave] = useState(false);
  /**
   * 로비에서 「게임 시작」으로 넘어온 흐름인가 (`/world?code=`). 이때는 입장 패널
   * (방 만들기·정원 카드)을 띄우지 않는다 — 이미 방이 정해졌으니 **로딩 표시**만
   * 보이고 곧장 3D 월드로 들어간다. 라운지(코드 없이 /world 직접 방문)는 false 라
   * 예전처럼 입장 패널이 뜬다.
   */
  const [gameFlow, setGameFlow] = useState(false);

  const status = useWorldStore((s) => s.status);
  const errorText = useWorldStore((s) => s.errorText);
  const messages = useWorldStore((s) => s.messages);

  const connRef = useRef<WorldConnection | null>(null);
  if (connRef.current === null) connRef.current = new WorldConnection();
  const conn = connRef.current;
  /** 전적 캐시를 걷는 데만 쓴다 (onReveal). 서버 값 구독은 이 화면엔 없다 */
  const qc = useQueryClient();
  /** 걷는 중에 뜨는 한 줄 입력 */
  const lineRef = useRef<HTMLInputElement>(null);

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
      onGate: (gate) => useRoundtableStore.getState().applyGate(gate),
      onRound: (round) => useRoundtableStore.getState().applyRound(round),
      onVoteProgress: (voted, total) => useRoundtableStore.getState().applyProgress(voted, total),
      onEliminated: (id) => useRoundtableStore.getState().applyEliminated(id),
      onReveal: (reveal) => {
        useRoundtableStore.getState().applyReveal(reveal);
        // 이 판이 방금 전적에 적혔다 (워커 → /api/internal/world-match). 로비·기록
        // 화면이 다음에 뜰 때 낡은 캐시(staleTime 60초)를 그대로 쓰지 않게 걷는다 —
        // 지우기만 하고 다시 읽는 건 그 화면이 뜰 때다.
        void qc.invalidateQueries({ queryKey: profileStatsKey });
        void qc.invalidateQueries({ queryKey: matchHistoryKey });
      },
      onRole: (role) => useRoundtableStore.getState().setMyRole(role),
      onError: (codeText) =>
        useWorldStore.getState().setStatus('error', errorMessage(codeText)),
      onClose: () => useWorldStore.getState().setStatus('error', '연결이 끊겼다'),
    }),
    [qc],
  );

  const enter = useCallback(
    async (roomCode?: string) => {
      setBusy(true);
      try {
        // 방을 옮길 때는 이전 방 상태를 전부 지운다. 안 지우면 새 방에 새어 나온다
        conn.close();
        setSceneReady(false);
        setComposing(false);
        // 새 방은 다시 "처음 접속"이다 — 들어서자마자 안내문이 뜨면 안 된다 (everLocked)
        setEverLocked(false);
        useWorldStore.getState().reset();
        useRoundtableStore.getState().reset();
        useWorldStore.getState().setStatus('connecting');

        const trimmedName = newName.trim();
        const room = roomCode
          ? await postJson<{ room: { id: string } }>('/api/room/join', { code: roomCode.toUpperCase() })
          : await postJson<{ room: { id: string } }>('/api/room', {
              // 이름을 지었으면 그 이름이 곧 입장 코드가 된다. 겹치면 409 가 그대로 뜬다.
              ...(trimmedName ? { name: trimmedName } : null),
            });

        const t = await postJson<Ticket>('/api/world/ticket', { room_id: room.room.id });
        setTicket(t);
        setCode(t.room.code);
        useWorldStore.getState().setSelf(t.self.id, {
          seat: t.self.seat,
          nickname: t.self.nickname,
          maskId: t.self.mask_id,
        });
        conn.connect(t.ws_url, t.room.id, t.ticket, events);
        // 이 방에 붙었다고 남긴다 — 뒤로가기·퇴장으로 나가도 로비가 여기로 되돌린다
        // (CEO 결정 2026-08-06, active-room.ts). endGameToLobby 가 판 끝에 지운다.
        setActiveRoom(t.room.code);
      } catch (e) {
        // 재입장이 실패했다(방이 이미 삭제됐거나 코드가 틀렸다). 기록을 지워
        // 로비가 죽은 방으로 무한히 되돌리지 않게 한다.
        clearActiveRoom();
        useWorldStore.getState().setStatus('error', e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    // newName 이 바뀌면 enter 도 바뀐다 — 자동 입장 효과는 ref 가드가 재진입을 막는다
    [conn, events, newName],
  );

  useEffect(() => () => conn.close(), [conn]);

  /**
   * `/world?code=ABCD` — 방 목록(/main)에서 넘어온 자동 입장.
   *
   * · 자리는 로비가 이미 배정했다(/api/room/join). 여기 enter 의 join 은 같은
   *   쿠키로 원래 자리를 돌려받는 재입장(200)이라 두 번 불러도 안전하다.
   * · useSearchParams 대신 location.search 를 읽는다 — 이 페이지는 전부 클라이언트
   *   상호작용이라 Suspense 경계를 새로 파느니 마운트 때 한 번 읽는 게 맞다.
   * · ref 가드는 StrictMode 의 이중 실행 방지다. 「새로운 게임 시작하기」로 나온
   *   뒤에도 주소에 code 가 남지만, 이 가드 덕에 다시 끌려 들어가지 않는다.
   */
  const autoEntered = useRef(false);
  useEffect(() => {
    if (autoEntered.current) return;
    const fromList = new URLSearchParams(window.location.search).get('code');
    // 코드는 이제 방 이름일 수 있다 — "4자" 검사를 버리고 비었는지만 본다.
    const normalized = fromList?.replace(/\s+/g, '').toUpperCase() ?? '';
    if (!normalized) return;
    autoEntered.current = true;
    setGameFlow(true); // 로비에서 넘어온 흐름 — 입장 패널 대신 로딩 표시를 띄운다
    setCode(normalized);
    void enter(normalized);
  }, [enter]);

  /** 세계가 실제로 떠 있는가. 아래 효과들이 전부 이 값을 본다 (선언이 먼저여야 한다) */
  const live = status === 'live' && ticket !== null;

  /*
   * ┌─ 패널이 뜨면 커서를 돌려준다 ──────────────────────────────────────────┐
   * │                                                                        │
   * │ 위 「판은 없다」 상자가 적어 둔 성질을 **판이 도는 동안에만** 깬다:      │
   * │ 만질 것이 화면에 있으면 잠금을 풀어야 하고, 잠금을 풀면 게임이 멈춘다.  │
   * │                                                                        │
   * │ ★ 잠금을 안 풀면 **게임이 통째로 안 돌아간다.** 잠긴 동안에는 커서가    │
   * │   없어서 좌석 카드를 누를 수가 없다(채팅이 잠금을 유지한 채 되는 건     │
   * │   포인터 잠금이 키보드를 잡지 않기 때문이고, 클릭에는 그 면제가 없다).  │
   * │                                                                        │
   * │ 그래서 아래 네 군데가 전부 이 값을 봐야 한다. 하나라도 빠지면 커서가    │
   * │ 눌리자마자 다시 사라진다:                                              │
   * │   ① 이 효과        — 열릴 때 exitPointerLock, 닫힐 때 되잡기            │
   * │   ② 캔버스 클릭    — 세계를 한 번 누르면 다시 잠기던 경로               │
   * │   ③ 자동 잠금      — live && sceneReady 로 한 번 거는 경로              │
   * │   ④ 말하기 취소    — composing 이 풀릴 때 되잡던 두 경로                │
   * └────────────────────────────────────────────────────────────────────────┘
   *
   * ┌─ ★★ 단계 목록을 여기 손으로 적지 않는다 (I1) ──────────────────────────┐
   * │ 예전 이 줄은 `phase === 'vote' || phase === 'verdict' || reveal !== null`│
   * │ 이었다. 그때 목록에서 빠진 단계 하나 때문에 워커는 봇을 세우는데 사람만  │
   * │ 걸어다니는 구간이 생겼고, player_moved 가 한 번이라도 나온 자리는 사람   │
   * │ 확정이었다 — 총 자리·AI 수가 공개라 소거법으로 전 좌석이 갈린다.        │
   * │                                                                        │
   * │ 그래서 목록은 lib/mp/constants.ts 의 MOVEMENT_LOCKED_PHASES 하나뿐이고   │
   * │ 워커와 여기가 **같이 읽는다.** 이 파일에 단계 이름을 다시 적지 마라.     │
   * │                                                                        │
   * │ ★ **defense 는 이 목록에 없다** — 커서를 되잡아 카메라·이동을 연다.      │
   * │   변론을 듣는 20초가 정지 화면이 되지 않게 한 것이고, 사람과 봇이 **같이**│
   * │   걸으므로 비대칭도 안 생긴다. 다만 **지목된 본인은 못 걷는다** — 그건   │
   * │   단계가 아니라 좌석 단위 판정이라 여기(화면 전체 잠금)가 아니라         │
   * │   world-scene.tsx 의 mayMove 가 맡는다. 지목자도 커서는 잠긴 채라        │
   * │   둘러보며 변론을 칠 수 있다.                                           │
   * │                                                                        │
   * │ ★ reveal 결과가 도착한 뒤(`revealResult`)에도 연다 — 오버레이가 화면을   │
   * │   덮는 동안 커서가 없으면 아무것도 못 만진다. 그때는 이미 전 좌석의      │
   * │   정체가 공개된 뒤라 사람만 멈춰 있어도 숨길 것이 남아 있지 않다.        │
   * │   반대로 abortRound 로 끝난 판(reveal 이 안 온다)은 여기가 false 가 되고 │
   * │   워커의 봇 루프도 'ended' 를 빼 두었으므로 양쪽 다 걷는다 — 대칭.       │
   * └────────────────────────────────────────────────────────────────────────┘
   */
  const phase = useRoundtableStore((s) => s.phase);
  const nomineeId = useRoundtableStore((s) => s.nomineeId);
  const revealResult = useRoundtableStore((s) => s.reveal);
  /** 주제 공개 안내(음성 + 기록 한 줄)에만 쓴다 — 아래 「주제가 열리면」 효과 */
  const topicRound = useRoundtableStore((s) => s.round);
  const topicEndsAt = useRoundtableStore((s) => s.endsAt);
  /**
   * 역할 카드가 떠 있는가 — 뜨는 조건은 roundtable-store 의 셀렉터 **하나**다
   * (game-hud 의 RoleCard 와 같은 것을 본다). 카드에는 「확인」 버튼이 있어서
   * topic 처럼 잠금이 없는 단계에도 커서를 돌려줘야 한다 — 안 돌려주면 커서가
   * 없어 누를 수가 없다 (아래 상자의 좌석 카드와 같은 이유).
   */
  const cardOpen = useRoundtableStore(roleCardOpen);
  const uiOpen = live && (isMovementLocked(phase) || revealResult !== null || cardOpen);

  /**
   * 지금 내가 말할 수 있는가. 워커의 채팅 게이트와 **같은 함수**로 판정한다 (I1) —
   * 여기서만 막으면 소켓으로 우회되고, 워커에서만 막으면 입력줄이 열렸는데 말이
   * 안 나가는 게 된다. defense 의 지목된 본인은 예외다 (mayChat 의 상자).
   */
  const selfId = useWorldStore((s) => s.selfId);
  const canSpeak = live && mayChat(phase, selfId !== null && selfId === nomineeId);

  /*
   * ★ 걷는 중에는 입력창에 포커스를 **준다.** 예전에는 "포커스를 강제하면 카메라를
   *   못 돌린다"고 봤는데 그건 사실이 아니었다 — 포인터 잠금은 마우스만 잡고
   *   키보드는 잡지 않는다. 잠긴 채로 포커스를 줘도 잠금은 유지되고 시야도 돈다.
   *   말을 걸려면 클릭이 필요했던 이유가 여기서 사라진다(애초에 잠긴 동안에는
   *   커서가 없어서 클릭 자체가 불가능했다). 이제 Enter·T 로 연다.
   *   "몸이 걸어다니는" 문제는 잠금이 아니라 composing 으로 막는다
   *   — world-scene.tsx 의 LocalRig 가 말하는 동안 이동키를 무시한다.
   */

  /*
   * 브라우저가 잠금을 **풀었다** = 사용자가 ESC 를 눌렀다.
   * (잠금 해제는 ESC 말고는 일어나지 않는다 — 클릭으로 풀지 않는다.)
   *
   * ★ 이때 **판을 열지 않는다.** 예전에는 여기서 설정판이 떴는데, 설정판이 하던
   *   일이 이제 전부 걷는 중에 된다 — 대화는 Enter 한 줄, 소리는 M·−·+.
   *   그래서 ESC 는 '설정 열기'가 아니라 그냥 **잠깐 멈춤**이다. 화면을 클릭하면
   *   이어서 걷는다. 판이 사라지면서 "판을 만지는 클릭 vs 다시 잠그는 클릭"이라는
   *   해묵은 충돌도 같이 없어졌다 (commit 68c947d 가 클릭 경로를 지웠던 이유).
   *
   * 말하던 중이었다면 그 한 마디를 무른다. 잠금 중의 ESC 는 keydown 이 페이지로
   * 오지 않으므로(브라우저가 먹는다) '취소'를 키가 아니라 **해제 자체**로 받는다.
   *
   * ★ '풀렸다'는 **변화**지 상태가 아니다. `!locked` 로만 보면, 애초에 잠기지 않은
   *   채로(자동 잠금이 거절됐거나 멈춤 상태에서) Enter 를 눌러 입력줄을 연 순간
   *   이 효과가 그걸 곧바로 취소해 버린다 — 아무리 눌러도 안 열린다. 실제로
   *   브라우저에서 그렇게 나왔다. 그래서 직전 값과 비교해 **떨어지는 순간**만 잡는다.
   */
  // 한 번 잡히면 이 방을 나갈 때까지 참이다 (everLocked 의 상자).
  useEffect(() => {
    if (locked) setEverLocked(true);
  }, [locked]);

  const wasLocked = useRef(false);
  useEffect(() => {
    const justUnlocked = wasLocked.current && !locked;
    wasLocked.current = locked;
    if (!justUnlocked || !composing) return;
    setComposing(false);
    setDraft('');
    // ④ 패널이 떠 있으면 되잡지 않는다. 여기서 되잡으면 우리가 방금 푼 잠금을
    //    스스로 다시 걸어 커서가 사라진다 — 투표 패널이 눌리지 않는 그 증상이다.
    if (!uiOpen) requestLock();
  }, [locked, composing, uiOpen]);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    conn.sendChat(text);
    setDraft('');
  }, [conn, draft]);

  /**
   * 한 줄 입력에서 보낸다. 판과 달리 **보내고 바로 닫는다** — 한 마디 하고 다시
   * 걷는 게 이 모드의 전부다. 잠금은 애초에 놓은 적이 없으니 되잡을 것도 없다.
   * 빈 줄에서 Enter 를 치면 그냥 닫힌다(취소).
   */
  const sendLine = useCallback(() => {
    send();
    setComposing(false);
    lineRef.current?.blur();
  }, [send]);

  /** 걷기로 (되)돌아간다. 잠금이 거절돼도 화면은 그대로고, requestLock 이 더 두드린다 */
  const resumeWalking = useCallback(() => {
    requestLock();
  }, []);

  /*
   * 표를 던진다.
   *
   * ★ **소켓에 실제로 나갔을 때만** 화면에 확정한다. 서버는 "네 표를 받았다"를
   *   좌석 단위로 되돌려 주지 않는다 — 그런 메시지를 만드는 순간 그게 I1 누출이다
   *   (안 낸 자리가 드러난다). 그래서 sendVote 의 반환값이 내 선택 표시의
   *   유일한 근거다. 연결이 끊겨 있으면 아무 표시도 하지 않는 게 맞다.
   */
  const castVote = useCallback(
    (targetId: string) => {
      if (conn.sendVote(targetId)) useRoundtableStore.getState().setMyVote(targetId);
    },
    [conn],
  );

  const castVerdict = useCallback(
    (guilty: boolean) => {
      if (conn.sendVerdict(guilty)) useRoundtableStore.getState().setMyVerdict(guilty);
    },
    [conn],
  );

  /**
   * 방을 떠나 입장 패널로 돌아간다 — 결과 화면의 「새로운 게임 시작하기」가 쓴다.
   * 헤더의 「현재 방에서 퇴장하기」도 이 정리를 거친 뒤 방 목록(/main)으로 나간다 —
   * 스토어가 전역이라 reset 없이 떠나면 다음 /world 방문에 이전 방 상태가 샌다.
   *
   * `enter` 첫머리의 정리 순서와 같다 — conn.close() 가 핸들러를 먼저 떼므로
   * (connection.ts close) "연결이 끊겼다" 오류가 입장 패널에 새지 않고,
   * 스토어 reset 이 status 를 'idle' 로 되돌려 패널이 깨끗하게 뜬다.
   * `code` 는 남겨 둔다 — 같은 방으로 바로 되돌아갈 수 있게.
   */
  const leave = useCallback(() => {
    setConfirmLeave(false);
    conn.close();
    // 울리던 주제 안내가 로비까지 따라가지 않게 한다 (배경 음악은 stopMusic 이 맡는다)
    stopTopicVoice();
    setSceneReady(false);
    setComposing(false);
    setTicket(null);
    setEverLocked(false);
    // 입장 패널로 돌아가는 길이므로 게임 흐름 플래그를 내린다 — 안 내리면 로딩 표시에 갇힌다
    setGameFlow(false);
    useWorldStore.getState().reset();
    useRoundtableStore.getState().reset();
  }, [conn]);

  /**
   * 판이 끝났다 — **게임했던 방을 지우고** 로비(/main)로 나간다 (CEO 결정).
   * 결과 오버레이의 「새로운 게임 시작하기」와, 아래 결과 후 자동 복귀가 함께 쓴다.
   *
   * ★ 헤더의 「현재 방에서 퇴장하기」(leave)와 다르다 — 그건 **판 도중** 나가기라
   *   방을 남긴다(다른 사람이 계속 논다). 여기는 판이 끝난 방이라 접는다.
   * ★ 방 삭제는 곁다리다: 실패해도(이미 남이 지웠든, 네트워크가 끊겼든) 로비로는
   *   나간다. 여러 사람이 동시에 부르므로 /api/room/delete 는 멱등이다.
   * ★ leave() 가 ticket 을 비우므로 room_id 는 그 전에 읽어 둔다.
   */
  const endGameToLobby = useCallback(() => {
    const roomId = ticket?.self.room_id ?? null;
    if (roomId) {
      void fetch('/api/room/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ room_id: roomId }),
      }).catch(() => {});
    }
    // 판이 끝난 방이다 — 자동 재입장 기록을 지운다. 안 지우면 로비가 방금 접은
    // 방으로 되돌린다 (active-room.ts, CEO 결정 2026-08-06).
    clearActiveRoom();
    leave();
    router.push('/main');
  }, [ticket, leave, router]);

  /**
   * 결과가 뜨면 몇 초 뒤 자동으로 방을 접고 로비로 나간다 (CEO 결정).
   * ★ revealResult 가 채워졌을 때만 건다. 새 판이 열리면 reveal 이 null 로 돌아가
   *   이 효과가 정리(clearTimeout)되므로 삭제가 취소된다.
   *   「한 판 더」 버튼은 2026-08-07 에 뺐지만(game-hud 의 RevealOverlay 상자) 이
   *   가드는 남긴다 — 프로토콜의 rematch 경로가 살아 있어 새 판은 여전히 올 수 있다.
   */
  useEffect(() => {
    if (!live || !revealResult) return;
    const id = window.setTimeout(() => endGameToLobby(), RESULT_TO_LOBBY_MS);
    return () => window.clearTimeout(id);
  }, [live, revealResult, endGameToLobby]);

  /** 확인 오버레이는 ESC 로도 닫힌다 — 잠금이 풀린 상태라 keydown 이 페이지로 온다 */
  useEffect(() => {
    if (!confirmLeave) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConfirmLeave(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmLeave]);

  const spawn = useMemo(
    // 워커와 **같은 값으로** 나눠야 내 자리와 남이 보는 내 자리가 맞는다
    // (lib/mp/constants.ts 의 WORLD_SEAT_SLOTS 상자).
    () => (ticket ? spawnFor(ticket.self.seat, WORLD_SEAT_SLOTS) : { x: 0, z: 0 }),
    [ticket],
  );

  /*
   * 들어오면 **바로 걷는다.**
   *
   * 잠금 요청은 사용자 제스처가 필요하다. 여기까지 온 건 「입장」 버튼을 누른
   * 직후라(크롬은 그 활성화를 몇 초 유지한다) 대개 받아준다. 연결이 오래 걸려
   * 거절당하면 아래 '화면 클릭'이 받아 준다.
   *
   * ★ live 가 아니라 **sceneReady** 를 본다. live 는 welcome 이 왔다는 뜻일 뿐이라
   *   그 순간엔 캔버스가 없다 (씬은 dynamic import 다). 예전엔 live 에 걸어 놓고
   *   한 프레임 뒤에 요청했는데, 그때 잠글 대상이 없어 요청이 통째로 사라졌다.
   */
  useEffect(() => {
    // ③ 판이 도는 중에 들어왔다면(재접속) 패널이 이미 떠 있을 수 있다. 그때는 잠그지 않는다
    if (!live || !sceneReady || uiOpen) return;
    const id = requestAnimationFrame(() => resumeWalking());
    return () => cancelAnimationFrame(id);
  }, [live, sceneReady, uiOpen, resumeWalking]);

  /*
   * ① 패널이 열리면 커서를 돌려주고, 닫히면 걷기로 되돌린다.
   *
   * ★ **바뀌는 순간에만** 손댄다. `uiOpen` 이 false 인 동안 매번 requestLock 을
   *   부르면, 사용자가 ESC 로 잠깐 멈춘 상태를 이 효과가 계속 되돌려 버린다.
   *   그래서 직전 값을 들고 비교한다(위 잠금 해제 효과와 같은 이유).
   */
  const wasUiOpen = useRef(false);
  useEffect(() => {
    if (!live) {
      wasUiOpen.current = uiOpen;
      return;
    }
    if (uiOpen) {
      if (document.pointerLockElement) document.exitPointerLock();
    } else if (wasUiOpen.current) {
      requestLock();
    }
    wasUiOpen.current = uiOpen;
  }, [live, uiOpen]);

  /*
   * 화면(캔버스)을 클릭하면 걷기로 돌아간다.
   *
   * 자동 잠금은 사용자 활성화가 살아 있어야 통한다 — 청크 다운로드가 길어지거나
   * 파이어폭스처럼 "입력 핸들러 안에서만" 허용하는 브라우저에서는 거절된다.
   * 거절되면 사용자는 걷지도 돌리지도 못한 채 이유를 알 수 없으므로, **진짜
   * 클릭**이라는 확실한 길을 하나 열어 둔다.
   *
   * ★ `e.target === canvas` 로만 받는다. 예전에 클릭 경로를 없앤 이유(commit
   *   68c947d)는 drei 가 selector 없이 **document 전체**에 걸어서, 설정판의
   *   볼륨 슬라이더를 만지는 클릭까지 잠금으로 먹어 판이 사라졌기 때문이다.
   *   이제 만질 판 자체가 없지만, 조건은 그대로 둔다 — 나중에 무엇을 덧붙이든
   *   "캔버스를 직접 누른 것만 잠금"이라는 선이 그 사고를 다시 막는다.
   */
  useEffect(() => {
    // ② 패널이 떠 있는 동안에는 이 경로를 아예 끈다. 안 끄면 판 바깥(세계)을
    //    한 번 누른 순간 다시 잠겨서 커서가 사라지고, 좌석 카드를 못 누른다
    if (!live || uiOpen) return;
    const onClick = (e: MouseEvent) => {
      if (e.target !== document.querySelector('canvas')) return;
      requestLock();
    };
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, [live, uiOpen]);

  /*
   * Enter(또는 T) 로 한 마디 한다. 걷는 중에만 받는다.
   *
   * ★ preventDefault 가 필요하다. 안 하면 그 keydown 의 기본 동작이 방금 포커스를
   *   준 입력줄로 흘러가 'ㅅ'(T) 한 글자가 미리 박힌다.
   * ★ 포커스는 여기서 준다. 잠금은 건드리지 않는다 — 이 모드의 핵심이다.
   */
  useEffect(() => {
    // ★ 말이 잠긴 단계에서는 열지 않는다 (I1 — mayChat). 열어 봐야 워커가 거절하고,
    //   무엇보다 이 구간에 사람만 말할 수 있으면 그 한 줄이 곧 명단이다.
    if (!live || composing || !canSpeak) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable) return;
      if (e.code !== 'Enter' && e.code !== 'NumpadEnter' && e.code !== 'KeyT') return;
      e.preventDefault();
      setComposing(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [live, composing, canSpeak]);

  /*
   * 치던 중에 단계가 넘어갔다 — 입력줄을 닫는다.
   *
   * ★ 안 닫으면 freechat 끝에 열어 둔 줄이 vote 로 넘어가서도 살아 있고, 거기서
   *   Enter 를 치면 워커가 조용히 버린다("보냈는데 안 보인다"). 그리고 그 사이
   *   투표 패널이 뜨는데 입력줄이 포커스를 쥐고 있어 클릭 흐름도 어긋난다.
   */
  useEffect(() => {
    if (composing && !canSpeak) {
      setComposing(false);
      setDraft('');
    }
  }, [composing, canSpeak]);

  /** 입력줄이 뜨면 바로 칠 수 있어야 한다. focus 는 잠금을 풀지 않는다(실측) */
  useEffect(() => {
    if (composing) lineRef.current?.focus();
  }, [composing]);

  /*
   * 소리는 **걸으면서** 맞춘다. M 으로 끄고 켜고, − + 로 올리고 내린다.
   *
   * 슬라이더를 없앤 이유: 슬라이더를 잡으려면 커서가 있어야 하고, 커서를 보려면
   * 잠금을 풀어야 하고, 그러려고 판을 띄웠다 — 소리 한 칸 올리자고 게임이 멈췄다.
   * 키로 하면 그 사슬이 통째로 사라진다. 대신 지금 몇인지 보이지 않으므로
   * 만질 때만 잠깐 뜨는 표시를 둔다 (VolumeHud).
   *
   * ★ 음소거를 풀 때 **끄기 직전 값**으로 돌아간다. 0.18 같은 기본값으로 되돌리면
   *   애써 맞춰 둔 크기가 M 한 번에 날아간다.
   */
  const lastAudible = useRef(0.18);
  const hudTimer = useRef<number | null>(null);
  const flashVolumeHud = useCallback(() => {
    setVolumeHud(true);
    if (hudTimer.current !== null) window.clearTimeout(hudTimer.current);
    hudTimer.current = window.setTimeout(() => setVolumeHud(false), 1400);
  }, []);
  useEffect(() => () => {
    if (hudTimer.current !== null) window.clearTimeout(hudTimer.current);
  }, []);

  useEffect(() => {
    if (!live) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable) return;

      const cur = getMusicVolume();
      if (e.code === 'KeyM') {
        if (cur > 0) lastAudible.current = cur;
        setMusicVolume(cur > 0 ? 0 : lastAudible.current || VOLUME_STEP);
      } else if (e.code === 'Minus' || e.code === 'NumpadSubtract' || e.code === 'BracketLeft') {
        setMusicVolume(step(cur, -VOLUME_STEP));
      } else if (e.code === 'Equal' || e.code === 'NumpadAdd' || e.code === 'BracketRight') {
        const next = step(cur, VOLUME_STEP);
        lastAudible.current = next;
        setMusicVolume(next);
      } else {
        return;
      }
      e.preventDefault();
      flashVolumeHud();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [live, flashVolumeHud]);

  /**
   * 주제가 **실제로 뜨면** 안내 음성 + 기록 한 줄 (사용자 요청 2026-08-07).
   *
   * ┌─ ★★ 'topic' 이 아니라 'speak' 이다 ──────────────────────────────────────┐
   * │ 'topic' 단계에는 주제가 없다. 거기는 뜸 들이는 6초고 스크린에도 「곧 주제가 │
   * │ 나온다」만 뜬다 — 워커도 그 단계에는 문구를 안 실어 보낸다(roundSnapshot 의 │
   * │ topic 은 speak 에서만 채워진다. 미리 보내면 소켓으로 6초 먼저 읽힌다).     │
   * │ 처음에 'topic' 에 걸었더니 안내가 주제보다 6초 빨랐다 (사용자 보고).       │
   * │ round 는 speak 에서도 1·2 그대로다 — 그래서 번호는 여기서도 맞는다.        │
   * └──────────────────────────────────────────────────────────────────────────┘
   *
   * ┌─ 왜 여기(효과)이고 onRound(콜백)가 아닌가 ────────────────────────────────┐
   * │ 서버는 같은 단계를 두 번 보낼 수 있다 — 판 중간에 들어온 사람에게 주는     │
   * │ 스냅샷이 그렇다. 콜백에 넣으면 그때마다 음성이 다시 울린다. 효과는 의존성  │
   * │ 값이 **실제로 바뀔 때만** 도므로, 같은 단계가 두 번 와도 한 번만 운다.     │
   * │                                                                          │
   * │ endsAt 을 키에 함께 넣는 이유: round 는 판마다 1 로 되돌아온다. 「한 판    │
   * │ 더」의 첫 주제가 지난 판의 안내와 같은 키가 되면 기록에서 지워진다        │
   * │ (pushNotice 의 중복 방지). endsAt 은 서버 시각이라 판마다 다르다.         │
   * └──────────────────────────────────────────────────────────────────────────┘
   *
   * ★ 소리와 글자를 **같은 자리에서** 낸다. 음소거·자동재생 차단으로 소리가 빠져도
   *   기록 줄은 남아야 주제가 바뀐 걸 안다 (topic-voice.ts 머리말).
   */
  useEffect(() => {
    if (!live || phase !== 'speak' || topicRound < 1) return;
    const label = topicRound === 1 ? '첫 번째' : '두 번째';
    useWorldStore.getState().pushNotice(`topic-${topicRound}-${topicEndsAt}`, `${label} 주제가 공개됐습니다`);
    playTopicVoice(topicRound);
  }, [live, phase, topicRound, topicEndsAt]);

  /*
   * ESC 를 위한 핸들러는 **없다.** 잠긴 동안의 ESC 는 브라우저가 먹고(keydown 이
   * 페이지로 오지 않는다) 잠금만 푼다. 그 해제가 곧 '잠깐 멈춤'이고, 화면을
   * 클릭하면 이어서 걷는다. 열고 닫을 판이 없으니 스위치도 필요 없다.
   */

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
        <WorldScene
          conn={conn}
          spawn={spawn}
          composing={composing}
          onLockChange={setLocked}
          onReady={() => setSceneReady(true)}
        />
      ) : (
        <div className="h-full w-full bg-[#07050a]" />
      )}

      {/* 헤더 */}
      <header className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-4 p-6">
        <div>
          {/* 방 안에서는 작업 보드 링크 대신 퇴장 버튼 — 눌러도 바로 안 나가고 한 번 더 묻는다 */}
          {live ? (
            <button
              type="button"
              onClick={() => setConfirmLeave(true)}
              className="pointer-events-auto text-xs text-neutral-500 transition-colors hover:text-neutral-200"
            >
              ← 현재 방에서 퇴장하기
            </button>
          ) : (
            <Link
              href="/"
              className="pointer-events-auto text-xs text-neutral-500 transition-colors hover:text-neutral-200"
            >
              ← 작업 보드
            </Link>
          )}
          <h1 className="mt-2 text-2xl font-black tracking-tight text-neutral-200 drop-shadow-[0_2px_12px_rgba(0,0,0,0.9)]">
            3D 월드
          </h1>
          {ticket ? (
            <p className="mt-1 font-mono text-[11px] text-neutral-500">
              {/* 정원은 **사람** 수다. 시작하면 여기에 AI 1대가 더 붙는다 (§15-3 — 수는 공개, 자리는 비밀) */}
              {ticket.room.code} · {ticket.self.nickname} · 사람 {ticket.room.capacity}
              {ticket.role ? ` · ${ROLE_LABEL[ticket.role]}` : ''}
            </p>
          ) : null}
          {/*
            역할 카드에서 「확인」을 누르면 카드 대신 여기 뱃지가 남는다 (2026-08-07).
            그림·이름·색·뜨는 조건은 전부 game-hud 의 MyRoleBadge 안에 있다 —
            역할 문구의 원본은 ROLE_CARD 하나여야 하고, 그건 그 파일 것이다.
            예전에는 여기 회색 한 줄이었는데 방 코드 줄과 구별이 안 됐다.
          */}
          {/*
            왼쪽 판 — **맨 위가 내 역할(고정), 그 밑이 좌석 메모**다 (2026-08-07).
            글자·색·뜨는 조건은 전부 game-hud 의 SeatNotes 안에 있다: 역할 이름의
            원본은 ROLE_CARD 하나여야 하고, 그건 그 파일 것이다.
            머리말 안에 두는 이유는 위치를 숫자로 고정하지 않기 위해서다 — 방 코드
            줄이 한 줄 늘고 줄어드는 만큼 이 판도 같이 밀린다.
          */}
          {live ? <SeatNotes /> : null}
        </div>
        {/* 소리는 걸으면서 M · − + 로 맞춘다 (판 없음) */}
        {live ? <StatusChip /> : null}
      </header>

      {/*
        로비에서 「게임 시작」으로 넘어온 흐름(gameFlow)에서는 입장 패널(방 만들기 카드)을
        띄우지 않는다. 방은 이미 정해졌으니 로딩 표시만 보이고 곧장 월드로 들어간다 —
        전원이 도착할 때까지의 "다른 인원 대기"는 월드 안의 스크린(warehouse ScreenWaiting)이
        present/total 로 보여 준다.
      */}
      {!live && gameFlow ? (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-[#07050a] p-6 text-center">
          {errorText ? (
            <>
              <p className="text-sm font-bold text-red-400">{errorText}</p>
              <button
                type="button"
                onClick={() => router.push('/main')}
                className="mt-2 rounded-lg bg-white/10 px-4 py-2 text-sm font-bold text-neutral-200 transition-colors hover:bg-white/20"
              >
                로비로 돌아가기
              </button>
            </>
          ) : (
            <>
              <div className="h-9 w-9 animate-spin rounded-full border-2 border-white/15 border-t-[#d4a373]" />
              <p className="text-sm font-bold text-neutral-200">로딩 중입니다…</p>
              <p className="text-[12px] text-neutral-500">다른 인원의 로딩을 기다리는 중입니다</p>
            </>
          )}
        </div>
      ) : null}

      {/* 입장 패널 — 코드 없이 /world 로 직접 온 라운지에서만 뜬다 */}
      {!live && !gameFlow ? (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <div className="w-full max-w-sm rounded-2xl bg-black/70 p-6 ring-1 ring-white/10 backdrop-blur">
            <h2 className="text-sm font-bold text-neutral-200">방에 들어가기</h2>
            <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
              같은 방 코드로 들어온 사람들이 같은 공간에서 서로를 봅니다. 빈자리는 채워집니다.
            </p>

            <div className="mt-4 flex gap-2">
              <input
                value={code}
                // 코드는 이제 방 이름일 수 있다 — 공백 제거 + 대문자 (서버 codeFromName 과 같은 모양)
                onChange={(e) => setCode(e.target.value.replace(/\s/g, '').toUpperCase().slice(0, 20))}
                placeholder="방 이름 또는 코드"
                className="min-w-0 flex-1 rounded-lg bg-white/5 px-3 py-2 text-center font-mono text-sm tracking-widest text-neutral-100 ring-1 ring-white/15 outline-none focus:ring-amber-500/50"
              />
              <button
                type="button"
                disabled={busy || code.length === 0}
                onClick={() => void enter(code)}
                className="shrink-0 rounded-lg bg-amber-500/90 px-5 py-2 text-sm font-bold text-black transition-colors hover:bg-amber-400 disabled:opacity-40"
              >
                입장
              </button>
            </div>

            {/* 새 방 이름 — **이 이름이 곧 입장 코드다.** 겹치면 서버가 409 로 거절한다 */}
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value.slice(0, 20))}
              maxLength={20}
              placeholder="새 방 이름 (비우면 랜덤 코드)"
              className="mt-4 w-full rounded-lg bg-white/5 px-3 py-2 text-sm text-neutral-100 ring-1 ring-white/15 outline-none placeholder:text-neutral-600 focus:ring-amber-500/50"
            />
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
        ┌─ 판은 없다 ──────────────────────────────────────────────────────────┐
        │                                                                      │
        │  걷기 ──Enter/T──→ 말하기 ──Enter(보냄)/ESC(무름)──→ 걷기            │
        │   │  ↑                  잠금 유지 · 시야 ○ · 다리 ✕                  │
        │   └──ESC──→ 잠깐 멈춤 ──클릭──┘   잠금 해제                          │
        │                                                                      │
        │ 소리는 모드가 아니다 — 걸으면서 M · − · + 로 맞추고, 만질 때만 눈금이 │
        │ 잠깐 뜬다 (VolumeHud). 채팅 기록도 판이 아니라 화면 아래로 흐른다.    │
        │                                                                      │
        │ 그래서 **화면을 덮는 것이 하나도 없다.** 판이 사라지면서 이 파일의    │
        │ 오랜 골칫거리도 같이 사라졌다 — "판을 만지는 클릭"과 "다시 잠그는     │
        │ 클릭"이 겹쳐서 클릭 경로를 통째로 지웠던 그 문제(commit 68c947d).     │
        │ 무엇을 덧붙이든 이 성질을 깨지 않는 게 좋다: 만질 것이 화면에 있으면  │
        │ 잠금을 풀어야 하고, 잠금을 풀면 게임이 멈춘다.                        │
        └──────────────────────────────────────────────────────────────────────┘
      */}
      {live ? (
        <>
          {/*
            남의 말. 판이 아니라 글자만 흐른다 — 이제 **늘** 보인다.

            ★ 5줄에서 AMBIENT_LINES 줄로 늘렸다 (2026-08-07). 사람이 여덟이면
              한 바퀴 도는 동안 앞사람 말이 이미 밀려 나갔다.
            ★ 대신 **오래된 줄일수록 흐리다.** 같은 밝기로 쌓으면 3D 화면이 글자에
              묻힌다 — 이 게임은 사람이 움직이는 걸 보는 게임이다.
            ★ 여기는 끝까지 읽는 자리가 아니다. 그건 커서가 자유로울 때 뜨는
              전체 기록이 맡는다 (아래 ChatTranscript).
          */}
          {messages.length > 0 ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-24 flex flex-col items-start gap-1 px-6">
              {messages.slice(-AMBIENT_LINES).map((m, i, shown) => (
                <p
                  key={m.key}
                  className="max-w-[min(46rem,60vw)] text-[12px] text-neutral-300 drop-shadow-[0_1px_4px_rgba(0,0,0,0.9)]"
                  style={{ opacity: Math.max(0.3, 1 - (shown.length - 1 - i) * 0.085) }}
                >
                  {/* 진행 안내(주제 공개)는 이름이 없다 — 말한 사람이 없기 때문이다 (store.ts 의 system) */}
                  {m.system ? (
                    <span className="font-bold tracking-wide text-[#8fd6ad]">{m.text}</span>
                  ) : (
                    <>
                      <span className="font-bold text-[#d4a373]">{m.nickname}</span>{' '}
                      <span className="text-neutral-200">{m.text}</span>
                    </>
                  )}
                </p>
              ))}
            </div>
          ) : null}

          {/*
            전체 대화 기록 — **커서가 이미 자유로울 때만** 뜬다 (2026-08-07).

            ┌─ 왜 이 조건인가 ──────────────────────────────────────────────────┐
            │ 위 큰 상자의 규칙: 만질 것이 화면에 있으면 잠금을 풀어야 하고,     │
            │ 잠금을 풀면 게임이 멈춘다. 그래서 이 판은 **스스로 잠금을 풀지     │
            │ 않는다** — 이미 풀려 있는 순간(ESC 멈춤 · 투표 · 최후변론 ·        │
            │ 생사투표)에만 나타난다. 마침 그때가 앞 대화를 되짚어 읽고 싶은     │
            │ 순간이고, 걷는 동안에는 위의 흐르는 로그로 충분하다.               │
            │                                                                  │
            │ ★ 클릭해도 다시 잠기지 않는다 — 재잠금은 캔버스가 받는데 이 판은   │
            │   그 위에서 클릭을 삼킨다(pointer-events). 휠로 굴려 읽으면 된다.  │
            │   판 밖을 누르면 평소처럼 잠기고 이 판은 같이 사라진다.            │
            └──────────────────────────────────────────────────────────────────┘
          */}
          {!locked && !confirmLeave ? <ChatTranscript /> : null}

          {/*
            잠깐 멈춤 — **ESC 로 잡았던 잠금이 풀린 상태에서만** 뜬다 (everLocked).
            막 들어와 아직 한 번도 못 잡은 동안에는 아무것도 띄우지 않는다:
            접속하자마자 안내문부터 보는 게 이상하고, 그때는 아무 데나 클릭하면
            조용히 잠긴다 (사용자 결정 2026-08-06 — everLocked 의 상자).

            **pointer-events-none 이라 이 글자를 뚫고 캔버스가 클릭된다** — 그래서
            "클릭하면 계속"이 말 그대로 아무 데나 눌러도 동작한다.
          */}
          {everLocked && !locked && !composing && !uiOpen && !confirmLeave ? (
            <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2">
              <p className="text-lg font-bold text-neutral-100 drop-shadow-[0_2px_12px_rgba(0,0,0,0.9)]">
                화면을 클릭하면 계속
              </p>
              {/*
                「잠깐 멈춥니다」에서 「대화 기록 보기」로 바꿨다 (사용자 2026-08-07).
                멈춘다는 건 **결과**고 사람이 ESC 를 누르는 **이유**가 아니다. 잠금이
                풀린 이 상태가 곧 전체 대화 기록이 뜨는 자리라(아래 ChatTranscript),
                그걸 이름으로 부른다.
              */}
              <p className="text-[12px] text-neutral-400 drop-shadow-[0_1px_6px_rgba(0,0,0,0.9)]">
                ESC 를 누르면 대화 기록 보기
              </p>
            </div>
          ) : null}

          {/* 소리를 만질 때만 잠깐 뜬다 */}
          <VolumeHud visible={volumeHud} />

          {/* 판 진행 — 단계 HUD(z-30) · 투표/찬반(z-40) · 결과(z-50) */}
          <GameHud
            onVote={castVote}
            onVerdict={castVerdict}
            onLeave={endGameToLobby}
          />

          {/*
            퇴장 확인 (z-60 — 결과 오버레이보다 위).
            배경이 클릭을 다 받으므로(캔버스가 e.target 이 아니다) 화면 클릭 재잠금
            경로와 충돌하지 않는다. 취소하면 잠깐 멈춤 상태로 돌아가고, 화면을
            클릭하면 이어서 걷는다.
          */}
          {confirmLeave ? (
            <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/60 p-6">
              <div className="w-full max-w-xs rounded-2xl bg-black/80 p-6 ring-1 ring-white/10 backdrop-blur">
                <p className="text-sm font-bold text-neutral-100">현재 방에서 퇴장할까요?</p>
                <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
                  방 목록으로 돌아갑니다. 같은 이름(코드)으로 다시 들어오면 원래 자리로
                  돌아옵니다.
                </p>
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      // 정리(leave)를 먼저 — 스토어가 전역이라 안 비우고 떠나면
                      // 다음 /world 방문에 이전 방 상태가 샌다.
                      leave();
                      router.push('/main');
                    }}
                    className="flex-1 rounded-lg bg-[#d4a373]/90 px-4 py-2 text-sm font-bold text-black transition-colors hover:bg-[#d4a373]"
                  >
                    퇴장하기
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmLeave(false)}
                    className="flex-1 rounded-lg bg-white/10 px-4 py-2 text-sm font-bold text-neutral-200 transition-colors hover:bg-white/20"
                  >
                    취소
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {/*
            아래 가운데 — 말하기와 안내가 같은 자리를 쓴다.

            ★ z 는 투표·판결 패널(game-hud 의 PanelShell, z-40)보다 **위**다. 그 두
              단계에서도 말이 열려 있어서(mayChat) 입력줄이 패널과 같이 뜨는데,
              아래에 깔리면 클릭이 패널에 먹혀 커서로는 입력줄을 못 잡는다.
              결과 오버레이(z-50)보다는 아래다 — 거긴 말이 잠긴 단계다.
          */}
          <div className="absolute inset-x-0 bottom-6 z-[45] flex justify-center px-6">
            {composing ? (
              <ChatLine
                inputRef={lineRef}
                draft={draft}
                onDraft={setDraft}
                onSend={sendLine}
                cancelOnBlur={!uiOpen}
                onCancel={() => {
                  setComposing(false);
                  setDraft('');
                  // 잠금이 살아 있으면 그대로 걷는다. 거절당한 상태였다면 다시 두드린다.
                  // ④ 단, 패널이 떠 있으면 되잡지 않는다 — 커서가 사라진다
                  if (!uiOpen && !document.pointerLockElement) requestLock();
                }}
              />
            ) : uiOpen ? (
              /*
                패널이 떠 있는 동안에는 조작 안내를 감춘다. 지금은 커서가 있고 다리가
                묶인 상태라 "WASD 이동"이 그대로 거짓말이 된다 (world-scene 의 LocalRig
                가 잠금이 풀린 동안 이동키를 무시한다).

                ★ 단 **다리는 묶여도 입은 열린** 단계가 있다 — 최후변론에 이어 이제
                  지목 투표·판결까지다 (mayChat, 2026-08-07 사용자 지시). 말할 수 있다는
                  걸 모르면 침묵하고, 한쪽 진영만 침묵하면 그 단계가 통째로 정체
                  판별기가 된다 (I1). 그래서 이 안내는 **말이 열린 동안 반드시 떠 있어야
                  한다** — 감추는 최적화를 여기에 얹지 말 것.
                ★ 역할 카드가 떠서 열린 uiOpen 은 뺀다 — topic·speak 은 말이 열린
                  단계라 canSpeak 이 참인데, 그때 이 문구가 뜨면 거짓말이 된다.
              */
              canSpeak && !cardOpen ? (
                <p className="rounded-full border border-amber-500/40 bg-black/70 px-5 py-2.5 text-[12px] text-amber-200 backdrop-blur">
                  <span className="font-bold">Enter</span> 로{' '}
                  {phase === 'defense' ? '최후변론' : '말하기'}
                </p>
              ) : null
            ) : (
              /* 조작은 이제 전부 키다. 한 줄에 다 적어 둔다 — 열어 볼 판이 없으므로 */
              <p className="rounded-full border border-white/10 bg-black/60 px-5 py-2.5 text-[12px] text-neutral-300 backdrop-blur">
                WASD 이동 · Shift 달리기 · Space 점프 ·{' '}
                <span className="text-[#d4a373]">Enter 로 말하기</span> ·{' '}
                {/*
                  ESC 를 여기 적는다 (사용자 2026-08-07). 「ESC 를 누르면 대화 기록
                  보기」는 **누른 뒤에야** 뜨는 안내라, 처음 들어온 사람은 기록을 볼
                  수 있다는 걸 알 길이 없었다. 걷는 동안 읽는 줄이 이것 하나다.
                */}
                ESC 대화 기록 · M 음소거 ·{' '}
                <span className="font-mono">−</span> <span className="font-mono">+</span> 소리
              </p>
            )}
          </div>
        </>
      ) : null}
    </main>
  );
}

/* ─────────────────────────────── 한 줄 말하기 ─────────────────────────────── */

/**
 * 걷는 중에 뜨는 한 줄 입력. **판이 아니다** — 시야를 가리지 않아야 하고,
 * 마우스 잠금이 유지되므로 배경은 그대로 살아 움직인다.
 *
 * Enter 로 보내고 즉시 걷기로. ESC 로 무른다.
 */
function ChatLine({
  inputRef,
  draft,
  onDraft,
  onSend,
  onCancel,
  cancelOnBlur,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  draft: string;
  onDraft: (v: string) => void;
  onSend: () => void;
  onCancel: () => void;
  /**
   * 포커스를 잃으면 무를 것인가.
   *
   * ★ 걷는 중에는 참이다 — 포커스가 없으면 애초에 칠 수가 없으니 줄만 남으면 거짓말이다.
   * ★ 패널이 떠 있는 동안에는 **거짓**이다. 지목 투표·판결에서도 말할 수 있게 된 뒤로
   *   (mayChat, 2026-08-07) 치던 중에 좌석 카드를 누르는 일이 생기는데, 그 클릭이
   *   blur 라 여기서 무르면 **치던 말이 통째로 날아간다.** 표를 던지고 이어서 치는 게
   *   이 단계에서 제일 흔한 동작이다.
   */
  cancelOnBlur: boolean;
}) {
  return (
    <div className="pointer-events-auto flex w-full max-w-xl items-center gap-3 rounded-full border border-[#d4a373]/40 bg-black/75 px-4 py-2.5 backdrop-blur">
      <span className="shrink-0 text-[11px] font-bold tracking-wide text-[#d4a373]">말하기</span>
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        onKeyDown={(e) => {
          /*
            ★ 한글은 조합 중에도 Enter 가 온다. isComposing 을 안 보면 마지막 글자를
              확정하는 Enter 가 그대로 '보내기'가 되어, 치던 말이 반 토막 난 채 나간다.
              (여기서 말하는 composing 은 IME 조합이다 — 이 화면의 말하기 모드와는
              이름만 같고 다른 것이다.)
          */
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            onSend();
            return;
          }
          if (e.key === 'Escape') {
            // 잠긴 상태에서는 이 keydown 이 오지 않는다(브라우저가 먹고 잠금만 푼다).
            // 그 경로는 page 의 잠금 해제 효과가 받는다. 여기는 안 잠긴 경우다.
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={cancelOnBlur ? onCancel : undefined}
        maxLength={200}
        placeholder="Enter 로 보내기 · ESC 로 취소"
        className="min-w-0 flex-1 bg-transparent text-[13px] text-white outline-none placeholder:text-neutral-600"
      />
    </div>
  );
}

/* ─────────────────────────────── 소리 표시 ─────────────────────────────── */

/**
 * 소리를 만질 때만 잠깐 뜨는 표시. **조절기가 아니다** — 누르는 건 키(M · − · +)고
 * 이건 지금 몇인지 보여 주기만 한다. 그래서 pointer-events 가 없다.
 *
 * 볼륨은 useSyncExternalStore 로 music.ts 에서 직접 읽는다 — React 상태로 복제하지
 * 않아 어디서 setVolume 을 하든 이 눈금이 같이 움직인다.
 */
function VolumeHud({ visible }: { visible: boolean }) {
  const volume = useSyncExternalStore(musicSubscribe, getMusicVolume, () => 0.18);

  return (
    <div
      aria-hidden={!visible}
      className={`pointer-events-none absolute left-1/2 top-24 z-30 -translate-x-1/2 transition-opacity duration-300 ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
    >
      <div className="flex items-center gap-3 rounded-full border border-white/10 bg-black/70 px-4 py-2 backdrop-blur">
        <span className="text-neutral-300">{volume > 0 ? <VolumeIcon /> : <MuteIcon />}</span>
        <div className="h-1.5 w-28 overflow-hidden rounded-full bg-white/15">
          <div className="h-full rounded-full bg-[#d4a373]" style={{ width: `${volume * 100}%` }} />
        </div>
        <span className="w-8 text-right font-mono text-[11px] text-neutral-400">
          {Math.round(volume * 100)}
        </span>
      </div>
    </div>
  );
}
/* ─────────────────────────────── 아이콘 ─────────────────────────────── */
/* CDN(font-awesome) 대신 인라인 SVG — 배포본에서 외부 요청이 나가지 않는다 */

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
    case 'round_in_progress':
      return '이 방은 지금 판이 진행 중이다. 판이 끝나면 다시 입장할 수 있다';
    case 'room_unavailable':
      return '워커가 좌석 명단을 못 받았다. NEXT_ORIGIN이 밖에서 닿는 주소인지 확인하고 다시 배포할 것 (npm run world:deploy)';
    case 'connection_failed':
      return '월드 서버에 붙지 못했다. 워커가 떠 있는지 확인할 것 (npm run world:dev)';
    default:
      return code;
  }
}
