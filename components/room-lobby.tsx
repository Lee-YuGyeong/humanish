"use client";

/**
 * 대기실(방 로비) 화면 — phase='lobby' 일 때 방 화면 대신 이걸 그린다. 소유: C
 *
 * ┌─ 지키는 계약 ──────────────────────────────────────────────────────────┐
 * │ I1  누가 봇인지 표시할 방법이 없다. 그게 정상이다 — 클라이언트는          │
 * │     public_players 만 읽고 거기에는 is_bot 이 없다. 대기실에는 아직      │
 * │     봇이 없으므로(시작 버튼에서 채운다) **봇 수를 어디에도 쓰지 않는다.** │
 * │ I9  쓰기는 전부 /api 를 거친다 (lib/queries/mutations).                  │
 * │ §15-3-결정  대기실에서는 **정해진 문구만 누른다.** 자유 입력이 없다 —    │
 * │     미리 짜는 걸 막기 위해서다. 시안의 채팅 입력칸 자리에 문구 버튼을    │
 * │     넣은 이유가 이것이다. 목록의 원본은 서버 하나뿐이라 여기 적어두지    │
 * │     않는다 (lib/server/lobby-lines.ts).                                 │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 좌석은 <ul>/<li> 로 정원만큼 그린다 — **사람 자리만이다** (2026-08-06 결정:
 *   사람 8 + 시작할 때 AI 1). AI 자리는 여기 그리지 않는다: 대기방에 AI 칸을 미리
 *   세워 두면 시작 전에 "저기가 AI" 라고 손가락질하는 꼴이다 (I1).
 *   규칙·문구 목록에는 리스트 태그를 쓰지 않는다 — 좌석 수를 세는 검사가 그것까지 센다.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { AccountName, TopBar } from "@/components/top-bar";
import type { MeResponse } from "@/lib/api/room";
import { START_BLOCK_MESSAGE, startBlock } from "@/lib/game/rules";
import { useProfile } from "@/lib/queries/auth";
import type { PublicPlayer, Room } from "@/lib/game/types";
import {
  REQUEST,
  useKickPlayer,
  useLeaveRoom,
  useLeaveRoomOnExit,
  useSayLobbyLine,
  useSetLobbyReady,
  useStartWorld,
} from "@/lib/queries/mutations";
import { useLobbyLines, useServerClock } from "@/lib/queries/room";
import { selectIsBusy, selectIsPending, useRoomUi } from "@/lib/store/room";
import styles from "./room-lobby.module.css";

/**
 * 방을 여는 동안 덮어두는 화면.
 *
 * ★ 왜 필요한가: 방 정보(room)는 왔는데 내 자리 정보(me)가 아직 안 온 찰나에
 *   아래 RoomLobby 조건이 거짓이 되어 **옛 창고 화면이 한 번 번쩍인다.**
 *   그 순간 화면에 뜨는 건 직전에 보던 방의 잔상이라 더 나쁘다 — 다 끝난 판의
 *   결과표가 새 방에 들어가는 사람에게 보인다.
 *   여기서 같은 색의 빈 판으로 덮어 그 틈을 없앤다.
 */
export function RoomBoot({ label = "방을 여는 중…" }: { label?: string }) {
  return (
    <div className={`${styles.root} flex h-dvh items-center justify-center`}>
      <div aria-hidden className={styles.backdrop} />
      <div aria-hidden className={styles.noise} />
      <div aria-hidden className={styles.scanlines} />
      <p className={styles.label} aria-live="polite">
        {label}
      </p>
    </div>
  );
}

/**
 * 내보내진 사람이 보는 화면 (2026-08-07).
 *
 * ┌─ 왜 별도 화면인가 ─────────────────────────────────────────────────────┐
 * │ 자리가 없어지면 RoomView 는 게임 화면 쪽으로 떨어지고, 거기 "이 방의     │
 * │ 참가자가 아니다"가 뜬다. 틀린 말은 아니지만 **방금까지 앉아 있던 사람**  │
 * │ 에게는 고장으로 보인다 — 대기방을 보고 있었는데 갑자기 다른 화면의 안내 │
 * │ 문구가 나오기 때문이다.                                                │
 * │ 여기서는 같은 바탕 위에 무슨 일이 있었는지만 말한다.                    │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * ★ 자동으로 튕겨내지 않는다. 화면이 저절로 바뀌면 무슨 일이 있었는지 못 읽는다.
 */
export function RoomKicked() {
  return (
    <div className={`${styles.root} flex h-dvh flex-col items-center justify-center gap-6`}>
      <div aria-hidden className={styles.backdrop} />
      <div aria-hidden className={styles.noise} />
      <div aria-hidden className={styles.scanlines} />
      {/*
        ★ 문구는 서버가 실제로 하는 일과 같아야 한다 (2026-08-08). 예전에는
          "코드를 다시 받아야 합니다"였는데, 코드는 방금까지 앉아 있던 사람이
          이미 알고 있어서 그대로 다시 들어와졌다. 지금은 join_room 이 거절한다
          (room_bans) — 그래서 화면도 "다시 들어올 수 없다"고 말한다.
      */}
      <p className={styles.notice} aria-live="polite">
        방장이 이 방에서 내보냈습니다.
        <span className={styles.noticeSub}>이 방에는 다시 들어올 수 없습니다.</span>
      </p>
      <Link href="/main" className={styles.btnGhost} style={{ width: "auto", padding: "0.7rem 1.6rem" }}>
        <ArrowLeftIcon /> 로비로
      </Link>
    </div>
  );
}

