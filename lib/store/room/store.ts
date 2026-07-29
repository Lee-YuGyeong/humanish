'use client';

/**
 * 방 화면의 클라이언트 상태 — **스토어**. 소유: A
 *
 * 이 파일이 하는 일은 셋뿐이다: reducer 를 붙이고, 구독용 훅을 주고,
 * 렌더 밖에서 읽는 문(readRoomUi)을 낸다. 상태 규칙은 reducer.ts 에,
 * 파생값은 selectors.ts 에 있다 — 여기에 로직을 더하지 않는다.
 */

import { createReducerStore } from '../create-reducer-store';
import type { RoomAction } from './actions';
import { initialRoomUiState, roomReducer, type RoomUiState } from './reducer';

export const roomUiStore = createReducerStore<RoomUiState, RoomAction>(
  roomReducer,
  initialRoomUiState,
);

/**
 * 셀렉터로 구독한다. 셀렉터는 **상태만** 받으므로 selectors.ts 의 순수 함수를
 * 그대로 넘길 수 있고, 그 함수들은 스토어 없이 단위 테스트된다.
 */
export function useRoomUi<T>(selector: (state: RoomUiState) => T): T {
  return roomUiStore((store) => selector(store.state));
}

/** dispatch 는 스토어 수명 동안 같은 참조라 의존성 배열에 넣어도 안전하다. */
export function useRoomDispatch(): (action: RoomAction) => void {
  return roomUiStore((store) => store.dispatch);
}

/**
 * 렌더 밖에서 지금 값을 읽는다 (이벤트 핸들러·뮤테이션 게이트).
 *
 * ★ 구독이 아니다. 컴포넌트에서 이걸 쓰면 값이 바뀌어도 다시 그리지 않는다.
 *   화면에 그릴 값은 반드시 useRoomUi 로 읽는다.
 */
export function readRoomUi(): RoomUiState {
  return roomUiStore.getState().state;
}

export function dispatchRoom(action: RoomAction): void {
  roomUiStore.getState().dispatch(action);
}
