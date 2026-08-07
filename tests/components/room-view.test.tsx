// @vitest-environment jsdom
/**
 * 게임 화면 — 계층을 갈아끼운 뒤에도 **같게 동작하는가**. (컴포넌트 소유는 C)
 *
 * ┌─ 무엇을 대신 세우고 무엇을 진짜로 쓰는가 ──────────────────────────────────┐
 * │ 대신 세운다  lib/api/*  — 네트워크 경계 하나뿐이다                         │
 * │ 진짜로 쓴다  react-query 캐시 · zustand 스토어 · reducer · 셀렉터 ·        │
 * │             derive 규칙 — 검사하려는 것이 바로 이 배선이다                 │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ★ DB 동작(RLS · 상태머신)은 여기서 흉내 내지 않는다. 그건 supabase/test.sh 가
 *   진짜 Postgres 에 물어본다 (vitest.config.ts 머리말). 여기서 대신 세우는 것은
 *   **전송 계층**이고, 그게 가능해진 것 자체가 lib/api 를 분리한 이유다 —
 *   예전에는 화면이 supabase 클라이언트와 fetch 를 직접 들고 있어서 이 검사를
 *   쓸 수 없었다.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Question, Room } from '@/lib/game/types';

/* ─────────────────────────────── 전송 계층 대역 ─────────────────────────────── */

const db = vi.hoisted(() => ({
  fetchRoomByCode: vi.fn(),
  fetchRoster: vi.fn(),
  fetchQuestions: vi.fn(),
  fetchAnswers: vi.fn(),
  fetchVotes: vi.fn(),
  fetchMessages: vi.fn(),
}));

/**
 * ★ 여기 빠진 함수는 **undefined 가 되고, 그래도 화면은 안 죽는다.**
 *   react-query 가 그 호출을 실패한 쿼리로 삼켜서 data 만 undefined 로 남기 때문이다.
 *   그러면 그 값으로 그리는 부분이 통째로 안 그려지는데 검사는 초록불이다.
 *   실제로 대기방 문구 버튼이 그렇게 조용히 사라졌다 — lib/api/room 에 함수를
 *   더하면 여기도 같이 더한다.
 */
const api = vi.hoisted(() => ({
  fetchMe: vi.fn(),
  fetchReveal: vi.fn(),
  fetchServerTime: vi.fn(),
  fetchLobbyLines: vi.fn(),
  startRoom: vi.fn(),
  startWorld: vi.fn(),
  leaveRoom: vi.fn(),
  submitAnswer: vi.fn(),
  castVote: vi.fn(),
  sendMessage: vi.fn(),
  sayLobbyLine: vi.fn(),
  setLobbyReady: vi.fn(),
  advancePhase: vi.fn(),
}));

/**
 * 라우터. 전역 setup(tests/setup.ts)의 것을 **이 파일에서만** 스파이로 바꾼다 —
 * "월드 시작 신호가 오면 정말 /world 로 가나"는 replace 호출을 직접 봐야 한다
 * (setup.ts 머리말이 안내하는 방식 그대로다).
 */
const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: nav.push,
    replace: nav.replace,
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/api/db', () => db);
vi.mock('@/lib/api/room', () => api);
/** Realtime 은 소켓이라 jsdom 에 없다. 구독 자체는 lib/queries/realtime.ts 의 책임이다. */
vi.mock('@/lib/queries/realtime', () => ({ useRoomRealtime: () => undefined }));

const { RoomView } = await import('@/components/room-view');
const { roomUiStore } = await import('@/lib/store/room');
const { initialRoomUiState } = await import('@/lib/store/room');

/* ─────────────────────────────── 데이터 ─────────────────────────────── */

const ROOM_ID = 'a51b500b-02e3-4500-91c3-35592caeb35b';