export function RoomLobby({
  code,
  room,
  players,
  me,
  error,
  onLeaving,
}: {
  code: string;
  room: Room;
  players: PublicPlayer[];
  /** player 가 있는 경우만 이 화면을 그린다 (RoomView 가 확인한다) */
  me: MeResponse & { player: PublicPlayer };
  /** 쓰기 실패 배너. 성공하면 스스로 사라진다 */
  error: string | null;
  /**
   * 내가 **스스로** 나가려 한다는 신호 (2026-08-07). 강퇴 화면과 구분하는 데 쓴다 —
   * 둘 다 "내 자리가 없어졌다"로 보이기 때문이다. 요청이 끝나기 전에 부른다:
   * 자리 삭제가 만든 명단 신호가 응답보다 먼저 도착할 수 있어서, 성공 뒤에
   * 알리면 그 찰나에 "내보내졌습니다"가 한 번 번쩍인다.
   */
  onLeaving?: () => void;
}) {
  const seated = players.length;
  const mine = players.find((p) => p.id === me.player.id) ?? null;

  /*
   * 머리말에 뜨는 내 이름. 계정 이름이 먼저다 — 좌석 명단(mine)보다 빨리 오고,
   * 둘은 같은 값이다(앉을 때 profiles 에서 lobby_name 으로 베껴 온다).
   * 아래 머리말 주석에 왜 이렇게 됐는지 적어 두었다.
   */
  const { data: profileData } = useProfile();
  const myName = profileData?.profile?.display_name ?? mine?.lobby_name ?? null;

  /*
   * 「게임 시작」은 월드 시작이다 (2026-08-06 결정). 2D 상태머신(useStartRoom →
   * /api/room/start)이 아니라 world_started_at 만 찍는다 — 그 값이 오면 아래
   * 이동 효과가 전원을 /world 로 보낸다.
   */
  const start = useStartWorld(code, room.id);
  const busy = useRoomUi(selectIsBusy);
  const starting = useRoomUi(selectIsPending(REQUEST.start));

  /*
   * 지금 시작할 수 있나 (2026-08-07 결정 — 사람 2~8명 + 방장 뺀 전원 준비).
   *
   * ★ 서버와 **같은 함수**를 본다 (lib/game/rules.ts). 여기서 따로 세면 눌리는데
   *   409 로 거절당하거나, 눌리지 않는데 서버는 받아주는 상태가 생긴다.
   * ★ players 는 public_players 라 **사람만 온다** (대기방에는 아직 AI 가 없다).
   *   AI 는 시작 순간에 붙는다 — 그래서 여기 세는 수가 곧 사람 수다.
   * ★ 방장은 준비에서 빠진다. 그래서 room.host_id 를 같이 넘긴다 — 내가 방장인지
   *   (me.is_host)가 아니라 **누가 방장인지**가 필요하다. 남의 화면에서도 같은
   *   판정이 나와야 "왜 저 사람은 준비 안 했는데 시작이 되지"가 안 생긴다.
   */
  const blocked = startBlock(players, room.host_id);

  /*
   * 나가기. **링크가 아니라 버튼이어야 한다** — 자리를 실제로 빼는 쓰기이기 때문이다.
   * 예전에는 /main 으로 가는 <Link> 라서 화면만 떠나고 자리는 그대로 남았다.
   * 아무도 안 남은 방이 목록에 계속 뜨고, 방 코드도 24시간 동안 묶여 있었다.
   *
   * ★ 대기실을 떠나는 길(머리말의 ← 로비, 오른쪽 아래 방 나가기, **브라우저 뒤로가기**)이
   *   **전부 자리를 뺀다.** 하나만 자리를 빼면 어느 쪽으로 나갔느냐로 빈 방이 남는지가
   *   갈리는데, 화면에는 그 차이가 보이지 않는다.
   *
   * 화면 이동은 서버가 답한 **뒤에** 한다. 먼저 넘어가면 요청이 언마운트와 함께
   * 끊길 수 있고, 그러면 자리가 남는다 — 지금 고치려던 그 상태로 돌아간다.
   * 마지막 한 명이었으면 그 방은 이 요청에서 사라진다 (lib/queries/mutations).
   *
   * 뒤로가기만 순서가 반대다 — 브라우저가 이미 넘겨버린 뒤라 되돌릴 수 없고,
   * 요청이 뒤따라간다. 그쪽 사정은 useLeaveRoomOnExit 주석에 있다.
   *
   * ★ markLeft 를 빼먹으면 나가기가 두 번 나간다 — 버튼이 성공한 뒤 /main 으로
   *   넘어가는 그 이동이 곧 이 화면의 언마운트라, 떠남 감지가 한 번 더 걸린다.
   */
  const router = useRouter();
  const { markLeft } = useLeaveRoomOnExit(room.id);
  const leave = useLeaveRoom(room.id, () => {
    markLeft();
    router.push("/main");
  });
  const leaving = useRoomUi(selectIsPending(REQUEST.leave));

  /**
   * 대기실을 떠나는 두 길(머리말 ← 로비, 오른쪽 아래 방 나가기)이 **여기 하나를**
   * 지난다. 한쪽만 onLeaving 을 부르면 그쪽으로 나갈 때만 강퇴 화면이 뜬다.
   */
  const leaveNow = () => {
    onLeaving?.();
    leave.run();
  };

  /** 강퇴 (2026-08-07). 방장 화면에서만 쓰인다 — 좌석 카드의 × 가 부른다 */
  const kick = useKickPlayer(code, room.id);

  /*
   * 월드 시작 신호 (2026-08-06 결정). 방장이 「게임 시작」을 누르면 서버가
   * rooms.world_started_at 을 찍고(/api/room/start-world), 이미 걸려 있는 rooms
   * 구독(useRoomRealtime)이 방 쿼리를 무효화해 이 값이 도착한다.
   *
   * ★ **값 기준이지 전환 기준이 아니다.** 바뀌는 순간만 보면 시작 뒤에 들어온
   *   사람이 대기방에 갇힌다 — 시작된 방은 언제 들어와도 곧장 월드로 보낸다.
   *   (판이 도는 중이면 워커가 round_in_progress 로 거절하고, /world 입장
   *   패널에서 판이 끝난 뒤 다시 들어간다.)
   * ★ markLeft 를 먼저 찍는다. 이 이동도 언마운트라, 안 찍으면 떠남 감지
   *   (useLeaveRoomOnExit)가 자리를 빼 버린다 — 전원이 동시에 이동하는 순간
   *   마지막 나가기가 방 자체를 지울 수 있다. 월드는 같은 자리로 재입장하는
   *   것이지 떠나는 게 아니다.
   * ★ replace 다. push 면 월드에서 뒤로가기가 대기방으로 돌아왔다가 이 효과로
   *   다시 튕겨서, 뒤로가기가 영영 안 먹는다.
   */
  const started = room.world_started_at;
  useEffect(() => {
    if (!started) return;
    markLeft();
    router.replace(`/world?code=${encodeURIComponent(code)}`);
  }, [started, markLeft, router, code]);

  /*
   * ┌─ 시작된 순간부터 좌석판을 그리지 않는다 (2026-08-08) ──────────────────────┐
   * │ 신고: "시작하면 랜덤으로 다시 부여한 자리가 잠깐 떴다가 월드로 넘어간다".   │
   * │ DB 가 신호를 하나로 줄이고(bump_roster_seq 가드) 방 행을 먼저 읽게 해도     │
   * │ (useInvalidateRoom) 이 깜빡임은 남는다 — 위의 router.replace 는 월드 번들을 │
   * │ 다 불러와 마운트할 때까지 **이 화면을 계속 띄워 두기** 때문이다. 그 사이에  │
   * │ 좌석 쿼리가 새 명단(섞인 자리 · 익명N)을 물어다 주면 좌석판이 그걸 그린다.  │
   * │                                                                            │
   * │ 그래서 순서가 아니라 화면에서 끊는다: 시작 신호가 온 순간부터는 무엇이      │
   * │ 어떤 순서로 도착하든 **새 번호가 설 자리 자체가 없다.** 시작 뒤에 방 주소로 │
   * │ 들어온 사람도 같은 덮개를 보고 곧장 월드로 간다 (위 효과가 값 기준인 이유). │
   * │ 훅은 전부 이 위에서 불렀으므로 여기서 갈라져도 훅 개수는 같다.              │
   * └────────────────────────────────────────────────────────────────────────────┘
   */
  if (started) {
    return <RoomBoot label="월드로 이동하는 중…" />;
  }

  return (
    /*
      ★ h-screen(=100vh) 이 아니라 h-dvh 다 (2026-08-07). 모바일 브라우저의
        100vh 는 주소창이 **접힌** 높이라, 주소창이 펼쳐져 있으면 화면보다 크다.
        본문이 overflow-hidden 이므로 그 초과분은 스크롤이 아니라 **잘림**이 된다 —
        맨 아래에 있는 조작판(준비 · 나가기)이 그 잘리는 자리다.
    */
    <div className={`${styles.root} flex h-dvh flex-col overflow-hidden`}>
      <div aria-hidden className={styles.backdrop} />
      <div aria-hidden className={styles.noise} />
      <div aria-hidden className={styles.scanlines} />

      {/*
        ── 머리말 ───────────────────────────────────────────────────
        띠 자체는 로비(/main)와 **같은 것**이다 (components/top-bar.tsx) — 높이도
        색도 거기서 온다. 예전에는 여기서 따로 그렸고 대기실 팔레트(형광 초록 ·
        어두운 보조 글자)를 물려받아서, 방에 들어가는 순간 같은 자리의 띠가
        다른 색으로 바뀌었다.
        **안에 드는 것은 방의 것이다** — 나가기 · 방 이름 · 코드 · 인원 · 나.

        ★ 덧칠도 하지 않는다 (2026-08-07 사용자 지시). 한 번 금속 바닥과 형광
          레일을 얹었다가 뺐다 — 목록의 띠와 달라지는 순간, 방에 들어갈 때
          머리말만 갈아끼워진 것처럼 보인다.
      */}
      <TopBar>
        <div className="flex min-w-0 items-center gap-4">
          {/*
            ★ 이 화살표도 **나가기와 같은 동작이다.** 링크로 두면 "로비로 돌아간다"는
              같은 뜻의 조작이 자리를 빼는 것과 안 빼는 것으로 갈린다 — 어느 쪽을
              눌렀는지에 따라 빈 방이 남는지가 달라지는데, 화면에는 그 차이가 안 보인다.
              대기실을 떠나는 길은 이 화살표와 오른쪽 아래 버튼 둘뿐이고, 둘 다 여기를 지난다.
          */}
          <button
            type="button"
            className="flex shrink-0 cursor-pointer items-center gap-2 font-[inherit] disabled:cursor-not-allowed disabled:opacity-40"
            style={{ color: "var(--muted)" }}
            disabled={busy}
            onClick={leaveNow}
          >
            <ArrowLeftIcon />
            <span className="text-[0.58rem] uppercase tracking-[0.18em]">로비</span>
          </button>
          <span className="h-4 w-px shrink-0" style={{ background: "var(--border2)" }} />
          {/*
            ★ 방을 가리키는 이름은 **여기 한 곳에서만** 쓴다. 예전에는 이 줄과
              아래 큰 판이 같은 말을 두 번 했다 — 화면에서 같은 글자가 두 번 나오면
              둘 중 어느 쪽이 진짜 조작 자리인지 흐려진다.
            ★ 코드는 글자로 띄우지 않는다. 이미 들어온 사람에게 코드는 읽을 것이
              아니라 넘길 것이라, 오른쪽 복사 버튼 하나로 충분하다.
              제목이 없는 방은 코드가 그 자리에 선다 — 가리킬 이름이 그것뿐이다.
          */}
          <h1
            className={
              room.name
                ? "min-w-0 truncate text-[0.95rem] font-semibold leading-tight"
                : `${styles.mono} min-w-0 truncate text-[0.9rem] font-bold tracking-[0.14em]`
            }
          >
            {room.name ?? room.code}
          </h1>
        </div>

        <div className="flex shrink-0 items-center gap-4 sm:gap-6">
          <CopyCodeButton code={room.code} />
          <span className="hidden items-center gap-2 sm:flex">
            <span className={styles.dot} />
            <span
              className={`${styles.mono} text-[0.55rem] uppercase tracking-[0.2em]`}
              style={{ color: "var(--accent)" }}
            >
              {seated} / {room.capacity} 접속중
            </span>
          </span>
          <span className="h-4 w-px" style={{ background: "var(--border2)" }} />
          {/*
            ┌─ 왜 '익명N' 이 잠깐 떴다가 바뀌었나 ──────────────────────────────┐
            │ 이 자리는 lobby_name(내 좌석 행)을 읽고 있었다. 그런데 좌석 명단은  │
            │ 내 정보(me)보다 **늦게 온다** — 그 사이 mine 이 null 이라 뒤의      │
            │ me.player.nickname 으로 떨어졌고, 그게 자리 이름인 '익명N' 이다.    │
            │ 이름이 한 번 틀리게 떴다가 갈아치워지는 것으로 보였다.              │
            │                                                                  │
            │ 이제 로비 머리말과 **같은 것을 읽는다** — 계정 이름(useProfile).    │
            │ /main 에서 들어오면 이미 캐시에 있어서 첫 그림부터 맞고, 방 주소로  │
            │ 바로 들어와도 아직 모르는 동안은 **빈 자리**다. 틀린 이름을 잠깐    │
            │ 보여주느니 늦게 뜨는 편이 낫다.                                    │
            └──────────────────────────────────────────────────────────────────┘
            ★ 이건 계정 이름이라 대기실에서만 쓴다. 게임이 시작되면 이 화면 자체가
              사라지고, 자리에 붙는 이름은 '익명N' 이 된다 (I1).
          */}
          {myName ? <AccountName name={myName} /> : <span className="h-[26px]" />}
        </div>
      </TopBar>

      {/*
        ── 본문 ─────────────────────────────────────────────────────
        판 세 개다 (2026-08-07, 레퍼런스 「RE:HUMAN」): 왼쪽 큰 좌석판, 오른쪽에
        대화판과 조작판. 예전에는 오른쪽이 세로선 하나로 나뉜 **면**이었는데,
        그러면 화면이 "왼쪽 여백 + 오른쪽 여백"이라 게임 화면으로 안 읽힌다.
        레퍼런스처럼 각각이 테두리를 두른 **부품**이어야 한다.
      */}
      <div className={styles.body}>
        {/*
          ★ **좌석판에는 이름을 쓰지 않는다** (2026-08-07 사용자 지시: "참가자
            글자는 없애줘"). 칸에 사람이 앉아 있는 그림이 이미 "참가자"라고
            말하고 있어서, 그 위에 같은 말을 글자로 또 적으면 읽을 것만 는다.
            화면 낭독기에는 남는다 — 아래 aria-label 이 그 몫이다.
            인원 수는 머리말과 오른쪽 눈금이 들고 있다.
          ★ 방 이름 · 코드 · 인원을 다시 그리는 판도 두지 않는다. 머리말이 이미
            그 셋을 들고 있다 — 여기서 첫 화면은 좌석이어야 한다.
        */}
        <main aria-label="참가자 현황" className={`${styles.panel} min-w-0 flex-1`}>
          {/*
            ★ 실패 배너는 **스크롤 밖**이다 (2026-08-07). 좌석 목록 안에 두었더니
              칸이 여덟이라 아래를 보고 있을 때 뜬 배너가 화면 밖에 있었다 —
              누른 버튼은 안 먹었는데 이유는 안 보이는 상태가 된다.
            ★ role="alert" 다. 이 글은 **조작이 실패했을 때만** 나타나므로,
              나타난 사실 자체를 낭독기가 읽어줘야 한다 (aria-live 로는 이 판이
              처음 그려질 때 조용히 지나간다).
          */}
          {error && (
            <p className={styles.alert} role="alert">
              {error}
            </p>
          )}

          {/*
            ★ 스크롤은 **판이 아니라 이 안쪽 상자**가 진다. 판에 걸면 판 이름
              (.panelTitle)까지 같이 밀려 올라가 사라진다 — 대화판·조작판도 같은
              모양이라, 셋 다 "이름은 붙박이, 속만 흐른다"로 맞춰 둔다.
            ★ flex-1 + min-h-0 다 (2026-08-07 사용자 지시: "8자리도 방 꽉차게").
              여기가 남은 높이를 다 먹어야 그리드가 그걸 두 줄로 나눠 가진다.
              min-h-0 을 빼면 flex 자식의 기본 min-height:auto 때문에 본문이
              넘칠 때 줄어들지 못해 스크롤이 아니라 화면 밖으로 밀린다.
          */}
          <div className={`${styles.panelInner} ${styles.bare} ${styles.scroll} overflow-y-auto`}>
            <SeatGrid
              players={players}
              capacity={room.capacity}
              meId={me.player.id}
              hostId={room.host_id}
              onKick={me.is_host ? (id) => kick.run(id) : null}
              busy={busy}
            />
          </div>

          {/*
            ★ 이름을 고치는 판을 여기 두지 않는다. 이름은 계정에서 한 번 짓고
              못 바꾼다 — 앉는 순간 profiles 에서 lobby_name 으로 베껴져 오므로
              대기실에서 다시 물을 것이 없다. 머리말 오른쪽이 그 이름을 보여준다.

            ★ **규칙판도 여기 두지 않는다** (2026-08-07 사용자 지시). 정원·AI·연기자·
              승리 조건을 늘어놓던 판이 좌석 아래를 통째로 차지하고 있었다. 규칙은
              /intro 에서 이미 읽고 들어오고, 대기실에서 할 일은 앉은 사람을 보는
              것뿐이다. 다시 넣고 싶어지면 좌석을 밀어내지 않는 자리를 먼저 찾을 것.
          */}
        </main>

        {/*
          ── 기둥 ─────────────────────────────────────────────────────
          ★ 좁은 화면에서 **숨기지 않는다** (2026-08-07). 예전에는 lg 미만에서
            통째로 display:none 이었는데, 준비 · 게임 시작 · 대화하기 · 방 나가기가
            전부 여기 살아서 폰에서는 방에 들어와도 누를 것이 하나도 없었다.
            지금은 좌석 아래로 눕는다 — 어디로 눕는지는 styles.side 에 있다.
        */}
        <aside className={styles.side}>
          <section className={`${styles.panel} ${styles.chatPanel}`}>
            <span className={styles.panelTitle}>대화하기</span>
            <SayPanel code={code} roomId={room.id} mine={mine} />
          </section>

          <section className={`${styles.panel} ${styles.actionPanel}`}>
            <span className={styles.panelTitle}>시작</span>
            <ActionPanel
              code={code}
              roomId={room.id}
              mine={mine}
              isHost={me.is_host}
              seated={seated}
              capacity={room.capacity}
              blockedMessage={blocked ? START_BLOCK_MESSAGE[blocked] : null}
              onStart={() => start.run()}
              starting={starting}
              onLeave={leaveNow}
              leaving={leaving}
            />
          </section>
        </aside>
      </div>
    </div>
  );
}

