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
  submitAnswer: vi.fn(),
  castVote: vi.fn(),
  sendMessage: vi.fn(),
  sayLobbyLine: vi.fn(),
  setLobbyReady: vi.fn(),
  advancePhase: vi.fn(),
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
    roster_seq: 1,
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
  api.submitAnswer.mockResolvedValue({});
  api.sayLobbyLine.mockResolvedValue({});
  api.setLobbyReady.mockResolvedValue({});
});

afterEach(cleanup);

/* ─────────────────────────────── 검사 ─────────────────────────────── */

describe('대기실', () => {
  it('방 코드와 정원을 그린다', async () => {
    renderRoom();
    // 코드는 두 군데 뜬다 — 머리말의 번호판과 영사막의 큰 글씨. 둘 다 있는 게 맞다.
    expect(await screen.findAllByText('UFJR')).toHaveLength(2);
    // 좌석 2명 / 정원 5
    expect(await screen.findByText('/5')).toBeInTheDocument();
  });

  it('capacity 만큼 좌석 칸이 그려진다 (SPEC §17.6)', async () => {
    db.fetchRoomByCode.mockResolvedValue(room({ capacity: 8 }));
    renderRoom();
    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBe(8));
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
    renderRoom();
    // 정규식으로 두면 켜진 뒤의 '준비 완료'까지 걸린다. 이름 그대로 찾는다.
    fireEvent.click(await screen.findByRole('button', { name: '준비' }));
    await waitFor(() => expect(api.setLobbyReady).toHaveBeenCalledWith(ROOM_ID, true));
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

describe('★ 시작 버튼을 연타해도 요청은 한 번만 나간다', () => {
  it('같은 프레임에 두 번 눌러도 POST /api/room/start 는 1회다', async () => {
    // 두 번 나가면 각자의 시드로 역할을 upsert 해서, 이미 시작된 판의 스파이가
    // 다른 사람으로 바뀔 수 있다 (lib/store/room/reducer.ts 의 pending 주석).
    // 예전에는 inFlightRef 가 막았고, 지금은 스토어의 pending 이 막는다.
    api.startRoom.mockImplementation(() => new Promise(() => {})); // 끝나지 않는 요청

    renderRoom();
    const button = await screen.findByRole('button', { name: /게임 시작/ });

    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(api.startRoom).toHaveBeenCalledTimes(1));
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