function room(patch: Partial<Room> = {}): Room {
  return {
    id: ROOM_ID,
    code: 'UFJR',
    // 기본은 이름 없는 방이다. 머리말이 코드를 그리는 쪽이라 아래 검사들이 그걸 본다.
    name: null,
    capacity: 5,
    phase: 'lobby',
    phase_seq: 0,
    phase_ends_at: null,
    round: 0,
    host_id: 'p1',
    // 지목·재투표 후보는 **아직 없다**가 기본이다 (SPEC §18.3).
    // vote/revote 를 벗어날 때 서버가 채우므로, lobby 로 시작하는 이 기본값은 null 이다.
    // 빼 두면 Partial<Room> 스프레드가 undefined 를 허용해 타입이 어긋난다.
    nominated_player_id: null,
    revote_candidates: null,
    roster_seq: 1,
    // 월드 시작 전이 기본이다. 이 값이 차면 대기방이 /world 로 넘어간다 (2026-08-06).
    world_started_at: null,
    ...patch,
  };
}

/**
 * 대기방 값(is_ready · lobby_line)은 lobby 에서만 채워진다. 시작하면 shuffle_seats 가
 * 비우고 뷰도 phase='lobby' 일 때만 준다 — 게임까지 따라가면 값이 있는 자리 = 사람이
 * 되어 봇이 전부 드러난다 (I1, SPEC §15-3-결정).
 *
 * p2 에만 말풍선을 둔다. 나(p1)는 비어 있어야 "같은 말 연속 금지"가 안 걸린 상태다.
 */
const PLAYERS = [
  {
    id: 'p1',
    room_id: ROOM_ID,
    nickname: '익명1',
    mask_id: 'mask-01',
    seat: 1,
    connected: true,
    is_ready: false,
    lobby_line: null,
    lobby_line_at: null,
  },
  {
    id: 'p2',
    room_id: ROOM_ID,
    nickname: '익명2',
    mask_id: 'mask-02',
    seat: 2,
    connected: true,
    is_ready: true,
    lobby_line: 'ㅋㅋㅋ',
    lobby_line_at: '2026-07-30T00:00:00.000Z',
  },
];

/** 서버가 내려주는 문구 목록. 원본은 lib/server/lobby-lines.ts 다. */
const LOBBY_LINES = {
  lines: [
    { id: 'wait', text: '잠깐만' },
    { id: 'hi', text: '안녕' },
    { id: 'lol', text: 'ㅋㅋㅋ' },
  ],
  cooldown_sec: 3,
  max_lines: 10,
};

function me(patch: Record<string, unknown> = {}) {
  return {
    player: PLAYERS[0],
    is_host: true,
    answered: false,
    voted: false,
    role: null,
    bot_count: 3,
    ...patch,
  };
}

function question(id: string, kind: 'common' | 'target', round: number): Question {
  return { id, room_id: ROOM_ID, round, kind, text: `${id} 질문`, asked_by: null, target_id: null };
}

/** 각 테스트는 캐시를 새로 만든다. 공유하면 앞 테스트의 응답이 뒤에서 살아난다. */
function renderRoom() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RoomView code="UFJR" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // 스토어는 모듈 전역이다. 테스트 사이에 초안·잠금이 넘어가지 않게 되돌린다.
  roomUiStore.setState({ state: initialRoomUiState });
  // 주소도 전역이다. 앞 테스트가 /main 으로 옮겨두면 다음 테스트는 처음부터
  // "이미 떠난" 상태로 시작한다 (useLeaveRoomOnExit 이 주소 변화를 본다).
  window.history.replaceState({}, '', '/room/UFJR');

  db.fetchRoomByCode.mockResolvedValue(room());
  db.fetchRoster.mockResolvedValue(PLAYERS);
  db.fetchQuestions.mockResolvedValue([]);
  db.fetchAnswers.mockResolvedValue([]);
  db.fetchVotes.mockResolvedValue([]);
  db.fetchMessages.mockResolvedValue([]);
  api.fetchMe.mockResolvedValue(me());
  api.fetchServerTime.mockResolvedValue({ now: new Date().toISOString() });
  api.fetchLobbyLines.mockResolvedValue(LOBBY_LINES);
  api.startRoom.mockResolvedValue({});
  api.startWorld.mockResolvedValue({});
  api.leaveRoom.mockResolvedValue({ ok: true, room_deleted: false });
  api.submitAnswer.mockResolvedValue({});
  api.sayLobbyLine.mockResolvedValue({});
  api.setLobbyReady.mockResolvedValue({});
});