/* ────────────────────────────── 코드 넘기기 ────────────────────────────── */

/**
 * 입장 코드를 넘기는 버튼. **코드를 글자로 띄우는 자리는 화면에 없다.**
 *
 * ★ 이미 들어온 사람에게 코드는 읽을 것이 아니라 넘길 것이라, 버튼 하나면 된다.
 *   눌러서 복사한 게 맞는지는 버튼 자신이 "복사 완료"로 답한다 — 확인하라고
 *   코드를 옆에 적어두면 그 순간 다시 읽을 글자가 는다.
 * ★ 복사에 실패해도 오류를 띄우지 않는다. 주소창의 /room/<코드> 가 같은 값이라
 *   막다른 길이 아니다.
 */
function CopyCodeButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // https 가 아닌 곳에는 clipboard API 가 없다 (위 주석)
    }
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className={`${styles.copy} ${copied ? styles.copyDone : ""}`}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? "복사 완료" : "코드 복사"}
    </button>
  );
}

/* ─────────────────────────────── 좌석 ─────────────────────────────── */

/**
 * 좌석 칸. **정원만큼** 그린다 (§17.6).
 *
 * ★ 빈 칸이 곧 "시작하면 AI가 앉을 자리"라는 건 이 화면이 막을 수 없는 구멍이다.
 *   인원을 감춰도 빈칸 수가 같은 값을 준다. 그래서 최소한 문구로 그걸 알려주지는
 *   않는다 — 빈칸에 "AI 자리" 같은 말을 붙이지 말 것.
 *
 * ★ 열은 4칸 고정이다 (styles.seatGrid). 정원 8이 4+4 두 줄로 접힌다.
 *   그리는 **개수**는 여전히 capacity 에서 온다 — 여기 숫자를 박지 않는다.
 *
 * ★ **방장 표시는 전원에게 보인다** (2026-08-07). 예전에는 내가 방장일 때 내 칸에만
 *   붙였는데, 방장이 준비에서 빠지면서(lib/game/rules.ts의 startBlock) 그 자리만
 *   준비 표시가 비게 됐다. 누구인지 안 보이면 남들 눈에는 "안 누른 사람이 있는데
 *   시작이 되는" 화면이 된다. 대기방에는 봇이 없어서 이걸 드러내도 I1과 무관하다.
 */
