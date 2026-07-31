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
 * ★ 좌석은 <ul>/<li> 로 정원만큼 그린다 (정원 3~8, §17.6). 규칙·문구 목록에는
 *   리스트 태그를 쓰지 않는다 — 좌석 수를 세는 검사가 그것까지 세게 된다.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

import type { MeResponse } from "@/lib/api/room";
import type { PublicPlayer, Room } from "@/lib/game/types";
import {
  REQUEST,
  useSayLobbyLine,
  useSetLobbyReady,
  useStartRoom,
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

  const start = useStartRoom(code, room.id);
  const busy = useRoomUi(selectIsBusy);
  const starting = useRoomUi(selectIsPending(REQUEST.start));

  return (
    <div className={`${styles.root} flex h-screen flex-col overflow-hidden`}>
      <div aria-hidden className={styles.backdrop} />
      <div aria-hidden className={styles.noise} />
      <div aria-hidden className={styles.scanlines} />

      {/* ── 머리말 ─────────────────────────────────────────────────── */}
      <header
        className="flex h-12 shrink-0 items-center justify-between gap-4 border-b px-4 sm:px-8"
        style={{ background: "var(--bg)", borderColor: "var(--border)" }}
      >
        <div className="flex min-w-0 items-center gap-4">
          <Link
            href="/main"
            className="flex shrink-0 items-center gap-2 no-underline"
            style={{ color: "var(--muted)" }}
          >
            <ArrowLeftIcon />
            <span className="text-[0.58rem] uppercase tracking-[0.18em]">로비</span>
          </Link>
          <span className="h-4 w-px shrink-0" style={{ background: "var(--border2)" }} />
          <div className="min-w-0">
            <div className={`${styles.label} ${styles.labelStrong}`}>room</div>
            <div className={`${styles.mono} truncate text-[0.85rem] font-bold tracking-[0.12em]`}>
              {room.code}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-4 sm:gap-6">
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
          <span className="flex items-center gap-2">
            <span
              className="text-[0.62rem] font-semibold uppercase tracking-[0.1em]"
              style={{ color: "var(--accent)" }}
            >
              {me.player.nickname}
            </span>
            <span className={`${styles.tag} ${styles.tagGreen}`}>나</span>
          </span>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* ── 가운데 ───────────────────────────────────────────────── */}
        <main className={`${styles.scroll} flex flex-1 flex-col gap-6 overflow-y-auto p-5 sm:p-8`}>
          {error && <p className={styles.alert}>{error}</p>}

          <CodeBanner code={room.code} seated={seated} capacity={room.capacity} />

          <section>
            <div className={`${styles.label} mb-3`}>참가자 현황</div>
            <SeatGrid
              players={players}
              capacity={room.capacity}
              meId={me.player.id}
              hostSeat={mine?.seat ?? null}
              isHost={me.is_host}
            />
          </section>

          <RulePanel capacity={room.capacity} />
        </main>

        {/* ── 오른쪽 ───────────────────────────────────────────────── */}
        <aside
          className="hidden w-[300px] shrink-0 flex-col border-l lg:flex"
          style={{ background: "var(--surface)", borderColor: "var(--border)" }}
        >
          <SayPanel code={code} roomId={room.id} mine={mine} seated={seated} />

          <div className="border-t p-4" style={{ borderColor: "var(--border)" }}>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[0.6rem]" style={{ color: "var(--muted)" }}>
                지금 {seated}명
              </span>
              <span className={`${styles.mono} text-[0.6rem]`} style={{ color: "var(--muted)" }}>
                정원 {room.capacity}
              </span>
            </div>
            <div className={`${styles.bar} mb-4`}>
              <div
                className={styles.barFill}
                style={{ width: `${Math.min(100, (seated / room.capacity) * 100)}%` }}
              />
            </div>

            {/*
              ★ "몇 명 더 필요합니다"라고 쓰지 않는다. 정원을 다 채우지 않아도
                시작할 수 있고, 남은 자리가 어떻게 되는지는 대기실에서 말하지 않는다 (I1).
            */}
            {me.is_host ? (
              <button
                type="button"
                className={styles.btnAccent}
                style={{ width: "100%", padding: "0.85rem" }}
                disabled={busy}
                onClick={() => start.run()}
              >
                {starting ? "시작하는 중…" : "게임 시작"} <PlayIcon />
              </button>
            ) : (
              <p
                className="flex items-center justify-center gap-2 py-3 text-center text-[0.65rem]"
                style={{ color: "var(--muted)" }}
              >
                <span className={`${styles.dot} ${styles.blink}`} />
                방장이 시작하기를 기다리는 중…
              </p>
            )}

            <Link
              href="/main"
              className={styles.btnGhost}
              style={{ width: "100%", marginTop: "0.5rem", padding: "0.6rem", fontSize: "0.56rem" }}
            >
              <ExitIcon /> 방 나가기
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ─────────────────────────────── 코드 ─────────────────────────────── */

function CodeBanner({
  code,
  seated,
  capacity,
}: {
  code: string;
  seated: number;
  capacity: number;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // https 가 아닌 곳에는 clipboard API 가 없다. 코드가 화면에 크게 떠 있으니
      // 눈으로 옮겨 적으면 된다 — 실패를 오류로 띄우지 않는다.
    }
  };

  return (
    <div className={`${styles.panel} flex flex-wrap items-center justify-between gap-6 p-6 sm:p-8`}>
      <div className="min-w-0">
        <div className={`${styles.label} mb-2`}>입장 코드</div>
        {/* 코드는 한 덩어리로 둔다 — 글자를 쪼개면 복사도 읽기도 나빠진다 */}
        <div
          className={`${styles.mono} text-[clamp(2.4rem,7vw,3.5rem)] font-bold leading-none tracking-[0.28em]`}
        >
          {code}
        </div>
        <div className="mt-3 text-[0.7rem] font-light" style={{ color: "var(--muted)" }}>
          이 코드를 알려주면 바로 들어올 수 있다
        </div>
      </div>

      <div className="flex flex-col items-end gap-3">
        <button
          type="button"
          onClick={() => void copy()}
          className={`${styles.copy} ${copied ? styles.copyDone : ""}`}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "복사 완료" : "코드 복사"}
        </button>
        <div className="flex items-center gap-2">
          <span style={{ color: "var(--muted)" }}>
            <UsersIcon />
          </span>
          <span className={`${styles.mono} text-[1.1rem] font-bold`}>
            {seated}
            <span style={{ color: "var(--muted)" }}>/{capacity}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────── 좌석 ─────────────────────────────── */

/**
 * 좌석 칸. **정원만큼** 그린다 (§17.6).
 *
 * ★ 빈 칸이 곧 "시작하면 기계가 앉을 자리"라는 건 이 화면이 막을 수 없는 구멍이다.
 *   인원을 감춰도 빈칸 수가 같은 값을 준다. 그래서 최소한 문구로 그걸 알려주지는
 *   않는다 — 아래 RulePanel 의 표현을 여기서 뒤집지 말 것.
 */
function SeatGrid({
  players,
  capacity,
  meId,
  hostSeat,
  isHost,
}: {
  players: PublicPlayer[];
  capacity: number;
  meId: string;
  hostSeat: number | null;
  isHost: boolean;
}) {
  const bySeat = new Map(players.map((p) => [p.seat, p]));

  return (
    <ul
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(9.5rem, 1fr))` }}
    >
      {Array.from({ length: capacity }, (_, i) => i + 1).map((seat) => {
        const p = bySeat.get(seat) ?? null;
        const isMe = p != null && p.id === meId;

        return (
          <li key={seat}>
            <div
              className={[
                styles.slot,
                isMe ? styles.slotMe : "",
                p == null ? styles.slotEmpty : "",
              ].join(" ")}
            >
              {isMe && isHost && seat === hostSeat && (
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
                  p?.is_ready ? styles.pulse : "",
                ].join(" ")}
              >
                {p == null ? <UserPlusIcon /> : <UserIcon />}
              </span>

              <span className="text-center">
                <span
                  className="block truncate text-[0.72rem] font-semibold uppercase tracking-[0.06em]"
                  style={{ color: p == null ? "var(--dim)" : isMe ? "var(--accent)" : "var(--text)" }}
                >
                  {p ? p.nickname : "빈자리"}
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
                  <span className={styles.dot} style={p.is_ready ? undefined : { opacity: 0.35 }} />
                  <span
                    className="text-[0.55rem] tracking-[0.1em]"
                    style={{ color: p.is_ready ? "var(--accent)" : "var(--muted)" }}
                  >
                    {p.is_ready ? "준비 완료" : "접속중"}
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

/* ─────────────────────────────── 규칙 ─────────────────────────────── */

/**
 * 방 규칙. 문구는 SPEC 을 따른다 — 시안의 "5명 (인간 4명 + AI 1명)"은 쓰지 않는다.
 * 정원은 방마다 다르고(§17.6), 기계가 몇인지는 **시작해야** 알려준다 (§15-3).
 */
function RulePanel({ capacity }: { capacity: number }) {
  return (
    <div className={styles.panel}>
      <div
        className="flex items-center justify-between border-b px-5 py-3"
        style={{ borderColor: "var(--border)" }}
      >
        <span className={`${styles.label} ${styles.labelStrong}`}>방 규칙</span>
        <span className={styles.tag}>표준</span>
      </div>

      <div className={styles.ruleRow}>
        <span className={styles.ruleIcon}>
          <UsersIcon />
        </span>
        <div>
          <div className={`${styles.label} mb-1`}>정원</div>
          <div className="text-[0.82rem]">{capacity}자리</div>
        </div>
      </div>

      <div className={styles.ruleRow}>
        <span className={styles.ruleIcon}>
          <UserPlusIcon />
        </span>
        <div>
          <div className={`${styles.label} mb-1`}>빈자리</div>
          <div className="text-[0.82rem]">
            시작할 때 기계가 채운다.{" "}
            <span style={{ color: "var(--muted)" }}>몇 대인지는 시작하면 알려준다.</span>
          </div>
        </div>
      </div>

      <div className={`${styles.ruleRow}`}>
        <span className={`${styles.ruleIcon} ${styles.ruleIconAccent}`}>
          <EyeOffIcon />
        </span>
        <div>
          <div className={`${styles.label} mb-1`}>숨는 것</div>
          <div className="text-[0.82rem]">
            어느 자리가 기계인지.{" "}
            <span style={{ color: "var(--muted)" }}>시작할 때 모두의 자리가 다시 섞인다.</span>
          </div>
        </div>
      </div>

      <div className={styles.ruleRow}>
        <span className={styles.ruleIcon}>
          <MaskIcon />
        </span>
        <div>
          <div className={`${styles.label} mb-1`}>연기자</div>
          <div className="text-[0.82rem]">
            사람 중 1명. <span style={{ color: "var(--muted)" }}>사람이 2명 이상일 때만 생긴다.</span>
          </div>
        </div>
      </div>

      <div className={styles.ruleRow}>
        <span className={`${styles.ruleIcon} ${styles.ruleIconAccent}`}>
          <CheckIcon />
        </span>
        <div>
          <div className={`${styles.label} mb-1`}>승리</div>
          <div className="text-[0.82rem]">진짜 기계를 지목하면 사람들의 승리.</div>
          <div className="mt-1 text-[0.75rem]" style={{ color: "var(--muted)" }}>
            연기자에게 표가 몰리면 연기자의 승리다.
          </div>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────── 말하기 ────────────────────────────── */

/**
 * 대기실에서 말하기 — 정해진 문구만 누른다 (SPEC §15-3-결정).
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
}: {
  code: string;
  roomId: string;
  mine: PublicPlayer | null;
  seated: number;
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
        <span className={styles.label}>대기실 말하기</span>
        <span className="flex items-center gap-1.5">
          <span className={styles.dot} style={{ width: 5, height: 5 }} />
          <span className={`${styles.mono} text-[0.52rem]`} style={{ color: "var(--accent)" }}>
            {seated}명
          </span>
        </span>
      </div>

      <div className={`${styles.scroll} flex flex-1 flex-col gap-3 overflow-y-auto p-4`}>
        <p className="text-[0.65rem] leading-[1.8]" style={{ color: "var(--muted)" }}>
          여기서는 정해진 말만 할 수 있다. 미리 짜는 걸 막기 위해서다.
          <br />
          <span style={{ color: "var(--dim)" }}>고른 말은 내 자리 위에 뜬다.</span>
        </p>

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
        시작을 막지도 않는다. 한 명이 자리를 비우면 방이 영영 시작되지 않는다.
      */}
      <div className="shrink-0 border-t p-4" style={{ borderColor: "var(--border)" }}>
        <button
          type="button"
          disabled={busy}
          onClick={() => ready.run(!mine?.is_ready)}
          className={`${styles.ready} ${mine?.is_ready ? styles.readyOn : ""}`}
        >
          {mine?.is_ready && <CheckIcon />}
          {mine?.is_ready ? "준비 완료" : "준비되면 누른다"}
        </button>
      </div>
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

function UsersIcon() {
  return (
    <svg width="12" height="11" viewBox="0 0 14 12" fill="none" aria-hidden>
      <circle cx="5" cy="3.6" r="2.4" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1 11c0-2.2 1.8-3.5 4-3.5S9 8.8 9 11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M10.2 2.1a2.2 2.2 0 010 3.2M11.4 11c0-1.6-.5-2.6-1.4-3.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="13" height="11" viewBox="0 0 14 12" fill="none" aria-hidden>
      <path d="M1 6s2.2-3.6 6-3.6S13 6 13 6s-2.2 3.6-6 3.6S1 6 1 6z" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="7" cy="6" r="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1.5 11L12.5 1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function MaskIcon() {
  return (
    <svg width="13" height="12" viewBox="0 0 14 12" fill="none" aria-hidden>
      <path
        d="M1 3.2C1 2 2 1.3 3.2 1.6c1.3.3 2.5.5 3.8.5s2.5-.2 3.8-.5C12 1.3 13 2 13 3.2c0 3.4-2.7 7.2-6 7.2S1 6.6 1 3.2z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M4.6 4.8h1.6M7.8 4.8h1.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
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
