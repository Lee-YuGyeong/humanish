'use client';

/**
 * 방 화면의 쓰기 — 뮤테이션 훅. 소유: A
 *
 * 쓰기는 전부 /api 를 지난다 (I9). 여기서 anon 키로 DB 에 쓰지 않는다.
 *
 * ┌─ "한 번에 하나만" 을 어디서 지키는가 ──────────────────────────────────────┐
 * │ react-query 의 isPending 은 **렌더 뒤에** true 가 된다. 같은 프레임에 두 번 │
 * │ 클릭하면 둘 다 통과한다. 시작 버튼에서 그게 실제로 문제가 된다 —            │
 * │ 두 요청이 각자의 시드로 역할을 upsert 해서 이미 시작된 판의 스파이가        │
 * │ 바뀔 수 있다 (reducer.ts 의 pending 주석).                                  │
 * │                                                                            │
 * │ 그래서 게이트를 스토어에 둔다. zustand 의 set 은 동기라, dispatch 한 다음   │
 * │ 줄에서 readRoomUi() 로 읽으면 이미 반영돼 있다. 아래 run() 이 그 순서다.    │
 * └────────────────────────────────────────────────────────────────────────────┘
 */

import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { useCallback } from 'react';

import { ApiRequestError } from '@/lib/api/client';
import {
  advancePhase,
  castVote,
  leaveRoom,
  sayLobbyLine,
  sendMessage,
  setLobbyReady,
  setLobbyName,
  startRoom,
  submitAnswer,
} from '@/lib/api/room';
import { dispatchRoom, readRoomUi, roomActions } from '@/lib/store/room';
import { openRoomsKey } from './keys';
import { useInvalidateRoom } from './room';

/** 요청 이름. 버튼 문구와 게이트 판정에 같이 쓰이므로 문자열을 흩뿌리지 않는다. */
export const REQUEST = {
  start: '시작',
  answer: '답변',
  vote: '지목',
  message: '채팅',
  advance: '전환',
  lobbyLine: '대기방 발화',
  lobbyReady: '준비',
  lobbyName: '이름',
  leave: '나가기',
} as const;

