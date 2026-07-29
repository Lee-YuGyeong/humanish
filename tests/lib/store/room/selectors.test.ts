/**
 * 셀렉터 — "언제 버튼이 눌리는가"를 한 곳에서 검사한다.
 *
 * 예전에는 이 조건이 버튼마다 흩어져 있었고, 실제로 답변 제출 버튼은 busy 를
 * 보지 않았다 (시작 버튼만 봤다). 이름을 붙여 모아 두면 그런 누락이 검사로 걸린다.
 */

import { describe, expect, it } from 'vitest';

import {
  initialRoomUiState,
  selectCanCastVote,
  selectCanSendChat,
  selectCanSubmitAnswer,
  selectIsBusy,
  selectIsPending,
  type RoomUiState,
} from '@/lib/store/room';

function state(patch: Partial<RoomUiState> = {}): RoomUiState {
  return { ...initialRoomUiState, ...patch };
}

describe('selectIsBusy · selectIsPending', () => {
  it('요청이 없으면 한가하다', () => {
    expect(selectIsBusy(state())).toBe(false);
  });

  it('무엇이 나가 있는지 이름으로 구분한다', () => {
    const s = state({ pending: '시작' });
    expect(selectIsBusy(s)).toBe(true);
    expect(selectIsPending('시작')(s)).toBe(true);
    expect(selectIsPending('답변')(s)).toBe(false);
  });
});

describe('제출 가능 조건', () => {
  it('빈 답은 못 낸다', () => {
    expect(selectCanSubmitAnswer(state({ answerDraft: '' }))).toBe(false);
    expect(selectCanSubmitAnswer(state({ answerDraft: '   ' }))).toBe(false);
    expect(selectCanSubmitAnswer(state({ answerDraft: '답' }))).toBe(true);
  });

  it('★ 요청이 나가 있으면 답도 채팅도 투표도 전부 잠긴다', () => {
    const busy = { pending: '답변' };
    expect(selectCanSubmitAnswer(state({ ...busy, answerDraft: '답' }))).toBe(false);
    expect(selectCanSendChat(state({ ...busy, chatDraft: '말' }))).toBe(false);
    expect(selectCanCastVote(state({ ...busy, voteTarget: 'p2' }))).toBe(false);
  });

  it('공백만 있는 채팅은 못 보낸다', () => {
    expect(selectCanSendChat(state({ chatDraft: ' \n ' }))).toBe(false);
  });

  it('투표는 자리를 골라야 하고, 이유는 선택이다 (SPEC §5.5)', () => {
    expect(selectCanCastVote(state({ voteTarget: null, voteReason: '이유는 썼다' }))).toBe(false);
    expect(selectCanCastVote(state({ voteTarget: 'p2', voteReason: '' }))).toBe(true);
  });
});
