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
import { useCallback, useEffect, useRef } from 'react';

import { ApiRequestError } from '@/lib/api/client';
import {
  advancePhase,
  castVote,
  kickPlayer,
  leaveRoom,
  sayLobbyLine,
  sendMessage,
  setLobbyReady,
  setLobbyName,
  startRoom,
  startWorld,
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
  kick: '내보내기',
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

/**
 * 월드 시작 (2026-08-06 결정). 대기방의 「게임 시작」이 이걸 쓴다 — 2D 시작
 * (useStartRoom)과 같은 게이트(REQUEST.start)를 탄다. 화면에 시작 버튼은 하나뿐이라
 * 게이트 이름이 겹쳐도 충돌할 상대가 없다.
 */
export function useStartWorld(code: string, roomId: string | undefined) {
  return useRoomWrite<void>(REQUEST.start, code, roomId, () => startWorld(roomId!));
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
 * 강퇴 — 방장이 한 사람을 내보낸다 (2026-08-07).
 *
 * ★ 다른 쓰기와 같은 게이트를 쓴다(useRoomWrite). 연타로 두 사람이 한꺼번에
 *   나가는 일이 여기서 막힌다 — 좌석 카드가 여덟이라 오조작이 쉬운 자리다.
 * ★ 성공하면 그 방 쿼리가 무효화되어 명단을 다시 읽는다. **내보내진 사람의
 *   화면은 여기가 아니라 roster_seq 신호로 안다** (§17.3) — 그쪽에는 이 요청이
 *   가지 않으므로, 서버가 알려주는 유일한 길이 그 신호다.
 */
export function useKickPlayer(code: string, roomId: string | undefined) {
  return useRoomWrite<string>(REQUEST.kick, code, roomId, (targetId) =>
    kickPlayer(roomId!, targetId),
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
 * 대기실 화면을 떠나면 자리도 뺀다 — 뒤로가기·앞으로가기까지 포함해서.
 *
 * ┌─ 왜 필요한가 ──────────────────────────────────────────────────────────────┐
 * │ "대기실을 떠나는 길은 전부 자리를 뺀다"가 규칙인데(room-lobby.tsx 주석),     │
 * │ 브라우저 뒤로가기는 그 규칙 밖에 있었다. 화면만 /main 으로 넘어가고 자리는   │
 * │ 남아서, 아무도 없는 방이 목록에 계속 뜨고 방 코드도 24시간 묶였다            │
 * │ (cleanup_stale_rooms 전까지). 나가기 버튼이 고친 그 문제 그대로다.          │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 신호를 둘 듣는다. 하나로는 못 믿는다 ─────────────────────────────────────┐
 * │ ① popstate  — 뒤로/앞으로가 눌렸다. 화면이 안 걷히는 경우까지 잡는다        │
 * │              (Next 가 뒤 화면을 캐시해 두고 살려두는 경로가 있다).          │
 * │ ② 언마운트   — 이 화면이 실제로 걷혔다. popstate 가 안 오는 이동까지 잡는다. │
 * │ 둘 다 같은 sent 표를 본다. 어느 쪽이 먼저 와도 요청은 한 번이다.            │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ★ **언마운트만으로 판단하면 안 된다.** 이 화면은 떠나지 않아도 걷힌다 —
 *   게임이 시작되면 대기실이 게임 화면으로 바뀌고, 개발 모드의 StrictMode·HMR 은
 *   붙였다 떼기를 반복한다. 그때마다 자리를 빼면 **시작하자마자 스스로 쫓겨난다.**
 *   그래서 걷힌 뒤 **주소가 바뀌었는지**를 본다. 주소가 그대로면 떠난 게 아니다.
 *
 * ★ 새로고침·탭 닫기(pagehide)는 **일부러 듣지 않는다.** 새로고침은 같은 방으로
 *   돌아오는 것이라 거기서 자리를 빼면 자기 자리를 없애고 다시 들어오게 된다.
 *
 * ★ 화면 이동을 막지도 미루지도 않는다. 뒤로가기는 즉시 넘어가고 요청은 뒤따라간다 —
 *   같은 문서 안의 이동이라 페이지가 살아 있어서 fetch 가 끊기지 않는다.
 *
 * ★ 대기실에서만 부른다. 시작한 방은 서버가 409 로 거절한다 (SPEC §15-4 미결정,
 *   supabase/functions/room.sql 의 leave_room).
 *
 * @returns markLeft — 나가기 버튼이 이미 보냈다고 알리는 표. 버튼은 성공한 **뒤에**
 *          /main 으로 넘어가는데(room-lobby.tsx), 그 이동이 여기 언마운트를 부른다.
 *          표를 안 찍으면 같은 나가기가 두 번 나간다.
 */
export function useLeaveRoomOnExit(roomId: string | undefined): { markLeft: () => void } {
  const qc = useQueryClient();
  /** 이 방은 이미 보냈다. 두 신호와 나가기 버튼이 같이 본다. */
  const sent = useRef(false);

  const send = useCallback(() => {
    if (sent.current || !roomId) return;
    sent.current = true;

    void leaveRoom(roomId)
      .catch(() => {
        // 배너를 띄울 화면이 이미 없다. 여기서 삼키지 않으면 처리되지 않은
        // 거부가 되어 콘솔만 시끄러워진다.
      })
      .finally(() => void qc.invalidateQueries({ queryKey: openRoomsKey }));
  }, [roomId, qc]);

  const markLeft = useCallback(() => {
    sent.current = true;
  }, []);

  useEffect(() => {
    if (!roomId) return;
    sent.current = false;

    // 붙을 때의 주소를 적어둔다. 걷힐 때 이게 그대로면 화면만 바뀐 것이다.
    const here = window.location.pathname;
    const onPopState = () => send();
    window.addEventListener('popstate', onPopState);

    return () => {
      window.removeEventListener('popstate', onPopState);
      if (window.location.pathname !== here) send();
    };
  }, [roomId, send]);

  return { markLeft };
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
