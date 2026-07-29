/**
 * reducer 를 zustand 스토어로 만드는 글루. 소유: A
 *
 * ┌─ 왜 Redux 가 아니라 이 조합인가 ───────────────────────────────────────────┐
 * │ 원하는 것은 Redux 의 **모양**(순수 reducer · 액션 · 셀렉터)이지 Redux 의    │
 * │ 런타임이 아니다. 이 저장소에는 이미 zustand 가 있고, 무엇보다              │
 * │ app/world/store.ts 는 좌표를 Map 안에서 **제자리 변형**한다 —              │
 * │ 8인 × 10Hz 를 불변 업데이트로 바꾸면 초당 80번 리렌더가 난다.              │
 * │ 스토어 런타임을 둘로 늘리지 않으면서 계층만 가져오는 방법이 이것이다.       │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * 상태를 `state` 키 아래에 한 겹 넣는다. dispatch 와 같은 평면에 두면 reducer 의
 * 타입에 dispatch 가 섞여서 `(S, A) => S` 라는 순수한 모양이 깨진다.
 */

import { create, type UseBoundStore, type StoreApi } from 'zustand';

export interface ReducerStore<S, A> {
  state: S;
  dispatch(action: A): void;
}

export type BoundReducerStore<S, A> = UseBoundStore<StoreApi<ReducerStore<S, A>>>;

export function createReducerStore<S, A>(
  reducer: (state: S, action: A) => S,
  initial: S,
): BoundReducerStore<S, A> {
  return create<ReducerStore<S, A>>((set) => ({
    state: initial,
    // set 은 동기다. 그래서 dispatch 직후 getState() 로 읽으면 반영돼 있고,
    // 그 성질에 기대어 "한 번에 하나만" 잠금을 건다 (lib/queries/mutations.ts).
    dispatch: (action) => set((store) => ({ state: reducer(store.state, action) })),
  }));
}