function messageOf(e: unknown): string {
  if (e instanceof ApiRequestError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

/**
 * 뮤테이션 하나를 만든다. 성공·실패 어느 쪽이든
 *   ① 게이트를 풀고 ② 그 방 쿼리를 전부 무효화한다.
 *
 * 무효화를 항상 하는 이유: 실패했어도 서버 상태가 이미 바뀌었을 수 있다
 * (예 — 전환은 됐는데 응답이 끊긴 경우). 실패했으니 안 읽는다고 두면
 * 화면만 옛날 상태로 남는다.
 */
function useRoomWrite<TVars>(
  name: string,
  code: string,
  roomId: string | undefined,
  fn: (vars: TVars) => Promise<unknown>,
  onSuccess?: () => void,
): { run: (vars: TVars) => void; mutation: UseMutationResult<unknown, Error, TVars> } {
  const invalidate = useInvalidateRoom(code, roomId);

  const mutation = useMutation<unknown, Error, TVars>({
    mutationFn: fn,
    onSuccess: () => {
      dispatchRoom(roomActions.requestSucceeded());
      onSuccess?.();
    },
    onError: (e) => dispatchRoom(roomActions.requestFailed(messageOf(e))),
    onSettled: () => void invalidate(),
  });

  const run = useCallback(
    (vars: TVars) => {
      // ★ 동기 검사 → 동기 기록 → 발사. 이 순서라야 같은 프레임의 두 번째 클릭이 막힌다.
      if (readRoomUi().pending !== null) return;
      dispatchRoom(roomActions.requestStarted(name));
      mutation.mutate(vars);
    },
    [mutation, name],
  );

  return { run, mutation };
}

/* ─────────────────────────────── 화면이 쓰는 것 ─────────────────────────────── */

export function useStartRoom(code: string, roomId: string | undefined) {
  return useRoomWrite<void>(REQUEST.start, code, roomId, () => startRoom(roomId!));
}

export function useSubmitAnswer(code: string, roomId: string | undefined) {
  return useRoomWrite<string>(
    REQUEST.answer,
    code,
    roomId,
    (text) => submitAnswer(roomId!, text),
    // 접수된 뒤에만 입력칸을 비운다. 실패하면 사람이 쓴 걸 잃지 않는다.
    () => dispatchRoom(roomActions.answerAccepted()),
  );
}

export function useCastVote(code: string, roomId: string | undefined) {
  return useRoomWrite<{ targetId: string; reason: string }>(
    REQUEST.vote,
    code,
    roomId,
    ({ targetId, reason }) => castVote(roomId!, targetId, reason),
  );
}

export function useSendMessage(code: string, roomId: string | undefined) {
  return useRoomWrite<string>(REQUEST.message, code, roomId, (text) => sendMessage(roomId!, text));
}

/**
 * 대기방 프리셋 발화 (SPEC §15-3-결정).
 *
 * 게이트를 같이 탄다. 연타 자체는 서버가 쿨다운으로 막지만, 그건 **에러로** 막는
 * 것이라 배너가 뜬다. 화면에서 먼저 잠가서 정상적인 조급함이 오류로 보이지 않게 한다.
 */
export function useSayLobbyLine(code: string, roomId: string | undefined) {
  return useRoomWrite<string>(REQUEST.lobbyLine, code, roomId, (lineId) =>
    sayLobbyLine(roomId!, lineId),
  );
}

/** 준비 완료 토글. 같은 값으로 다시 보내도 서버가 아무 일도 하지 않는다. */
export function useSetLobbyReady(code: string, roomId: string | undefined) {
  return useRoomWrite<boolean>(REQUEST.lobbyReady, code, roomId, (ready) =>
    setLobbyReady(roomId!, ready),
  );
}

/**
 * 대기방에서 부를 이름 (SPEC §15-2-결정).
 *
 * ★ 성공하면 방 쿼리가 무효화되어 roster 를 다시 읽는다(useRoomWrite 가 한다).
 *   그래야 내가 바꾼 이름이 좌석 카드에 바로 뜬다 — 다른 사람 화면은
 *   roster_seq 신호가 알려준다 (§17.3).
 */
export function useSetLobbyName(code: string, roomId: string | undefined) {
  return useRoomWrite<string | null>(REQUEST.lobbyName, code, roomId, (name) =>
    setLobbyName(roomId!, name),
  );
}

/**
 * 방에서 나간다. 자리가 빠지고, **마지막 사람이었으면 방 자체가 사라진다.**
 *
 * ★ 그 방 쿼리를 무효화하지 않는다. 다른 쓰기와 반대다 —
 *   나간 뒤에는 그 방을 읽을 자격이 없다(쿠키를 지웠고, 방은 아예 없을 수도 있다).
 *   무효화하면 아직 화면에 붙어 있는 me·roster 가 즉시 다시 요청을 보내 401·404 를
 *   받아오고, **나가는 데 성공했는데 빨간 배너가 뜬다.** 대신 방 목록만 새로 읽는다 —
 *   /main 으로 돌아갔을 때 사라진 방이 남아 있으면 안 되기 때문이다.
 *
 * 초안·잠금 같은 화면 상태는 room-view 가 언마운트될 때 roomLeft 로 스스로 지운다.
 *
 * @param onLeft 성공했을 때 부른다. **화면 이동은 여기서 하지 않는다** —
 *               라우터는 화면의 것이고, 이 계층은 요청까지만 맡는다.
 */
export function useLeaveRoom(
  roomId: string | undefined,
  onLeft?: (roomDeleted: boolean) => void,
) {
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => leaveRoom(roomId!),
    onSuccess: (res) => {
      dispatchRoom(roomActions.requestSucceeded());
      onLeft?.(res.room_deleted);
    },
    onError: (e) => dispatchRoom(roomActions.requestFailed(messageOf(e))),
    onSettled: () => void qc.invalidateQueries({ queryKey: openRoomsKey }),
  });

  const run = useCallback(() => {
    // 다른 쓰기와 같은 게이트. 연타로 두 번 나가는 것도 여기서 막힌다.
    if (readRoomUi().pending !== null) return;
    dispatchRoom(roomActions.requestStarted(REQUEST.leave));
    mutation.mutate();
  }, [mutation]);

  return { run, mutation };
}

/**
 * 페이즈 전환 요청 (SPEC §5.2).
 *
 * ★ 게이트를 타지 않는다. 이건 사람이 누르는 버튼이 아니라 타이머가 부르는 것이고,
 *   사람이 답을 제출하는 중이라고 해서 전환이 밀리면 안 된다. 중복 방지는
 *   expected_seq 가 맡는다 (I6) — 낙관적 잠금이라 두 번 보내도 한 번만 전환된다.
 */
export function useAdvancePhase(code: string, roomId: string | undefined) {
  const invalidate = useInvalidateRoom(code, roomId);

  return useMutation({
    mutationFn: ({ expectedSeq }: { expectedSeq: number }) => advancePhase(roomId!, expectedSeq),
    onSettled: () => void invalidate(),
  });
}