/**
 * 말풍선이 화면에 남아 있는 시간 (2026-08-07 사용자 지시: "누르면 3초 뒤에 사라지게").
 *
 * ★ **화면에서만 걷는다.** 서버의 lobby_line 은 그대로 남아 있고, 여기서는 그 값에
 *   딸려 오는 lobby_line_at 으로 나이를 재서 그릴지 말지만 정한다. 서버가 지우게
 *   하려면 타이머를 도는 무언가를 세워야 하는데, 말풍선 하나 걷자고 할 일이 아니다.
 * ★ 판정을 **서버 시계**로 한다. 표시용이라 클라 시계를 써도 I2 위반은 아니지만,
 *   옆의 쿨다운이 이미 서버 시계를 보고 있어서 둘을 갈라 둘 이유가 없다 — 갈리면
 *   "말풍선은 사라졌는데 아직 못 누르는" 틈이 사람마다 달라진다.
 * ★ 쿨다운(4초, LOBBY_LINE_COOLDOWN_SEC)보다 **1초 짧다.** 말이 걷히고 1초 뒤에
 *   다시 말할 수 있다는 뜻이고, 그 1초가 비는 게 의도다 — 걷히자마자 다시 눌리면
 *   같은 말이 깜빡이는 것처럼 보이고, 그 깜빡임이 세어져서 신호가 된다.
 *   **둘의 차이를 뒤집지 말 것**(TTL > 쿨다운). 그러면 아직 떠 있는 말 위에
 *   같은 말이 덮여, 눌렀는지 아닌지가 화면에서 사라진다.
 */
const LOBBY_LINE_TTL_MS = 3000;

/**
 * 말풍선이 **스스로** 걷히게 하는 시계.
 *
 * ★ 왜 필요한가: 3초가 지나는 순간 바뀌는 건 서버 값이 아니라 **시간**뿐이라 다시
 *   그릴 계기가 없다. 그냥 두면 말풍선이 다음 갱신(누가 앉거나 준비를 누를 때)까지
 *   붙어 있는다. SayPanel 의 쿨다운 표시가 같은 이유로 같은 짓을 한다.
 * ★ 띄울 게 있을 때만 돈다. 아무도 말하지 않은 방에서 250ms 마다 여덟 칸을 다시
 *   그릴 이유가 없다.
 */