afterEach(cleanup);

/* ─────────────────────────────── 검사 ─────────────────────────────── */

describe('대기실', () => {
  it('이름 없는 방은 코드를 이름 자리에 그린다', async () => {
    renderRoom();
    // ★ 코드가 뜨는 자리는 **머리말 하나뿐이다.** 예전에는 큰 판이 같은 코드를
    //   한 번 더 그렸다. 여기서 개수를 세는 이유가 그거다 — 판을 되살리면 걸린다.
    expect(await screen.findAllByText('UFJR')).toHaveLength(1);
    // 정원은 좌석 수 옆 눈금이 들고 있다 (좌석 칸 자체는 아래 검사가 센다)
    expect(await screen.findByText('정원 5')).toBeInTheDocument();
  });

  it('제목이 있으면 제목만 그리고 코드는 감춘다', async () => {
    db.fetchRoomByCode.mockResolvedValue(room({ name: '제목 확인' }));
    renderRoom();

    expect(await screen.findByRole('heading', { name: '제목 확인' })).toBeInTheDocument();
    // 코드는 복사 버튼이 맡는다. 글자로는 어디에도 없다.
    expect(screen.queryByText('UFJR')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /코드 복사/ })).toBeInTheDocument();
  });

  it('capacity 만큼 좌석 칸이 그려진다 (SPEC §17.6)', async () => {
    db.fetchRoomByCode.mockResolvedValue(room({ capacity: 8 }));
    renderRoom();
    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBe(8));
  });
});

