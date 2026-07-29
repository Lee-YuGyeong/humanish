/**
 * 방 화면의 클라이언트 상태 — **reducer**. 소유: A
 *
 * ★ 이 파일에는 React 도, zustand 도, DB 도 없다. `(state, action) => state` 뿐이다.
 *   그래서 렌더 트리를 세우지 않고 배열 하나로 검사할 수 있다
 *   (tests/lib/store/room/reducer.test.ts). 스토어를 4계층으로 가른 이유의 절반이
 *   이것이고, 나머지 절반은 selectors.ts 다.
 *
 * 규칙 하나: **상태를 제자리에서 고치지 않는다.** 항상 새 객체를 돌려준다.
 *   여기서 mutate 하면 zustand 가 변화를 알아채지 못해 화면이 안 바뀐다.
 *   (app/world/store.ts 는 일부러 반대로 하는데, 그건 10Hz 좌표라 리렌더를
 *    피해야 해서다. 이 화면은 사람이 타이핑하는 속도라 그럴 이유가 없다.)
 */

import type { RoomAction } from './actions';

export interface RoomUiState {
  /**
   * 지금 나가 있는 쓰기 요청의 이름. null 이면 없다.
   *
   * ★ 불리언이 아니라 이름인 이유: **한 번에 하나만 나간다**는 규칙을 지키려면
   *   무엇이 나가 있는지 알아야 버튼 문구를 바꿀 수 있다. 시작 버튼을 연타하면
   *   POST /api/room/start 가 둘 다 나가고, 둘 다 lobby·phase_seq 를 읽은 뒤
   *   각자의 시드로 역할을 upsert 한다. 먼저 도착한 쪽이 전환하면 두 번째는 409 를
   *   받아 **정상 시작된 판에 빨간 에러 배너가 남고**, 그 upsert 가 전환 뒤에
   *   착지하면 이미 시작된 판의 스파이가 다른 사람으로 바뀐다.
   */
  pending: string | null;
  /** 배너 문구. 성공하면 스스로 사라진다 */
  error: string | null;

  answerDraft: string;
  chatDraft: string;
  voteReason: string;
  voteTarget: string | null;
}

export const initialRoomUiState: RoomUiState = {
  pending: null,
  error: null,
  answerDraft: '',
  chatDraft: '',
  voteReason: '',
  voteTarget: null,
};

export function roomReducer(state: RoomUiState, action: RoomAction): RoomUiState {
  switch (action.type) {
    case 'request/started':
      // 새 요청을 보낼 때 이전 실패 문구를 지운다. 안 지우면 성공한 화면에
      // 지난 판의 빨간 배너가 남는다.
      return { ...state, pending: action.name, error: null };

    case 'request/succeeded':
      return { ...state, pending: null, error: null };

    case 'request/failed':
      return { ...state, pending: null, error: action.message };

    case 'error/dismissed':
      return { ...state, error: null };

    case 'draft/answerChanged':
      return { ...state, answerDraft: action.text };

    // ★ 성공했을 때만 비운다. 실패했는데 비우면 사람이 쓴 걸 잃는다.
    case 'draft/answerAccepted':
      return { ...state, answerDraft: '' };

    case 'draft/chatChanged':
      return { ...state, chatDraft: action.text };

    /**
     * 채팅만 **보내는 즉시** 비운다. 답변과 다르다.
     * 채팅은 짧고 연달아 치는 것이라 입력칸이 안 비면 손이 멈춘다.
     * 실패하면 배너로 알리고 문장은 포기한다 — 되살리면 다음 문장과 섞인다.
     */
    case 'draft/chatSent':
      return { ...state, chatDraft: '' };

    case 'vote/targetSelected':
      return { ...state, voteTarget: action.playerId };

    case 'vote/reasonChanged':
      return { ...state, voteReason: action.text };

    case 'room/left':
      return initialRoomUiState;

    default:
      // 모르는 액션은 그대로 흘려보낸다. 타입이 맞으면 여기 오지 않는다.
      return state;
  }
}
