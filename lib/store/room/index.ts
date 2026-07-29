/**
 * 방 화면 클라이언트 상태의 **공개 표면**. 소유: A
 *
 * 화면은 여기만 import 한다 (`@/lib/store/room`). 안쪽 파일을 직접 가리키면
 * 계층을 건너뛰게 되고 — 예를 들어 reducer 를 컴포넌트에서 직접 부르면 —
 * 스토어를 나눈 의미가 없어진다.
 *
 *   actions.ts    무슨 일이 있었나
 *   reducer.ts    그 일로 상태가 어떻게 바뀌나 (순수)
 *   store.ts      zustand 연결 · 구독 훅
 *   selectors.ts  그 상태에서 무엇을 읽나 (순수)
 */

export { roomActions, type RoomAction } from './actions';
export { initialRoomUiState, roomReducer, type RoomUiState } from './reducer';
export { dispatchRoom, readRoomUi, roomUiStore, useRoomDispatch, useRoomUi } from './store';
export {
  selectAnswerDraft,
  selectCanCastVote,
  selectCanSendChat,
  selectCanSubmitAnswer,
  selectChatDraft,
  selectError,
  selectIsBusy,
  selectIsPending,
  selectPending,
  selectVoteReason,
  selectVoteTarget,
} from './selectors';
