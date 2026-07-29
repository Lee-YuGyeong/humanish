/**
 * 방 관련 서버 호출 — 라우트 하나당 함수 하나. 소유: A
 *
 * 여기 있는 것은 **경로와 응답 모양의 목록**이다. `/api/answer` 를 부르는 곳이
 * 화면 여기저기에 흩어져 있으면 본문 필드가 하나 바뀔 때 어디를 고쳐야 하는지
 * 알 수 없다. 라우트를 고치면 이 파일이 같이 바뀌고, 화면은 타입 에러로 알게 된다.
 *
 * ★ 응답 타입을 lib/game/types.ts 에 두지 않는다 (I8).
 *   저기는 **도메인** 언어(Room · Phase · Role)고, 여기 있는 것은 **API 계약**이다.
 *   Me 나 RevealData 는 라우트가 무엇을 합쳐서 주기로 했는지를 적은 것일 뿐,
 *   게임 규칙의 개념이 아니다. 도메인 타입은 아래처럼 import 해서 조립한다.
 */

import { getJson, postJson } from './client';
import type { PublicPlayer, Role, Room } from '@/lib/game/types';

/* ─────────────────────────────── 응답 모양 ─────────────────────────────── */

/** GET /api/me — **나 하나**에 대한 것만 온다. 남의 역할은 reveal 전까지 오지 않는다 (I1). */
export interface MeResponse {
  player: PublicPlayer | null;
  is_host: boolean;
  answered: boolean;
  voted: boolean;
  /** 배정 전(lobby)에는 null. 스파이는 자기가 스파이인 걸 알아야 게임이 성립한다 (SPEC §0). */
  role: Role | null;
  /**
   * 그 방의 봇 **총 수**. 0일 수 있다 — 사람이 정원을 다 채운 방이다 (SPEC §15-3-결정).
   * ★ 몇인지만 온다. 어느 자리인지는 끝까지 오지 않는다 (I1).
   */
  bot_count: number;
}

/**
 * GET /api/reveal — 게임에서 정체가 클라이언트로 오는 **유일한** 경로.
 * 그 라우트가 phase 와 참가 여부를 확인한 뒤에만 준다 (I1).
 */
export interface RevealResponse {
  players: {
    id: string;
    nickname: string;
    seat: number;
    is_bot: boolean;
    role: Role | null;
    votes_received: number;
    /** 그중 사람이 던진 표. 점수는 이쪽만 본다 */
    human_votes_received: number;
    score: number;
  }[];
  votes: { voter_id: string; target_id: string; reason: string; correct: boolean }[];
  rule: string[];
}

/** POST /api/phase/advance — 전환됐는지 여부가 핵심이다 (I6). */
export interface AdvanceResponse {
  advanced: boolean;
  room?: Room;
}

export interface RoomAndPlayer {
  room: Room;
  player: PublicPlayer;
}

/**
 * GET /api/lobby/lines — 대기방에서 누를 수 있는 문구 (SPEC §15-3-결정).
 *
 * ★ 목록을 화면에 복붙하지 않고 여기로 받는다. 두 군데로 갈리면 서버가 모르는
 *   문구를 눌러도 400 만 뜨고 원인이 안 보인다. 목록의 원본은
 *   lib/server/lobby-lines.ts 하나다.
 */
export interface LobbyLinesResponse {
  lines: { id: string; text: string }[];
  /** 같은 사람이 다시 누르기까지 기다려야 하는 초. 화면은 이걸로 버튼을 잠근다 */
  cooldown_sec: number;
  /** 한 사람이 대기방 전체에서 누를 수 있는 총 횟수 */
  max_lines: number;
}

/* ─────────────────────────────── 읽기 ─────────────────────────────── */

export function fetchMe(roomId: string, signal?: AbortSignal): Promise<MeResponse> {
  return getJson<MeResponse>(`/api/me?room_id=${encodeURIComponent(roomId)}`, signal);
}

export function fetchReveal(roomId: string, signal?: AbortSignal): Promise<RevealResponse> {
  return getJson<RevealResponse>(`/api/reveal?room_id=${encodeURIComponent(roomId)}`, signal);
}

/** 서버 시각 (SPEC §12.5). 카운트다운을 여기에 맞춘다 — 판정은 여전히 서버가 한다 (I2). */
export function fetchServerTime(signal?: AbortSignal): Promise<{ now: string }> {
  return getJson<{ now: string }>('/api/time', signal);
}

/** 방과 무관하다. 어느 방이든 같은 목록이라 한 번 받아서 계속 쓴다. */
export function fetchLobbyLines(signal?: AbortSignal): Promise<LobbyLinesResponse> {
  return getJson<LobbyLinesResponse>('/api/lobby/lines', signal);
}

/* ─────────────────────────────── 쓰기 (I9) ─────────────────────────────── */

export function startRoom(roomId: string): Promise<unknown> {
  return postJson('/api/room/start', { room_id: roomId });
}

export function submitAnswer(roomId: string, text: string): Promise<unknown> {
  return postJson('/api/answer', { room_id: roomId, text });
}

export function castVote(roomId: string, targetId: string, reason: string): Promise<unknown> {
  return postJson('/api/vote', { room_id: roomId, target_id: targetId, reason });
}

export function sendMessage(roomId: string, text: string): Promise<unknown> {
  return postJson('/api/message', { room_id: roomId, text });
}

/**
 * 대기방 프리셋 발화.
 *
 * ★ text 가 아니라 **lineId** 를 보낸다. 텍스트를 보내는 모양이면 화면을 거치지 않고
 *   아무 말이나 넣을 수 있어서 프리셋으로 좁힌 의미가 사라진다 — 라우트가 id 로
 *   목록을 찾는다 (I9).
 */
export function sayLobbyLine(roomId: string, lineId: string): Promise<unknown> {
  return postJson('/api/lobby/line', { room_id: roomId, line_id: lineId });
}

/** 준비 완료 토글. 시작을 막지는 않는다 — 방장이 참고하는 표시다. */
export function setLobbyReady(roomId: string, ready: boolean): Promise<unknown> {
  return postJson('/api/lobby/ready', { room_id: roomId, ready });
}

/**
 * 페이즈 전환 요청.
 *
 * ★ expected_seq 를 **인자에서 뺄 수 없게** 한다 (I6). 낙관적 잠금 키라서
 *   빠뜨리면 같은 페이즈가 두 번 전환된다. 호출부가 잊을 수 있는 자리를 남기지 않는다.
 */
export function advancePhase(roomId: string, expectedSeq: number): Promise<AdvanceResponse> {
  return postJson<AdvanceResponse>('/api/phase/advance', {
    room_id: roomId,
    expected_seq: expectedSeq,
  });
}

export function createRoom(capacity?: number): Promise<RoomAndPlayer> {
  return postJson<RoomAndPlayer>('/api/room', capacity == null ? {} : { capacity });
}

export function joinRoom(code: string): Promise<RoomAndPlayer> {
  return postJson<RoomAndPlayer>('/api/room/join', { code: code.toUpperCase() });
}