describe('대기실에서 나가기', () => {
  it('★ 링크가 아니라 자리를 빼는 요청이다', async () => {
    // 예전에는 /main 으로 가는 <Link> 였다. 화면만 떠나고 **자리는 그대로 남아서**
    // 아무도 없는 방이 목록에 계속 떴고 방 코드도 24시간 묶였다.
    // role 이 다시 link 가 되면 그 상태로 돌아간 것이라 여기서 걸린다.
    renderRoom();
    fireEvent.click(await screen.findByRole('button', { name: /방 나가기/ }));
    await waitFor(() => expect(api.leaveRoom).toHaveBeenCalledWith(ROOM_ID));
  });

  it('★ 머리말의 ← 로비도 같은 동작이다', async () => {
    // 떠나는 길이 둘인데 한쪽만 자리를 빼면, 어느 쪽을 눌렀느냐로 빈 방이 남는지가
    // 갈린다. 화면에는 그 차이가 안 보이므로 검사로 묶어둔다.
    renderRoom();
    fireEvent.click(await screen.findByRole('button', { name: '로비' }));
    await waitFor(() => expect(api.leaveRoom).toHaveBeenCalledWith(ROOM_ID));
  });

  it('연타해도 요청은 한 번이다', async () => {
    // 두 번 나가면 두 번째는 이미 없는 자리를 다시 빼려 든다. 서버는 조용히
    // 넘기지만(라우트가 200), 화면에서 먼저 막는 편이 요청 하나를 아낀다.
    api.leaveRoom.mockImplementation(() => new Promise(() => {})); // 끝나지 않는 요청

    renderRoom();
    const button = await screen.findByRole('button', { name: /방 나가기/ });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(api.leaveRoom).toHaveBeenCalledTimes(1));
  });

  it('★ 브라우저 뒤로가기도 같은 동작이다', async () => {
    // 떠나는 길 셋(← 로비 · 방 나가기 · 뒤로가기) 중 뒤로가기만 자리를 안 빼면
    // 사람들은 대개 뒤로가기로 나가므로 빈 방이 목록에 계속 쌓인다.
    renderRoom();
    await screen.findByRole('button', { name: /방 나가기/ });

    fireEvent.popState(window);
    await waitFor(() => expect(api.leaveRoom).toHaveBeenCalledWith(ROOM_ID));
  });

  it('★ popstate 가 안 와도 화면이 걷히면 나간다', async () => {
    // 신호를 둘 듣는 이유가 이것이다. Next 가 뒤 화면을 어떻게 되살리든
    // **주소가 바뀐 채로 이 화면이 걷혔다**면 그건 떠난 것이다.
    const { unmount } = renderRoom();
    await screen.findByRole('button', { name: /방 나가기/ });

    window.history.pushState({}, '', '/main');
    unmount();

    await waitFor(() => expect(api.leaveRoom).toHaveBeenCalledWith(ROOM_ID));
  });

  it('★ 주소가 그대로면 화면이 걷혀도 나가지 않는다', async () => {
    // 게임 시작·StrictMode·HMR 이 전부 여기로 온다. 여기서 자리를 빼면
    // **시작하자마자 스스로 쫓겨난다.**
    const { unmount } = renderRoom();
    await screen.findByRole('button', { name: /방 나가기/ });

    unmount();

    await waitFor(() => expect(api.fetchMe).toHaveBeenCalled());
    expect(api.leaveRoom).not.toHaveBeenCalled();
  });

  it('★ 뒤로가기 뒤에 화면이 걷혀도 요청은 한 번이다', async () => {
    const { unmount } = renderRoom();
    await screen.findByRole('button', { name: /방 나가기/ });

    fireEvent.popState(window);
    window.history.pushState({}, '', '/main');
    unmount();

    await waitFor(() => expect(api.leaveRoom).toHaveBeenCalledTimes(1));
  });

  it('★ 나가기 버튼으로 나간 뒤 화면이 걷혀도 요청은 한 번이다', async () => {
    // 버튼은 성공한 **뒤에** /main 으로 넘어간다. 그 이동이 곧 언마운트라,
    // markLeft 를 빼먹으면 같은 나가기가 두 번 나간다.
    const { unmount } = renderRoom();
    fireEvent.click(await screen.findByRole('button', { name: /방 나가기/ }));
    await waitFor(() => expect(api.leaveRoom).toHaveBeenCalledTimes(1));

    window.history.pushState({}, '', '/main');
    unmount();

    await waitFor(() => expect(api.leaveRoom).toHaveBeenCalledTimes(1));
  });

  it('★ 시작한 방에서는 뒤로가기가 자리를 빼지 않는다', async () => {
    // leave_room 이 lobby 밖에서는 409 다 (SPEC §15-4 미결정). 여기서 요청을 보내면
    // 나가지도 못하면서 실패만 쌓인다 — 대기실을 떠날 때만 듣는다.
    db.fetchRoomByCode.mockResolvedValue(room({ phase: 'question', round: 1 }));
    const { unmount } = renderRoom();
    await screen.findByRole('button', { name: '제출' });

    fireEvent.popState(window);
    window.history.pushState({}, '', '/main');
    unmount();

    await waitFor(() => expect(api.fetchMe).toHaveBeenCalled());
    expect(api.leaveRoom).not.toHaveBeenCalled();
  });
});

