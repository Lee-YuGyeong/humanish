/**
 * 방 화면의 클라이언트 상태 — **액션**. 소유: A
 *
 * ┌─ 이 폴더에 들어오는 것과 안 들어오는 것 ───────────────────────────────────┐
 * │ 들어온다  서버가 모르는 것: 입력칸 초안, 고른 자리, 실패 배너, 요청 잠금    │
 * │ 안 들어온다 서버가 아는 것: 방·좌석·질문·답변·투표 → lib/queries (캐시)     │
 * │                                                                            │
 * │ 이 경계를 흐리면 같은 값이 두 군데 살고, 둘이 어긋날 때 어느 쪽이 맞는지    │
 * │ 알 수 없어진다. 서버 값을 스토어에 복사해 두지 않는다.                     │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * 액션은 **일어난 일**을 적는다. "무엇을 바꿔라"가 아니라 "무슨 일이 있었다"다.
 * 그래야 한 사건에 여러 필드가 딸려 바뀌는 걸 reducer 한 곳에서 볼 수 있다 —
 * 예를 들어 requestFailed 하나가 잠금 해제와 배너를 같이 처리한다.
 */

export type RoomAction =
  /** 쓰기 요청을 **보내기 직전**. name 은 배너·버튼 문구에 쓴다 */
  | { type: 'request/started'; name: string }
  | { type: 'request/succeeded' }
  | { type: 'request/failed'; message: string }
  /** 배너를 손으로 닫았다 */
  | { type: 'error/dismissed' }
  | { type: 'draft/answerChanged'; text: string }
  /** 답이 실제로 접수됐다. 실패했으면 초안을 지우지 않는다 */
  | { type: 'draft/answerAccepted' }
  | { type: 'draft/chatChanged'; text: string }
  | { type: 'draft/chatSent' }
  | { type: 'vote/targetSelected'; playerId: string | null }
  | { type: 'vote/reasonChanged'; text: string }
  /** 방을 떠났다. 다음 방에 이전 방 초안이 새지 않게 한다 */
  | { type: 'room/left' };

export const roomActions = {
  requestStarted: (name: string): RoomAction => ({ type: 'request/started', name }),
  requestSucceeded: (): RoomAction => ({ type: 'request/succeeded' }),
  requestFailed: (message: string): RoomAction => ({ type: 'request/failed', message }),
  errorDismissed: (): RoomAction => ({ type: 'error/dismissed' }),

  answerChanged: (text: string): RoomAction => ({ type: 'draft/answerChanged', text }),
  answerAccepted: (): RoomAction => ({ type: 'draft/answerAccepted' }),

  chatChanged: (text: string): RoomAction => ({ type: 'draft/chatChanged', text }),
  chatSent: (): RoomAction => ({ type: 'draft/chatSent' }),

  voteTargetSelected: (playerId: string | null): RoomAction => ({
    type: 'vote/targetSelected',
    playerId,
  }),
  voteReasonChanged: (text: string): RoomAction => ({ type: 'vote/reasonChanged', text }),

  roomLeft: (): RoomAction => ({ type: 'room/left' }),
} as const;
