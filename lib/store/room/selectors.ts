/**
 * 방 화면의 클라이언트 상태 — **셀렉터**. 소유: A
 *
 * ★ 여기 있는 것은 전부 `(RoomUiState) => T` 인 순수 함수다. 스토어를 모른다.
 *   그래서 객체 하나 만들어 부르면 검사가 끝난다 (tests/lib/store/room/).
 *
 * ┌─ 왜 컴포넌트에서 계산하지 않는가 ──────────────────────────────────────────┐
 * │ `!text.trim() || busy` 같은 조건이 버튼마다 흩어져 있으면, "요청이 나가     │
 * │ 있을 때 잠근다"는 규칙이 어느 버튼에서는 빠진다. 실제로 예전 화면에서       │
 * │ 제출 버튼은 busy 를 안 봤다 — 시작 버튼만 봤다.                            │
 * │ 조건에 이름을 붙여 한 곳에 두면 빠뜨린 자리가 눈에 띈다.                    │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * 셀렉터는 **원시값이나 안정된 참조**를 돌려준다. 새 객체·새 배열을 만들면
 * zustand 가 매번 다른 값으로 보고 무한히 다시 그린다.
 */

import type { RoomUiState } from './reducer';

/* ─────────────────────────────── 그대로 꺼내는 것 ─────────────────────────────── */

export const selectError = (s: RoomUiState): string | null => s.error;
export const selectPending = (s: RoomUiState): string | null => s.pending;
export const selectAnswerDraft = (s: RoomUiState): string => s.answerDraft;
export const selectChatDraft = (s: RoomUiState): string => s.chatDraft;
export const selectVoteReason = (s: RoomUiState): string => s.voteReason;
export const selectVoteTarget = (s: RoomUiState): string | null => s.voteTarget;

/* ─────────────────────────────── 파생 ─────────────────────────────── */

/** 쓰기 요청이 나가 있다. 모든 제출 버튼이 이걸 본다. */
export const selectIsBusy = (s: RoomUiState): boolean => s.pending !== null;

/** 특정 요청이 나가 있는가. 버튼 문구를 그 버튼에서만 바꾸려고 쓴다. */
export const selectIsPending =
  (name: string) =>
  (s: RoomUiState): boolean =>
    s.pending === name;

export const selectCanSubmitAnswer = (s: RoomUiState): boolean =>
  s.pending === null && s.answerDraft.trim().length > 0;

export const selectCanSendChat = (s: RoomUiState): boolean =>
  s.pending === null && s.chatDraft.trim().length > 0;

/** 이유는 선택이다 (SPEC §5.5). 자리를 고르지 않으면 못 던진다. */
export const selectCanCastVote = (s: RoomUiState): boolean =>
  s.pending === null && s.voteTarget !== null;
