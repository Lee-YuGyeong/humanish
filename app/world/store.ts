/**
 * 월드 클라이언트 상태. 소유: 원상 (/world)
 *
 * 규칙 하나만 지키면 된다: **좌표는 스토어 값이 아니다.**
 *   player_moved  → Map 안 객체를 제자리 변형. 리렌더 없음
 *   joined / left → Map 변경 + playersVersion++. 씬만 리렌더
 *   chat          → 말풍선 변형 + bubbleTick++, 로그는 배열에 쌓는다
 *
 * WS 콜백 안에서는 useWorldStore.getState()로 부른다(구독이 아니다).
 * 콜백이 컴포넌트를 구독하면 그 자체가 리렌더를 유발한다.
 */

import { create } from 'zustand';
import type { PlayerSnapshot } from '@/lib/mp/protocol';
import type { AnimState } from '@/lib/mp/protocol';
import { createRemote, pushMove, setBubble, type RemotePlayer } from './net/remote-players';

export type WorldStatus = 'idle' | 'connecting' | 'live' | 'error';

export interface ChatLine {
  key: string;
  id: string;
  nickname: string;
  text: string;
  ts: number;
}

/** 채팅 로그 보관 개수. 넘으면 오래된 것부터 버린다 */
const CHAT_LOG_MAX = 60;

interface WorldState {
  status: WorldStatus;
  errorText: string | null;

  selfId: string | null;
  /** 본인 표시용. 좌표는 LocalRig가 들고 있다 */
  self: { seat: number; nickname: string; maskId: string } | null;

  /** 원격 플레이어만. 본인은 들어 있지 않다 */
  players: Map<string, RemotePlayer>;
  /** 멤버십이 바뀔 때만 증가한다. 좌표 변화로는 절대 증가하지 않는다 */
  playersVersion: number;
  /** 말풍선이 바뀔 때만 증가 */
  bubbleTick: number;

  messages: ChatLine[];

  setStatus(status: WorldStatus, errorText?: string | null): void;
  setSelf(id: string, self: { seat: number; nickname: string; maskId: string }): void;
  applyWelcome(selfId: string, players: PlayerSnapshot[], now: number): void;
  addPlayer(snap: PlayerSnapshot, now: number): void;
  removePlayer(id: string): void;
  applyMove(
    id: string,
    x: number,
    z: number,
    /** 발 높이. 0이 바닥이다 */
    y: number,
    heading: number,
    anim: AnimState,
    now: number,
  ): void;
  applyChat(id: string, nickname: string, text: string, ts: number, now: number): void;
  /** 방을 옮길 때 반드시 부른다. 안 지우면 이전 방 상태가 새 방에 새어 나온다 */
  reset(): void;
}

export const useWorldStore = create<WorldState>((set, get) => ({
  status: 'idle',
  errorText: null,
  selfId: null,
  self: null,
  players: new Map(),
  playersVersion: 0,
  bubbleTick: 0,
  messages: [],

  setStatus: (status, errorText = null) => set({ status, errorText }),

  setSelf: (id, self) => set({ selfId: id, self }),

  applyWelcome: (selfId, players, now) => {
    const map = get().players;
    map.clear();
    for (const p of players) {
      if (p.id === selfId) continue; // 본인은 원격으로 그리지 않는다
      map.set(p.id, createRemote(p, now));
    }
    set((s) => ({ selfId, status: 'live', errorText: null, playersVersion: s.playersVersion + 1 }));
  },

  addPlayer: (snap, now) => {
    const { players, selfId } = get();
    if (snap.id === selfId) return;
    players.set(snap.id, createRemote(snap, now));
    set((s) => ({ playersVersion: s.playersVersion + 1 }));
  },

  removePlayer: (id) => {
    const { players } = get();
    if (!players.delete(id)) return;
    set((s) => ({ playersVersion: s.playersVersion + 1 }));
  },

  // ★ set을 부르지 않는다. 10Hz × N명이라 여기서 리렌더가 나면 화면이 죽는다
  applyMove: (id, x, z, y, heading, anim, now) => {
    const player = get().players.get(id);
    if (!player) return;
    pushMove(player, x, z, y, heading, anim, now);
  },

  applyChat: (id, nickname, text, ts, now) => {
    const player = get().players.get(id);
    if (player) setBubble(player, text, now);

    set((s) => {
      const next = s.messages.concat({ key: `${id}-${ts}-${s.messages.length}`, id, nickname, text, ts });
      return {
        messages: next.length > CHAT_LOG_MAX ? next.slice(next.length - CHAT_LOG_MAX) : next,
        bubbleTick: s.bubbleTick + 1,
      };
    });
  },

  reset: () => {
    get().players.clear();
    set({
      status: 'idle',
      errorText: null,
      selfId: null,
      self: null,
      playersVersion: 0,
      bubbleTick: 0,
      messages: [],
    });
  },
}));
