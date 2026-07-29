/**
 * 방 화면 클라이언트 상태 reducer.
 *
 * 이 파일이 성립한다는 것 자체가 계층을 가른 이유다 — 예전에는 같은 규칙이
 * useState 19개와 useEffect 8개에 흩어져 있어서, 검사하려면 화면을 띄우고
 * 버튼을 눌러보는 수밖에 없었다.
 */

import { describe, expect, it } from 'vitest';

import { initialRoomUiState, roomActions, roomReducer, type RoomUiState } from '@/lib/store/room';

/** 상태 하나를 만들어 준다. 검사와 무관한 필드는 초기값을 쓴다. */
function state(patch: Partial<RoomUiState> = {}): RoomUiState {
  return { ...initialRoomUiState, ...patch };
}

describe('요청 잠금 (한 번에 하나만)', () => {
  it('요청이 시작되면 이름을 기록한다', () => {
    const next = roomReducer(state(), roomActions.requestStarted('시작'));
    expect(next.pending).toBe('시작');
  });

  it('요청을 시작할 때 지난 실패 배너를 지운다', () => {
    // 안 지우면 성공한 화면에 지난 판의 빨간 배너가 남는다
    const next = roomReducer(state({ error: '이미 시작된 방이다' }), roomActions.requestStarted('답변'));
    expect(next.error).toBeNull();
  });

  it('성공하면 잠금이 풀린다', () => {
    const next = roomReducer(state({ pending: '답변' }), roomActions.requestSucceeded());
    expect(next.pending).toBeNull();
    expect(next.error).toBeNull();
  });

  it('실패해도 잠금이 풀린다 — 안 풀면 그 화면에서 다시는 못 보낸다', () => {
    const next = roomReducer(state({ pending: '투표' }), roomActions.requestFailed('409'));
    expect(next.pending).toBeNull();
    expect(next.error).toBe('409');
  });
});

describe('입력 초안', () => {
  it('답변은 접수된 뒤에만 비운다', () => {
    const typed = roomReducer(state(), roomActions.answerChanged('나는 사람이다'));
    expect(typed.answerDraft).toBe('나는 사람이다');

    // 실패는 초안을 건드리지 않는다. 사람이 쓴 걸 잃지 않기 위해서다.
    const failed = roomReducer(typed, roomActions.requestFailed('네트워크 오류'));
    expect(failed.answerDraft).toBe('나는 사람이다');

    const accepted = roomReducer(typed, roomActions.answerAccepted());
    expect(accepted.answerDraft).toBe('');
  });

  it('채팅은 보내는 즉시 비운다', () => {
    const typed = roomReducer(state(), roomActions.chatChanged('3번 이상하다'));
    expect(roomReducer(typed, roomActions.chatSent()).chatDraft).toBe('');
  });

  it('답변 초안과 채팅 초안은 서로를 건드리지 않는다', () => {
    const both = roomReducer(
      roomReducer(state(), roomActions.answerChanged('답')),
      roomActions.chatChanged('말'),
    );
    expect(roomReducer(both, roomActions.chatSent()).answerDraft).toBe('답');
  });
});

describe('투표', () => {
  it('자리를 고르고 이유를 적는다', () => {
    const picked = roomReducer(state(), roomActions.voteTargetSelected('p3'));
    const withReason = roomReducer(picked, roomActions.voteReasonChanged('말투가 일정하다'));
    expect(withReason.voteTarget).toBe('p3');
    expect(withReason.voteReason).toBe('말투가 일정하다');
  });

  it('고른 자리를 취소할 수 있다', () => {
    const picked = roomReducer(state({ voteTarget: 'p3' }), roomActions.voteTargetSelected(null));
    expect(picked.voteTarget).toBeNull();
  });
});

describe('방을 떠날 때', () => {
  it('전부 초기화한다 — 다음 방에 새어 나가면 안 된다', () => {
    const dirty = state({
      pending: '답변',
      error: '뭔가 실패',
      answerDraft: '이전 방의 답',
      chatDraft: '이전 방의 말',
      voteReason: '이전 방의 이유',
      voteTarget: 'p7',
    });
    expect(roomReducer(dirty, roomActions.roomLeft())).toEqual(initialRoomUiState);
  });
});

describe('불변성', () => {
  it('받은 상태를 제자리에서 고치지 않는다', () => {
    // 여기서 mutate 하면 zustand 가 변화를 못 알아채 화면이 안 바뀐다
    const before = state();
    const snapshot = { ...before };
    roomReducer(before, roomActions.answerChanged('바뀜'));
    expect(before).toEqual(snapshot);
  });
});