describe('대기실에서 말하기 (SPEC §15-3-결정)', () => {
  it('서버가 준 문구로 버튼을 그린다', async () => {
    renderRoom();
    // ★ 화면에 문구를 적어두지 않는다. 목록이 두 군데로 갈리면 서버가 모르는
    //   버튼이 생기고, 눌러도 400 만 뜬다.
    expect(await screen.findByRole('button', { name: '잠깐만' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '안녕' })).toBeInTheDocument();
  });

  it('누르면 텍스트가 아니라 line_id 를 보낸다 (I9)', async () => {
    renderRoom();
    fireEvent.click(await screen.findByRole('button', { name: '안녕' }));
    await waitFor(() => expect(api.sayLobbyLine).toHaveBeenCalledWith(ROOM_ID, 'hi'));
  });

  it('★ 방금 한 말은 다시 못 누른다 — 연타가 뜻이 되는 걸 막는다', async () => {
    // 서버도 막지만(say_lobby_line), 그건 에러라 빨간 배너가 뜬다.
    // 화면에서 먼저 잠가야 정상적인 조급함이 오류로 보이지 않는다.
    api.fetchMe.mockResolvedValue(me({ player: { ...PLAYERS[0], lobby_line: '안녕' } }));
    db.fetchRoster.mockResolvedValue([{ ...PLAYERS[0], lobby_line: '안녕' }, PLAYERS[1]]);

    renderRoom();
    await waitFor(() => expect(screen.getByRole('button', { name: '안녕' })).toBeDisabled());
    expect(screen.getByRole('button', { name: '잠깐만' })).toBeEnabled();
  });

  it('남의 말풍선이 좌석에 뜬다', async () => {
    renderRoom();
    // 사람마다 지금 한 줄만. 기록이 아니라 쌓이지 않는다.
    expect(await screen.findByText('ㅋㅋㅋ')).toBeInTheDocument();
  });

  it('준비 완료를 누르면 서버로 간다', async () => {
    // 방장이 아닌 사람의 화면이다 — 방장에게는 이 버튼이 없다 (바로 아래 검사).
    db.fetchRoomByCode.mockResolvedValue(room({ host_id: 'p2' }));
    api.fetchMe.mockResolvedValue(me({ is_host: false }));

    renderRoom();
    // 정규식으로 두면 켜진 뒤의 '준비 완료'까지 걸린다. 이름 그대로 찾는다.
    fireEvent.click(await screen.findByRole('button', { name: '준비' }));
    await waitFor(() => expect(api.setLobbyReady).toHaveBeenCalledWith(ROOM_ID, true));
  });

  it('★ 방장에게는 준비 버튼이 없다 — 「게임 시작」이 그 자리다 (2026-08-07)', async () => {
    // 준비를 누르고 시작을 또 누르는 건 같은 뜻의 조작을 두 번 하는 것이다.
    // 버튼만 없애고 조건을 남기면 방이 영영 안 열리므로 startBlock 도 같이 뺐다
    // (아래 「방장이 준비를 안 눌러도 시작할 수 있다」가 그 짝이다).
    renderRoom();
    await screen.findByRole('button', { name: /게임 시작/ });
    expect(screen.queryByRole('button', { name: '준비' })).not.toBeInTheDocument();
  });

  it('★ 게임이 시작되면 말하기 판이 사라진다', async () => {
    // 대기방에만 있는 기능이다. question 으로 넘어가면 조작판이 통째로 바뀐다.
    db.fetchRoomByCode.mockResolvedValue(room({ phase: 'question', round: 1, phase_seq: 1 }));
    db.fetchQuestions.mockResolvedValue([question('c1', 'common', 1)]);

    renderRoom();
    await screen.findByPlaceholderText('답');
    expect(screen.queryByRole('button', { name: '안녕' })).not.toBeInTheDocument();
  });
});

