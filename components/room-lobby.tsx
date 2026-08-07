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

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { AccountName, TopBar } from "@/components/top-bar";
import type { MeResponse } from "@/lib/api/room";
import { START_BLOCK_MESSAGE, startBlock } from "@/lib/game/rules";
import { useProfile } from "@/lib/queries/auth";
import type { PublicPlayer, Room } from "@/lib/game/types";
import {
  REQUEST,
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
    <div className={`${styles.root} flex h-screen items-center justify-center`}>
      <div aria-hidden className={styles.backdrop} />
      <div aria-hidden className={styles.noise} />
      <div aria-hidden className={styles.scanlines} />
      <p className={styles.label} aria-live="polite">
        {label}
      </p>
    </div>
  );
}

export function RoomLobby({
  code,
  room,
  players,
  me,
  error,
}: {
  code: string;
  room: Room;
  players: PublicPlayer[];
  /** player 가 있는 경우만 이 화면을 그린다 (RoomView 가 확인한다) */
  me: MeResponse & { player: PublicPlayer };
  /** 쓰기 실패 배너. 성공하면 스스로 사라진다 */
  error: string | null;
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

  return (
    <div className={`${styles.root} flex h-screen flex-col overflow-hidden`}>
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
            onClick={() => leave.run()}
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

      <div className="flex flex-1 overflow-hidden">
        {/* ── 가운데 ───────────────────────────────────────────────── */}
        <main className={`${styles.scroll} flex flex-1 flex-col gap-6 overflow-y-auto p-5 sm:p-8`}>
          {error && <p className={styles.alert}>{error}</p>}

          {/*
            ★ 방 이름 · 코드 · 인원을 다시 그리는 판을 여기 두지 않는다.
              머리말이 이미 그 셋을 들고 있다. 두 번 그리면 방에 들어온 사람이
              **아무것도 조작하지 않는 덩어리**를 먼저 보게 된다 — 여기서
              첫 화면은 좌석이어야 한다.
          */}
          {/*
            ★ 좌석 위에 라벨을 붙이지 않는다. 좌석 칸 자체가 이미 "누가 앉아 있나"를
              말하고, 인원 수는 머리말과 오른쪽 눈금이 들고 있다. 설명하는 글자를
              얹으면 첫 화면에서 조작할 수 없는 줄이 하나 더 늘어난다.
          */}
          <section aria-label="참가자 현황">
            <SeatGrid
              players={players}
              capacity={room.capacity}
              meId={me.player.id}
              hostId={room.host_id}
            />
          </section>

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

        {/* ── 오른쪽 ───────────────────────────────────────────────── */}
        <aside
          className="hidden w-[300px] shrink-0 flex-col border-l lg:flex"
          style={{ background: "var(--surface)", borderColor: "var(--border)" }}
        >
          <SayPanel
            code={code}
            roomId={room.id}
            mine={mine}
            seated={seated}
            isHost={me.is_host}
          />

          <div className="border-t p-4" style={{ borderColor: "var(--border)" }}>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[0.6rem]" style={{ color: "var(--muted)" }}>
                {seated}명
              </span>
              <span className={`${styles.mono} text-[0.6rem]`} style={{ color: "var(--muted)" }}>
                정원 {room.capacity}
              </span>
            </div>
            {/*
              눈금 한 칸 = 자리 하나 (2026-08-07 사용자 지시). 칸 수는 정원에서 온다 —
              여기 8을 박으면 정원 3~5 인 옛 방에서 눈금과 자리 수가 어긋난다.
              수는 바로 위 「{seated}명 / 정원 {capacity}」 이 글자로 읽어주므로 aria 에서는 뺀다.
            */}
            <div className={`${styles.pips} mb-4`} aria-hidden>
              {Array.from({ length: room.capacity }, (_, i) => (
                <span
                  key={i}
                  className={`${styles.pip} ${i < seated ? styles.pipOn : ""}`}
                />
              ))}
            </div>

            {/*
              ★ 정원을 다 채우지 않아도 시작할 수 있다. 남은 자리가 어떻게 되는지는
                대기실에서 말하지 않는다 (I1) — 이제 남은 자리와 AI 수는 무관하다.

              ★ 못 누를 때는 **이유를 적는다.** 회색 버튼만 두면 방장은 자기 화면이
                고장 난 줄 안다. 문구는 서버 거절 문구와 같은 곳에서 온다
                (START_BLOCK_MESSAGE) — 두 군데로 갈리면 눌러 보고 나서야 다른 말을
                듣게 된다.
            */}
            {me.is_host ? (
              <>
                <button
                  type="button"
                  className={styles.btnAccent}
                  style={{ width: "100%", padding: "0.85rem" }}
                  disabled={busy || blocked !== null}
                  onClick={() => start.run()}
                >
                  {starting ? "시작하는 중…" : "게임 시작"} <PlayIcon />
                </button>
                {blocked && (
                  <p
                    className="mt-2 text-center text-[0.6rem]"
                    style={{ color: "var(--muted)" }}
                    aria-live="polite"
                  >
                    {START_BLOCK_MESSAGE[blocked]}
                  </p>
                )}
              </>
            ) : (
              <p
                className="flex items-center justify-center gap-2 py-3 text-center text-[0.65rem]"
                style={{ color: "var(--muted)" }}
              >
                <span className={`${styles.dot} ${styles.blink}`} />
                {/* 방장이 왜 안 누르는지가 여기서도 보여야 한다 — 대개 내가 안 눌렀다 */}
                {blocked ? START_BLOCK_MESSAGE[blocked] : "방장이 시작하기를 기다리는 중…"}
              </p>
            )}

            <button
              type="button"
              className={styles.btnGhost}
              style={{ width: "100%", marginTop: "0.5rem", padding: "0.6rem", fontSize: "0.56rem" }}
              disabled={busy}
              onClick={() => leave.run()}
            >
              <ExitIcon /> {leaving ? "나가는 중…" : "방 나가기"}
            </button>
          </div>
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
function SeatGrid({
  players,
  capacity,
  meId,
  hostId,
}: {
  players: PublicPlayer[];
  capacity: number;
  meId: string;
  /** 방장의 player id (rooms.host_id). 방장 자리에만 표가 붙고, 준비 줄이 「방장」이 된다 */
  hostId: string | null;
}) {
  const bySeat = new Map(players.map((p) => [p.seat, p]));

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
            <div
              className={[
                styles.slot,
                isMe ? styles.slotMe : "",
                p == null ? styles.slotEmpty : "",
              ].join(" ")}
            >
              {isHostSeat && (
                <span className="absolute right-2 top-2">
                  <span className={`${styles.tag} ${styles.tagGreen}`}>host</span>
                </span>
              )}

              {/* 지금 한 줄. 기록이 아니라 쌓이지 않는다 (§15-3-결정) */}
              {p?.lobby_line ? (
                <span className={styles.bubble} title={p.lobby_line}>
                  {p.lobby_line}
                </span>
              ) : (
                <span aria-hidden className={styles.bubbleGhost} />
              )}

              <span
                className={[
                  styles.person,
                  isMe ? styles.personMe : "",
                  p == null ? styles.personEmpty : "",
                  settled ? styles.pulse : "",
                ].join(" ")}
              >
                {p == null ? <UserPlusIcon /> : <UserIcon />}
              </span>

              <span className="text-center">
                <span
                  className="block truncate text-[0.72rem] font-semibold uppercase tracking-[0.06em]"
                  style={{ color: p == null ? "var(--dim)" : isMe ? "var(--accent)" : "var(--text)" }}
                >
                  {/*
                    본인이 지은 이름이 있으면 그걸로 부른다 (SPEC §15-2-결정).
                    ★ 대기방에서만이다. 게임 화면(room-view)은 이 값을 쓰지 않는다 —
                      뷰가 phase='lobby' 밖에서 null 을 주므로 자동으로 '익명N' 이 된다.
                  */}
                  {p ? (p.lobby_name ?? p.nickname) : "빈자리"}
                </span>
                <span
                  className={`${styles.mono} mt-1 block text-[0.58rem]`}
                  style={{ color: "var(--muted)" }}
                >
                  {p ? `자리 ${seat}${isMe ? " · 나" : ""}` : " "}
                </span>
              </span>

              {p ? (
                <span className="flex items-center gap-1.5">
                  <span className={styles.dot} style={settled ? undefined : { opacity: 0.35 }} />
                  <span
                    className="text-[0.55rem] tracking-[0.1em]"
                    style={{ color: settled ? "var(--accent)" : "var(--muted)" }}
                  >
                    {/* 방장 자리에는 준비가 없다. 「접속중」으로 두면 안 누른 사람처럼 보인다 */}
                    {isHostSeat ? "방장" : p.is_ready ? "준비 완료" : "접속중"}
                  </span>
                </span>
              ) : (
                <span
                  className={`${styles.blink} text-[0.6rem] tracking-[0.05em]`}
                  style={{ color: "var(--dim)" }}
                >
                  대기 중...
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
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
  seated,
  isHost,
}: {
  code: string;
  roomId: string;
  mine: PublicPlayer | null;
  seated: number;
  /** 방장에게는 준비 버튼이 없다 — 바로 밑의 「게임 시작」이 그 자리다 (2026-08-07) */
  isHost: boolean;
}) {
  const { data: cfg } = useLobbyLines(true);
  const say = useSayLobbyLine(code, roomId);
  const ready = useSetLobbyReady(code, roomId);
  const busy = useRoomUi(selectIsBusy);
  const { serverNow } = useServerClock();

  /**
   * 쿨다운이 끝나면 버튼이 스스로 풀려야 한다. 그런데 그때 바뀌는 건 서버 값이
   * 아니라 **시간**뿐이라 다시 그릴 계기가 없다 — 여기서만 초를 센다.
   * 표시용이다. 진짜 판정은 서버가 한다 (I2).
   */
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);

  const cooldownMs = (cfg?.cooldown_sec ?? 3) * 1000;
  const lastAt = mine?.lobby_line_at ? new Date(mine.lobby_line_at).getTime() : 0;
  const waitMs = Number.isFinite(lastAt) ? Math.max(0, lastAt + cooldownMs - serverNow()) : 0;
  const cooling = waitMs > 0;

  return (
    <>
      <div
        className="flex shrink-0 items-center justify-between border-b px-4 py-3"
        style={{ borderColor: "var(--border)" }}
      >
        <span className={styles.label}>대화하기</span>
        <span className="flex items-center gap-1.5">
          <span className={styles.dot} style={{ width: 5, height: 5 }} />
          <span className={`${styles.mono} text-[0.52rem]`} style={{ color: "var(--accent)" }}>
            {seated}명
          </span>
        </span>
      </div>

      <div className={`${styles.scroll} flex flex-1 flex-col gap-3 overflow-y-auto p-4`}>
        {/*
          ★ 안내 문구를 두지 않는다. 왜 정해진 말만 있는지는 버튼 목록이 이미
            말하고 있고(고를 수 있는 게 그것뿐이다), 고른 말이 내 자리 위에 뜬다는
            것도 한 번 누르면 바로 보인다. 규칙을 코드에 남기는 건 이 파일 머리말이
            맡는다 — 화면에까지 적으면 읽을 것만 는다.
        */}
        {/* 리스트 태그를 쓰지 않는다 — 좌석 수를 세는 검사가 이것까지 센다 */}
        <div className="grid grid-cols-2 gap-1.5">
          {(cfg?.lines ?? []).map((l) => (
            <button
              key={l.id}
              type="button"
              // 같은 말을 연달아 보내는 건 서버도 막는다. 눌리기 전에 잠가서
              // "왜 안 되지"가 아니라 "지금은 못 누르는구나"로 보이게 한다.
              disabled={busy || cooling || l.text === mine?.lobby_line}
              onClick={() => say.run(l.id)}
              className={styles.line}
            >
              {l.text}
            </button>
          ))}
        </div>

        {cooling && (
          <p className="text-[0.58rem]" style={{ color: "var(--dim)" }} aria-live="polite">
            {Math.ceil(waitMs / 1000)}초 뒤에 다시 말할 수 있다
          </p>
        )}
      </div>

      {/*
        준비 완료는 발화가 아니라 상태다. 말풍선으로 흐르지 않고 좌석 카드에 붙는다 —
        켜고 끄는 순서가 그대로 신호가 되기 때문이다.
        시작을 막는다. 한 명이 자리를 비우면 그 방은 시작되지 않는다.

        ★ **방장에게는 이 버튼이 없다** (2026-08-07 결정). 바로 밑에 「게임 시작」이
          있어서, 준비를 누르고 시작을 또 누르는 건 같은 뜻의 조작을 두 번 하는 것이다.
          안 눌렀을 때는 자기 버튼이 자기 때문에 잠겨서 고장으로 보였다.
          시작 조건에서도 같이 빠진다 (lib/game/rules.ts 의 startBlock) — 한쪽만
          빼면 버튼은 없는데 조건은 남아 방이 영영 안 열린다.
      */}
      {!isHost && (
        <div className="shrink-0 border-t p-4" style={{ borderColor: "var(--border)" }}>
          <button
            type="button"
            disabled={busy}
            onClick={() => ready.run(!mine?.is_ready)}
            className={`${styles.ready} ${mine?.is_ready ? styles.readyOn : ""}`}
          >
            {mine?.is_ready && <CheckIcon />}
            {mine?.is_ready ? "준비 완료" : "준비"}
          </button>
        </div>
      )}
    </>
  );
}

/* ─────────────────────────────── 아이콘 ─────────────────────────────── */
/* font-awesome CDN 대신 인라인 SVG. 배포본에서 외부 요청이 나가지 않는다 */

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

function UserIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <circle cx="9" cy="5.6" r="3.1" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.6 16c0-3.3 2.9-5.2 6.4-5.2s6.4 1.9 6.4 5.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function UserPlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 18" fill="none" aria-hidden>
      <circle cx="7.4" cy="5.6" r="3.1" stroke="currentColor" strokeWidth="1.3" />
      <path d="M1 16c0-3.3 2.9-5.2 6.4-5.2 1.2 0 2.3.2 3.2.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M15 9.5v6M12 12.5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
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