function useLineTick(active: boolean) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [active]);
}

function SeatGrid({
  players,
  capacity,
  meId,
  hostId,
  onKick,
  busy,
}: {
  players: PublicPlayer[];
  capacity: number;
  meId: string;
  /** 방장의 player id (rooms.host_id). 방장 자리에만 표가 붙고, 준비 줄이 「방장」이 된다 */
  hostId: string | null;
  /**
   * 방장일 때만 함수가 온다. null 이면 × 를 아예 그리지 않는다 (2026-08-07).
   * ★ 남의 화면에 회색으로라도 띄우지 않는다 — 못 누르는 버튼은 "왜 나는 안 되지"만
   *   만들고, 서버도 방장만 받는다(supabase/functions/room.sql 의 kick_player).
   */
  onKick: ((playerId: string) => void) | null;
  /** 다른 쓰기가 도는 중이면 같이 잠근다 (요청 게이트) */
  busy: boolean;
}) {
  const bySeat = new Map(players.map((p) => [p.seat, p]));

  /*
   * 확인을 기다리는 자리 (2026-08-07). **한 번에 하나뿐이다** — 여러 칸을 눌러 두면
   * 어느 것이 눌린 상태인지 헷갈리고, 그 상태로 잘못 누르면 되돌릴 수가 없다.
   *
   * ★ 몇 초 뒤 스스로 풀린다. 눌러 두고 잊으면 다음 클릭이 곧장 내보내기가 된다.
   * ★ 창(window.confirm)을 쓰지 않는다. 브라우저 것이라 이 화면과 따로 놀고,
   *   테스트에서도 가로채야 하는 물건이 하나 는다.
   */
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (armed == null) return;
    const t = setTimeout(() => setArmed(null), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  /*
   * 말풍선 걷기. 아직 안 걷힌 말이 하나라도 있으면 시계를 돌린다 —
   * 그 시계가 이 컴포넌트를 다시 그려서 아래 fresh 판정이 갱신된다.
   */
  const { serverNow } = useServerClock();
  useLineTick(players.some((p) => p.lobby_line != null));

  /**
   * 지금 이 말을 아직 띄울 때인가.
   * ★ lobby_line_at 이 없으면 **띄운다.** 나이를 못 재는 값을 숨기면 서버에는 있는
   *   말이 화면에서만 사라져, 원인을 화면 쪽에서 찾을 수가 없다.
   */
  const fresh = (p: PublicPlayer) => {
    if (!p.lobby_line) return false;
    if (!p.lobby_line_at) return true;
    const at = new Date(p.lobby_line_at).getTime();
    if (!Number.isFinite(at)) return true;
    return serverNow() - at < LOBBY_LINE_TTL_MS;
  };

  return (
    <ul className={styles.seatGrid}>
      {Array.from({ length: capacity }, (_, i) => i + 1).map((seat) => {
        const p = bySeat.get(seat) ?? null;
        const isMe = p != null && p.id === meId;
        const isHostSeat = p != null && p.id === hostId;
        /*
         * 시작을 막지 않는 자리인가. 방장은 준비를 누르지 않으므로(startBlock) 여기서
         * 준비한 사람과 **같이 친다** — 안 그러면 시작은 되는데 화면에는 안 누른
         * 자리가 하나 남아, 조건과 표시가 어긋난다.
         */
        const settled = p != null && (isHostSeat || p.is_ready);

        return (
          <li key={seat}>
            {/*
              ┌─ 좌석 카드 구조 (2026-08-07 개편, 「신분증」 안) ────────────────┐
              │ 카드 안쪽을 **그림 한 장이 통째로 덮는다.** 예전에는 가운데      │
              │ 동그란 아바타 하나였는데, 원 안에 든 선 그림은 카드가 커질수록   │
              │ 한가운데 뜬 작은 점이 됐다.                                      │
              │                                                                  │
              │   .art    신분증 그림. 카드 안쪽 전체 (아래 IdCard)              │
              │   .plate  이름. 그림 **위에** 얹힌 어두운 띠                     │
              │   .bubble 지금 한 말. 이름 바로 위, 꼬리가 이름을 가리킨다       │
              │   .holo   홀로그램 필름. 준비된 자리에서만 흐른다                │
              │                                                                  │
              │ ★ 순서가 곧 위아래다. 말풍선이 이름판보다 **뒤에** 와야 한다 —   │
              │   둘 다 같은 층이라, 앞에 두면 이름판의 어두운 띠가 말을 덮는다. │
              │ ★ 홀로그램이 맨 마지막이다. 필름은 카드 전체에 덮인 한 겹이라    │
              │   이름 위도 지나가야 한다.                                       │
              └──────────────────────────────────────────────────────────────────┘
            */}
            <div
              className={[
                styles.slot,
                isMe ? styles.slotMe : "",
                settled ? styles.slotSettled : "",
                p == null ? styles.slotEmpty : "",
              ].join(" ")}
            >
              <IdCard empty={p == null} settled={settled} me={isMe} />

              {/*
                내보내기 (2026-08-07). **남의 자리에만** 붙는다 — 방장 자기 자리에는
                안 붙는다. 서버도 자기 자신은 거절한다(kick_player). 방장이 나가려면
                「방 나가기」다, 그쪽은 방장 자리를 다음 사람에게 넘긴다.

                ★ 두 번 눌러야 나간다. 한 번에 나가면 **되돌릴 수가 없다** —
                  내보내진 사람은 그 방에 다시 못 들어온다 (2026-08-08, room_bans).
                  방장이 마음을 바꿔도 불러들일 방법이 없으므로 확인을 한 겹 둔다.
              */}
              {onKick != null &&
                p != null &&
                !isHostSeat &&
                (armed === p.id ? (
                  <button
                    type="button"
                    className={styles.kickConfirm}
                    disabled={busy}
                    onClick={() => {
                      setArmed(null);
                      onKick(p.id);
                    }}
                  >
                    내보내기
                  </button>
                ) : (
                  <button
                    type="button"
                    className={styles.kick}
                    disabled={busy}
                    aria-label={`${p.lobby_name ?? p.nickname} 내보내기`}
                    onClick={() => setArmed(p.id)}
                  >
                    <XIcon />
                  </button>
                ))}

              {/*
                ★ 방장은 왕관 하나로 말한다 (2026-08-07 사용자 지시).
                  「host」 네모 태그는 카드 귀퉁이에서 이름만큼 눈에 띄었다.
                  title 을 붙여 두면 마우스를 올렸을 때 글자로도 확인된다.
                ★ 이제 그림 위에 뜨므로 .slot 바로 밑이다. 예전 자리(.slotBody)는
                  사라졌다.
              */}
              {isHostSeat && (
                <span className={styles.hostMark} title="방장">
                  <CrownIcon />
                </span>
              )}

              {/*
                ★ 이름판에는 **닉네임만** 쓴다 (2026-08-07 사용자 지시).
                  자리 번호·상태를 같이 적던 작은 둘째 줄은 지웠다 — 그 정보는
                  이미 다른 데서 말한다(방장은 왕관, 준비 여부는 홀로그램과 도장).
              */}
              <div className={styles.plate}>
                <span
                  className={styles.plateName}
                  style={{
                    color: p == null ? "var(--faint)" : isMe ? "var(--accent)" : "var(--text)",
                  }}
                >
                  {/*
                    본인이 지은 이름이 있으면 그걸로 부른다 (SPEC §15-2-결정).
                    ★ 대기방에서만이다. 게임 화면(room-view)은 이 값을 쓰지 않는다 —
                      뷰가 phase='lobby' 밖에서 null 을 주므로 자동으로 '익명N' 이 된다.
                  */}
                  {p ? (p.lobby_name ?? p.nickname) : "빈자리"}
                </span>
              </div>

              {/*
                지금 한 줄. 기록이 아니라 쌓이지 않는다 (§15-3-결정)

                ★ 자리를 미리 잡아 두는 빈 칸(.bubbleGhost)이 없어졌다. 말풍선이
                  absolute 라 카드 높이를 안 건드리기 때문이다 — 예전에는 흐름 안에
                  있어서, 한 사람만 말하면 그 칸만 키가 커져 그리드가 들썩였다.
              */}
              {p != null && fresh(p) && (
                <span className={styles.bubble} title={p.lobby_line ?? undefined}>
                  {p.lobby_line}
                </span>
              )}

              {settled && <span aria-hidden className={styles.holo} />}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 좌석 카드 그림 — **발급된 신분증 한 장.** 카드 안쪽을 통째로 덮는다.
 *
 * ┌─ 왜 이 그림인가 ───────────────────────────────────────────────────────┐
 * │ 왼쪽에 증명사진, 오른쪽에 가려진 항목들, 분류란은 끝까지 `?`.          │
 * │ 「누구인지 적혀 있는데 정작 무엇인지는 안 적혀 있다」 — 대기방이 실제로 │
 * │ 그 상태다. 사람만 앉아 있고 아직 아무 역할도 배정되지 않았다.          │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ I1 ───────────────────────────────────────────────────────────────────┐
 * │ **여덟 칸이 전부 같은 그림이다.** 자리마다 다른 인물·번호·색을 넣지     │
 * │ 않는다 — 대기방에는 아직 AI 가 없고(시작 버튼이 붙인다), 칸끼리 다른    │
 * │ 구석이 생기는 순간 그게 지목의 근거가 된다.                            │
 * │                                                                        │
 * │ 여기서 갈리는 것은 **이미 공개된 값 둘뿐**이다:                        │
 * │   empty    비었나 (빈칸 수는 어차피 세어진다)                          │
 * │   settled  준비했나 (public_players.is_ready 로 이미 내려온다)         │
 * │ 새 인자를 더할 때마다 "이걸로 봇을 골라낼 수 있나"를 먼저 묻는다.       │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 얼굴 그림에 표정을 더 넣지 않는다. 눈 둘과 입 하나가 전부인 건 작아서가
 *   아니라, 표정이 늘면 그게 "이 자리는 이런 성격"으로 읽히기 시작해서다.
 * ★ preserveAspectRatio="slice" 다. 카드 비율은 창 너비에 따라 변하는데
 *   (seatGrid 가 2열↔4열로 접힌다), meet 으로 두면 남는 쪽에 빈 띠가 생긴다.
 */
/**
 * 좌석 카드 그림 — **사람 하나.** 카드 안쪽을 통째로 덮는다.
 *
 * ┌─ 준비를 누르면 카드가 뒤집힌다 (2026-08-07 사용자 지시) ───────────────┐
 * │ 앞면은 도장 없는 카드, 뒷면은 도장 찍힌 카드다. 같은 그림에 도장만      │
 * │ 켰다 끄면 "언제 찍혔지"를 놓치는데, 뒤집으면 **누른 그 순간이 몸으로**  │
 * │ 보인다. 준비를 풀면 반대로 돈다.                                       │
 * │                                                                        │
 * │ ★ 두 면을 **미리 다 그려 둔다.** 뒤집는 중간에 그림을 갈아끼우면 90도    │
 * │   부근에서 한 프레임이 비어 카드가 깜빡인다.                            │
 * │ ★ 뒤집히는 건 **그림뿐**이다 — 이름판·말풍선은 제자리에 있다. 이름까지  │
 * │   같이 돌면 누구 자리인지가 회전하는 동안 사라진다.                     │
 * │ ★ 남의 화면에서도 돈다. is_ready 는 이미 공개값이라(public_players)     │
 * │   숨길 것이 없고, 오히려 "저 사람이 방금 준비했다"가 보여야 한다.       │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 비율 (여기서 여러 번 틀렸다) ─────────────────────────────────────────┐
 * │ 머리 지름 74 : 어깨 폭 86 = 1 : 1.16. **비를 지킬 것** — 크기는 바꿔도  │
 * │ 되지만 이 비에서 벗어나면 사람으로 안 보인다.                          │
 * │   어깨를 넓히면(1 : 2.3) 둥근 **덩어리**가 된다.                       │
 * │   어깨를 좁히면 바닥까지 닿는 직선이 길어져 **긴 몸통**이 된다.        │
 * │ 가슴은 viewBox 바닥(230)까지 내려간다 — 중간에서 끊으면 그 밑동이       │
 * │ 카드 바탕과 따로 놀아 "검정이 몸이랑 안 맞는" 자리가 된다.             │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ★ **눈도 입도 없다** (2026-08-07 사용자 지시). 눈매나 입꼬리가 생기는 순간
 *   그게 "이 자리는 이런 사람"으로 읽히기 시작하는데, 여덟 칸이 전부 같은
 *   그림이어야 하는 화면에서는 그게 소음이다.
 *
 * ┌─ I1 ───────────────────────────────────────────────────────────────────┐
 * │ **여덟 칸이 전부 같은 그림이다.** 자리마다 다른 인물·번호·색을 넣지     │
 * │ 않는다 — 대기방에는 아직 AI 가 없고(시작 버튼이 붙인다), 칸끼리 다른    │
 * │ 구석이 생기는 순간 그게 지목의 근거가 된다. 여기서 갈리는 것은 이미     │
 * │ 공개된 값 둘뿐이다: empty(비었나) · settled(준비했나).                  │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ★ slice 다 — 그림이 칸을 꽉 채운다. 그래서 **가장자리에 아무것도 두지
 *   않는다**: 머리 위 53, 도장 좌우 42 가 잘려도 되는 여백이다.
 */
const HEAD = { cx: 100, cy: 90, r: 37 };
const BODY = "M57 230v-63a43 43 0 0 1 86 0v63z";
const STAMP = { x: 42, y: 104, w: 116, h: 40 };

function IdCard({ empty, settled, me }: { empty: boolean; settled: boolean; me: boolean }) {
  if (empty) {
    /*
     * 빈자리 — 자리가 **비어 있다**는 것만 말한다. 여기에 「AI 자리」를 암시하는
     * 무엇도 두지 않는다 (I1). 빈칸 수만으로도 새는 판이다.
     * 뒤집지 않는다 — 뒤집을 뒷면이 없다.
     */
    return (
      <div className={styles.art} aria-hidden>
        <svg viewBox="0 0 200 230" preserveAspectRatio="xMidYMid slice">
          <g fill="none" stroke="#d8d8d8" strokeOpacity=".1" strokeWidth="2.4" strokeDasharray="7 8">
            <circle cx={HEAD.cx} cy={HEAD.cy} r={HEAD.r} />
            <path d={BODY} />
          </g>
        </svg>
      </div>
    );
  }

  return (
    <div className={styles.art} aria-hidden>
      <div className={`${styles.flip} ${settled ? styles.flipOn : ""}`}>
        <div className={`${styles.face} ${styles.faceIdle}`}>
          <CardFace stamped={false} me={me} />
        </div>
        <div className={`${styles.face} ${styles.faceBack}`}>
          <CardFace stamped me={me} />
        </div>
      </div>
    </div>
  );
}

/** 카드 한 면. 도장 유무만 다르다 — 두 면을 미리 그려 두려고 갈라 놓았다 */
function CardFace({ stamped, me }: { stamped: boolean; me: boolean }) {
  return (
    <svg viewBox="0 0 200 230" preserveAspectRatio="xMidYMid slice">
      {/*
        머리와 가슴뿐이다 — 안테나도 손도 없다. 어깨 꼭대기(124)가 머리 바닥
        (127)보다 위라 3px 겹친다. 목이 뜨면 머리만 따로 떠 있는 것처럼 보인다.
      */}
      <g fill={me ? "#4a4a4a" : "#3d3d3d"}>
        <circle cx={HEAD.cx} cy={HEAD.cy} r={HEAD.r} />
        <path d={BODY} />
      </g>

      {/*
        ★ 도장은 viewBox 세로 45~63% 에 산다. 더 내리면 **말풍선과 겹친다** —
          말풍선은 이름 바로 위(카드 아래 72~86%)에 뜨고, 둘 다 카드에서 제일
          먼저 읽히는 것들이라 겹치면 둘 다 안 읽힌다.
      */}
      <g transform="rotate(-10 100 124)">
        {stamped ? (
          <>
            <rect
              {...{ x: STAMP.x, y: STAMP.y, width: STAMP.w, height: STAMP.h }}
              rx="5"
              fill="#35d07f"
              fillOpacity=".1"
              stroke="#35d07f"
              strokeOpacity=".9"
              strokeWidth="3"
            />
            <text x="100" y="132" textAnchor="middle" fontSize="22" fontWeight="700" fill="#35d07f">
              준비 완료
            </text>
          </>
        ) : (
          /* 빈 자국. 회색 글자로 흐려두지 않는다 — 흐린 글자는 "찍혔는데 안 보이는 것"으로 읽힌다 */
          <rect
            {...{ x: STAMP.x, y: STAMP.y, width: STAMP.w, height: STAMP.h }}
            rx="5"
            fill="none"
            stroke="#d8d8d8"
            strokeOpacity=".14"
            strokeWidth="2.2"
            strokeDasharray="7 6"
          />
        )}
      </g>
    </svg>
  );
}

/* ────────────────────────────── 말하기 ────────────────────────────── */

/**
 * 대기실에서 대화하기 — 정해진 문구만 누른다 (SPEC §15-3-결정).
 *
 * 시안에는 자유 입력 채팅이 있었지만 이 게임에서는 그걸 열 수 없다. 대기실에서
 * 미리 짜면 게임이 죽는다. 담합의 두 축(자리·역할)은 이미 구조가 끊어놨고
 * — 봇은 시작할 때 앉고 자리·역할은 시작 순간 다시 섞인다 — 남는 건
 * "우리 다 짧게만 답하자" 같은 메타 합의뿐이라 문구 목록이 그걸 막는다.
 *
 * ★ 문구를 화면에 적어두지 않는다. 목록의 원본은 서버 하나뿐이다.
 *   두 군데로 갈리면 화면에는 있는데 서버가 모르는 버튼이 생기고, 눌러도 400만 뜬다.
 */
function SayPanel({
  code,
  roomId,
  mine,
}: {
  code: string;
  roomId: string;
  mine: PublicPlayer | null;
}) {
  const { data: cfg } = useLobbyLines(true);
  const say = useSayLobbyLine(code, roomId);
  const busy = useRoomUi(selectIsBusy);
  const { serverNow } = useServerClock();

  const [, tick] = useState(0);

  const cooldownMs = (cfg?.cooldown_sec ?? 3) * 1000;
  const lastAt = mine?.lobby_line_at ? new Date(mine.lobby_line_at).getTime() : 0;
  const waitMs = Number.isFinite(lastAt) ? Math.max(0, lastAt + cooldownMs - serverNow()) : 0;
  const cooling = waitMs > 0;

  /**
   * 쿨다운이 끝나면 버튼이 스스로 풀려야 한다. 그런데 그때 바뀌는 건 서버 값이
   * 아니라 **시간**뿐이라 다시 그릴 계기가 없다 — 여기서만 초를 센다.
   * 표시용이다. 진짜 판정은 서버가 한다 (I2).
   *
   * ★ **식는 동안만 돈다.** 예전에는 빈 의존성 배열이라 대기실에 가만히 앉아
   *   있어도 초당 두 번씩 이 판을 다시 그렸다 — 쿨다운은 3초인데 타이머는
   *   방을 나갈 때까지 돌았다. 말을 하면 cooling 이 참이 되어 다시 걸리고,
   *   waitMs 가 0이 되는 순간 이 효과가 스스로 정리된다.
   */
  useEffect(() => {
    if (!cooling) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [cooling]);

  return (
    <div className={`${styles.panelInner} ${styles.scroll} overflow-y-auto`}>
      {/*
        ★ 안내 문구를 두지 않는다. 왜 정해진 말만 있는지는 버튼 목록이 이미
          말하고 있고(고를 수 있는 게 그것뿐이다), 고른 말이 내 자리 위에 뜬다는
          것도 한 번 누르면 바로 보인다. 규칙을 코드에 남기는 건 이 파일 머리말이
          맡는다 — 화면에까지 적으면 읽을 것만 는다.
      */}
      {/*
        리스트 태그를 쓰지 않는다 — 좌석 수를 세는 검사가 이것까지 센다.

        ★ 열 수가 세 번 갈리는 건 **기둥이 눕기 때문이다** (styles.side):
            폰      기둥이 가로로 눕고 대화판은 그 절반 → 한 줄에 하나
            태블릿  같은 가로 배치인데 폭이 넉넉하다   → 넷씩 두 줄
            데스크톱 기둥이 다시 세로로 서서 310px      → 둘씩 네 줄
          폰에서 둘씩 두면 칸이 71px 이라 「조금만 기다려」가 두 줄로 접힌다.
      */}
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-4 lg:grid-cols-2">
        {(cfg?.lines ?? []).map((l) => (
          <button
            key={l.id}
            type="button"
            /*
             * ★ 같은 말을 다시 눌러도 된다 (2026-08-07 사용자 지시). 예전에는
             *   서버가 연속 금지로 막아서 여기서도 같이 잠갔는데, 말풍선이 3초 뒤
             *   걷히면서 **사라진 말을 다시 하려는데 그 버튼만 잠긴** 꼴이 됐다.
             *   서버 쪽 규칙도 같이 걷었다 (supabase/functions/lobby.sql).
             * ★ 남은 잠금은 쿨다운뿐이다. 여기서 그것까지 풀지 말 것 — 서버가
             *   여전히 거절하므로 눌리기만 하고 오류 배너만 뜬다.
             */
            disabled={busy || cooling}
            onClick={() => say.run(l.id)}
            className={styles.line}
          >
            {l.text}
          </button>
        ))}
      </div>

      {cooling && (
        <p className="text-[0.58rem]" style={{ color: "var(--faint)" }} aria-live="polite">
          {Math.ceil(waitMs / 1000)}초 뒤에 다시 말할 수 있다
        </p>
      )}
    </div>
  );
}

/* ────────────────────────────── 조작판 ────────────────────────────── */

/**
 * 오른쪽 아래 판 — 인원 눈금 · 준비/시작 · 나가기. 레퍼런스의 「편성 / 해제」 자리다.
 *
 * ★ **준비와 시작이 한 판에 산다** (2026-08-07). 예전에는 준비가 대화판 바닥에
 *   붙어 있었는데, 그러면 "지금 뭘 눌러야 하나"가 두 판으로 나뉜다. 방장이든
 *   아니든 이 판 하나만 보면 되는 게 맞다 — 자리에 따라 버튼만 갈린다.
 */
function ActionPanel({
  code,
  roomId,
  mine,
  isHost,
  seated,
  capacity,
  blockedMessage,
  onStart,
  starting,
  onLeave,
  leaving,
}: {
  code: string;
  roomId: string;
  mine: PublicPlayer | null;
  /** 방장에게는 준비 버튼이 없다 — 「게임 시작」이 그 자리다 (2026-08-07) */
  isHost: boolean;
  seated: number;
  capacity: number;
  /** 지금 시작할 수 없는 이유. 없으면 null — 문구의 원본은 START_BLOCK_MESSAGE 하나뿐이다 */
  blockedMessage: string | null;
  onStart: () => void;
  starting: boolean;
  onLeave: () => void;
  leaving: boolean;
}) {
  const ready = useSetLobbyReady(code, roomId);
  const busy = useRoomUi(selectIsBusy);

  return (
    <div className={styles.panelInner}>
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[0.6rem]" style={{ color: "var(--muted)" }}>
            {seated}명
          </span>
          <span className={`${styles.mono} text-[0.6rem]`} style={{ color: "var(--muted)" }}>
            정원 {capacity}
          </span>
        </div>
        {/*
          눈금 한 칸 = 자리 하나 (2026-08-07 사용자 지시). 칸 수는 정원에서 온다 —
          여기 8을 박으면 정원 3~5 인 옛 방에서 눈금과 자리 수가 어긋난다.
          수는 바로 위 「{seated}명 / 정원 {capacity}」 이 글자로 읽어주므로 aria 에서는 뺀다.
        */}
        <div className={styles.pips} aria-hidden>
          {Array.from({ length: capacity }, (_, i) => (
            <span key={i} className={`${styles.pip} ${i < seated ? styles.pipOn : ""}`} />
          ))}
        </div>
      </div>

      {/*
        ★ 정원을 다 채우지 않아도 시작할 수 있다. 남은 자리가 어떻게 되는지는
          대기실에서 말하지 않는다 (I1) — 이제 남은 자리와 AI 수는 무관하다.

        ★ 못 누를 때는 **이유를 적는다.** 회색 버튼만 두면 방장은 자기 화면이
          고장 난 줄 안다. 문구는 서버 거절 문구와 같은 곳에서 온다
          (START_BLOCK_MESSAGE) — 두 군데로 갈리면 눌러 보고 나서야 다른 말을 듣게 된다.
      */}
      {isHost ? (
        <div>
          <button
            type="button"
            className={styles.btnAccent}
            disabled={busy || blockedMessage !== null}
            onClick={onStart}
          >
            {starting ? "시작하는 중…" : "게임 시작"} <PlayIcon />
          </button>
          {blockedMessage && (
            <p
              className="mt-2 text-center text-[0.6rem]"
              style={{ color: "var(--muted)" }}
              aria-live="polite"
            >
              {blockedMessage}
            </p>
          )}
        </div>
      ) : (
        <div>
          {/*
            준비 완료는 발화가 아니라 상태다. 말풍선으로 흐르지 않고 좌석 카드에 붙는다 —
            켜고 끄는 순서가 그대로 신호가 되기 때문이다.
            시작을 막는다. 한 명이 자리를 비우면 그 방은 시작되지 않는다.

            ★ **방장에게는 이 버튼이 없다** (2026-08-07 결정). 위의 「게임 시작」이
              그 자리라, 준비를 누르고 시작을 또 누르는 건 같은 뜻의 조작을 두 번
              하는 것이다. 안 눌렀을 때는 자기 버튼이 자기 때문에 잠겨서 고장으로 보였다.
              시작 조건에서도 같이 빠진다 (lib/game/rules.ts 의 startBlock) — 한쪽만
              빼면 버튼은 없는데 조건은 남아 방이 영영 안 열린다.
          */}
          <button
            type="button"
            disabled={busy}
            onClick={() => ready.run(!mine?.is_ready)}
            className={`${styles.ready} ${mine?.is_ready ? styles.readyOn : ""}`}
          >
            {mine?.is_ready && <CheckIcon />}
            <span>{mine?.is_ready ? "준비 완료" : "준비"}</span>
          </button>
          <p
            className="mt-2 flex items-center justify-center gap-2 text-center text-[0.6rem]"
            style={{ color: "var(--muted)" }}
            aria-live="polite"
          >
            <span className={`${styles.dot} ${styles.blink}`} />
            {/* 방장이 왜 안 누르는지가 여기서도 보여야 한다 — 대개 내가 안 눌렀다 */}
            {blockedMessage ?? "방장이 시작하기를 기다리는 중…"}
          </p>
        </div>
      )}

      <button type="button" className={styles.btnGhost} disabled={busy} onClick={onLeave}>
        <ExitIcon /> {leaving ? "나가는 중…" : "방 나가기"}
      </button>
    </div>
  );
}

/* ─────────────────────────────── 아이콘 ─────────────────────────────── */
/* font-awesome CDN 대신 인라인 SVG. 배포본에서 외부 요청이 나가지 않는다 */

/** 방장 표시. 좌석 카드 오른쪽 위에 홀로 앉는다 (「host」 태그를 대신한다) */
function CrownIcon() {
  return (
    <svg width="15" height="12" viewBox="0 0 15 12" fill="none" aria-hidden>
      <path
        d="M1.4 3.1l2.1 3.2L7.5 1.4l4 4.9 2.1-3.2 -1 7.1H2.4z"
        fill="currentColor"
        fillOpacity="0.18"
        stroke="currentColor"
        strokeWidth="1.15"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 내보내기. 좌석 카드 왼쪽 위에 흐리게 앉아 있다가 손을 올리면 붉어진다 */
function XIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
      <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ArrowLeftIcon() {
  return (
    <svg width="11" height="9" viewBox="0 0 11 9" fill="none" aria-hidden>
      <path
        d="M11 4.5H1.5M4.5 1L1.3 4.5L4.5 8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}



function CheckIcon() {
  return (
    <svg width="11" height="9" viewBox="0 0 11 9" fill="none" aria-hidden>
      <path d="M1 4.6L4 7.6L10 1.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
      <rect x="0.6" y="0.6" width="7.4" height="7.4" stroke="currentColor" strokeWidth="1.1" />
      <path d="M4 10.4V11.4H11.4V4h-1" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="9" height="10" viewBox="0 0 9 10" aria-hidden>
      <path d="M0 0l9 5-9 5z" fill="currentColor" />
    </svg>
  );
}

function ExitIcon() {
  return (
    <svg width="11" height="10" viewBox="0 0 12 10" fill="none" aria-hidden>
      <path d="M4.5 1H1v8h3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M7 2.4L9.6 5 7 7.6M9.4 5H4.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