describe('★ 시작 버튼', () => {
  /**
   * 전원이 준비를 누른 명단. 2026-08-06 부터 **그래야만 시작할 수 있다**
   * (lib/game/rules.ts 의 startBlock — 화면과 서버가 같은 함수를 본다).
   */
  const ALL_READY = PLAYERS.map((p) => ({ ...p, is_ready: true }));

  it('「게임 시작」은 월드 시작이다 — 2D 시작(/api/room/start)을 부르지 않는다', async () => {
    // 2026-08-06 결정. 대기방의 시작은 world_started_at 만 찍는다 —
    // 2D 상태머신(fillWithBots · 역할 배정 · phase 전환)은 타지 않는다.
    db.fetchRoster.mockResolvedValue(ALL_READY);

    renderRoom();
    fireEvent.click(await screen.findByRole('button', { name: /게임 시작/ }));

    await waitFor(() => expect(api.startWorld).toHaveBeenCalledWith(ROOM_ID));
    expect(api.startRoom).not.toHaveBeenCalled();
  });

  it('연타해도 요청은 한 번만 나간다', async () => {
    // 서버 쪽도 멱등이지만(start-world 의 is null 조건), 화면에서 먼저 막는 편이
    // 요청 하나를 아낀다 — 스토어의 pending 게이트가 막는다 (reducer.ts).
    db.fetchRoster.mockResolvedValue(ALL_READY);
    api.startWorld.mockImplementation(() => new Promise(() => {})); // 끝나지 않는 요청

    renderRoom();
    const button = await screen.findByRole('button', { name: /게임 시작/ });

    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(api.startWorld).toHaveBeenCalledTimes(1));
  });

  /*
   * ── 시작 조건 (2026-08-07 결정: 사람 2~8명 + 방장 뺀 전원 준비) ──────────
   * 화면에서 먼저 막는 이유는 요청을 아끼려는 게 아니라 **이유를 보여주기** 위해서다.
   * 서버도 같은 함수로 거절하므로(start-world 라우트) 여기만 뚫려도 판은 안 열린다.
   */
  /** 방장(p1)만 준비 전인 명단. 방장은 준비에서 빠지므로 이건 **시작할 수 있는** 상태다 */
  const HOST_NOT_READY = [PLAYERS[0], { ...PLAYERS[1], is_ready: true }];
  /** 방장이 아닌 p2 가 준비 전인 명단. 이쪽이 진짜로 막히는 상태다 */
  const GUEST_NOT_READY = [{ ...PLAYERS[0], is_ready: true }, { ...PLAYERS[1], is_ready: false }];

  it('한 명이라도 준비를 안 했으면 눌리지 않는다', async () => {
    db.fetchRoster.mockResolvedValue(GUEST_NOT_READY);

    renderRoom();
    const button = await screen.findByRole('button', { name: /게임 시작/ });

    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(api.startWorld).not.toHaveBeenCalled();
  });

  it('왜 못 누르는지 화면에 적는다', async () => {
    db.fetchRoster.mockResolvedValue(GUEST_NOT_READY);
    renderRoom();
    expect(await screen.findByText(/아직 준비하지 않은 사람이 있다/)).toBeTruthy();
  });

  it('★ 방장이 준비를 안 눌러도 시작할 수 있다 (2026-08-07)', async () => {
    // 방장에게는 준비 버튼이 없다. 조건에서 안 빼면 **자기 버튼이 자기 때문에**
    // 잠긴 채로 남아, 그 방은 아무도 열 수 없다.
    db.fetchRoster.mockResolvedValue(HOST_NOT_READY);

    renderRoom();
    fireEvent.click(await screen.findByRole('button', { name: /게임 시작/ }));
    await waitFor(() => expect(api.startWorld).toHaveBeenCalledWith(ROOM_ID));
  });

  it('혼자면 전원이 준비해도 눌리지 않는다 — 사람 2명부터다', async () => {
    // 혼자 시작하면 연기자가 없고 나머지가 AI라 아무나 찍어도 정답이 된다.
    db.fetchRoster.mockResolvedValue([ALL_READY[0]]);

    renderRoom();
    expect(await screen.findByRole('button', { name: /게임 시작/ })).toBeDisabled();
    expect(await screen.findByText(/2명 이상이어야/)).toBeTruthy();
  });
});

describe('★ 월드 시작 신호 (world_started_at)', () => {
  it('값이 차 있으면 대기방 대신 /world 로 보낸다', async () => {
    // 방장의 시작이 rooms.world_started_at 을 찍으면 rooms 구독이 방 쿼리를
    // 무효화해 이 값이 온다. 값 기준이라 **시작 뒤에 들어온 사람도** 곧장 넘어간다.
    db.fetchRoomByCode.mockResolvedValue(room({ world_started_at: '2026-08-06T00:00:00.000Z' }));
    renderRoom();

    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/world?code=UFJR'));
  });

  it('★ 월드로 넘어가는 이동은 자리를 빼지 않는다', async () => {
    // 떠남 감지(useLeaveRoomOnExit)는 "주소가 바뀐 채 걷히면 나갔다"로 본다.
    // 월드 이동이 markLeft 없이 걷히면 **전원이 동시에 자리를 빼서** 마지막
    // 나가기가 방 자체를 지운다 — 월드는 같은 자리로 재입장하는 것이지
    // 떠나는 게 아니다 (room-lobby.tsx 의 이동 효과).
    db.fetchRoomByCode.mockResolvedValue(room({ world_started_at: '2026-08-06T00:00:00.000Z' }));
    const { unmount } = renderRoom();
    await waitFor(() => expect(nav.replace).toHaveBeenCalled());

    // 라우터가 목이라 주소·언마운트는 직접 흉내 낸다 — 실제 이동에서 일어나는 순서다.
    window.history.pushState({}, '', '/world?code=UFJR');
    unmount();

    await waitFor(() => expect(api.fetchMe).toHaveBeenCalled());
    expect(api.leaveRoom).not.toHaveBeenCalled();
  });
});

describe('답변 제출', () => {
  const inQuestion = () => {
    db.fetchRoomByCode.mockResolvedValue(room({ phase: 'question', round: 1, phase_seq: 1 }));
    db.fetchQuestions.mockResolvedValue([question('c1', 'common', 1)]);
  };

  it('접수되면 입력칸이 비워진다', async () => {
    inQuestion();
    renderRoom();

    const input = await screen.findByPlaceholderText('답');
    fireEvent.change(input, { target: { value: '나는 사람이다' } });
    fireEvent.click(screen.getByRole('button', { name: '제출' }));

    await waitFor(() => expect(api.submitAnswer).toHaveBeenCalledWith(ROOM_ID, '나는 사람이다'));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''));
  });

  it('★ 실패하면 입력칸을 비우지 않고 배너를 띄운다', async () => {
    inQuestion();
    api.submitAnswer.mockRejectedValue(new Error('이미 답했다'));
    renderRoom();

    const input = await screen.findByPlaceholderText('답');
    fireEvent.change(input, { target: { value: '아까운 답' } });
    fireEvent.click(screen.getByRole('button', { name: '제출' }));

    expect(await screen.findByText('이미 답했다')).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe('아까운 답');
  });
});

describe('★ 라운드2를 푸는 동안 라운드1의 답이 남는다', () => {
  it('지난 질문의 답을 "지난 질문 ·" 라벨과 함께 띄운다', async () => {
    // 답은 페이즈가 끝나야 열리는데 그 순간이 곧 다음 질문으로 넘어가는 순간이라,
    // "지금 질문의 답"만 그리면 한 판 내내 아무것도 안 뜬다 (lib/queries/derive.ts).
    db.fetchRoomByCode.mockResolvedValue(room({ phase: 'question', round: 2, phase_seq: 2 }));
    db.fetchQuestions.mockResolvedValue([
      question('c1', 'common', 1),
      question('c2', 'common', 2),
    ]);
    db.fetchAnswers.mockResolvedValue([
      { id: 'a1', question_id: 'c1', player_id: 'p1', text: '라운드1 답' },
    ]);

    renderRoom();

    expect(await screen.findByText('라운드1 답')).toBeInTheDocument();
    expect(screen.getByText(/지난 질문 · c1 질문/)).toBeInTheDocument();
  });
});

describe('방 정보 실패', () => {
  it('없는 코드면 전체 화면으로 알린다', async () => {
    db.fetchRoomByCode.mockResolvedValue(null);
    renderRoom();
    expect(await screen.findByText('그런 방이 없다: UFJR')).toBeInTheDocument();
  });
});
