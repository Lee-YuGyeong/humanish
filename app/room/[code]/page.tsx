/**
 * 게임 방 — lobby 페이즈(대기방) 화면. 소유: C (SPEC §2)
 *
 * 지금은 목업 데이터로 그린 화면이다 (mock-room.ts).
 * TODO(C): 페이즈별 화면 분기, Realtime 구독, visible_at 기준 지연 렌더 (SPEC §6).
 * TODO(A): 자리 · 준비 상태 · 시작을 서버 경유로 연결 (SPEC I9).
 *
 * 카운트다운·시작 판정은 서버 시각이 기준이다. 화면 숫자는 표시용이다 (SPEC I2, §12.5).
 * 구독을 붙일 때 반드시 이 방(code)으로 스코프한다 (SPEC I10, §16).
 */
import Link from "next/link";
import {
  ArrowLeftIcon,
  CheckIcon,
  CrownIcon,
  InfoIcon,
  SendIcon,
  UserPlusIcon,
} from "@/components/ui/icons";
import {
  MAX_PLAYERS,
  messages,
  room,
  rules,
  seats,
  type Seat,
} from "./mock-room";

export default async function RoomPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const readyCount = seats.filter((s) => s.ready).length;
  const canStart = seats.length === MAX_PLAYERS && readyCount === seats.length;

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-white p-4 text-neutral-600 md:p-8">
      <Backdrop />

      <TopBar code={code} />

      <div className="flex flex-1 flex-col gap-6 overflow-hidden xl:flex-row xl:gap-8">
        <SeatGrid />

        <div className="flex w-full shrink-0 flex-col gap-4 xl:w-96">
          <RulesPanel />
          <RoomChat online={seats.length} />
          <ActionButtons canStart={canStart} />
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────── 상단 ─────────────────────────────── */

function TopBar({ code }: { code: string }) {
  return (
    <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-6">
        <Link
          href="/main"
          aria-label="로비로"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-neutral-200 bg-white text-neutral-900 transition-colors hover:border-indigo-400 hover:text-indigo-600"
        >
          <ArrowLeftIcon className="h-5 w-5" />
        </Link>

        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-2xl font-black tracking-tight text-neutral-900">
              {room.title}
            </h2>
            <span className="rounded bg-indigo-50 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-indigo-700 ring-1 ring-indigo-100">
              {room.mode}
            </span>
          </div>
          <p className="mt-1 text-xs text-neutral-400">
            Room ID:{" "}
            <span className="font-mono text-neutral-900">#{code.toUpperCase()}</span>{" "}
            • 방장: <span className="font-medium text-indigo-600">{room.host}</span>
          </p>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <div className="text-right">
          <p className="text-sm font-bold text-neutral-900">
            {seats.length} / {MAX_PLAYERS}
          </p>
          <p className="text-[10px] uppercase tracking-widest text-neutral-400">
            Players Connected
          </p>
        </div>
        <div className="flex gap-2">
          {Array.from({ length: MAX_PLAYERS }, (_, i) => (
            <span
              key={i}
              className={`h-2 w-2 rounded-full ${
                i < seats.length ? "bg-indigo-600" : "bg-neutral-200"
              }`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────────── 자리 8칸 ───────────────────────────── */

function SeatGrid() {
  const filled = new Map(seats.map((s) => [s.seat, s]));

  return (
    <div className="grid flex-1 auto-rows-fr grid-cols-2 gap-4 overflow-y-auto md:grid-cols-4">
      {Array.from({ length: MAX_PLAYERS }, (_, i) => {
        const seat = filled.get(i + 1);
        return seat ? (
          <PlayerSlot key={i} seat={seat} />
        ) : (
          <EmptySlot key={i} invitable={i === seats.length} />
        );
      })}
    </div>
  );
}

function PlayerSlot({ seat }: { seat: Seat }) {
  return (
    <div
      className={`relative flex flex-col items-center justify-center rounded-2xl border bg-white p-6 text-center shadow-sm transition-colors ${
        seat.isHost
          ? "border-indigo-300 ring-1 ring-indigo-100"
          : "border-neutral-200 hover:border-indigo-300"
      }`}
    >
      {seat.isHost && (
        <CrownIcon className="absolute left-4 top-4 h-4 w-4 text-indigo-500" />
      )}

      <div className="relative mb-5">
        <Avatar
          name={seat.name}
          className={`h-24 w-24 text-2xl ${
            seat.ready ? "ring-4 ring-indigo-100" : "opacity-40 ring-4 ring-neutral-100"
          }`}
        />
        {seat.ready && (
          <span className="absolute -bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-indigo-600 px-3 py-1 text-[10px] font-black uppercase text-white shadow-sm">
            <CheckIcon className="h-3 w-3" />
            Ready
          </span>
        )}
      </div>

      <h4 className="mb-1 font-bold text-neutral-900">
        {seat.name}
        {seat.isYou && <span className="text-neutral-400"> (나)</span>}
      </h4>
      <p
        className={`text-[10px] uppercase tracking-widest ${
          seat.isYou ? "font-black text-indigo-600" : "text-neutral-400"
        }`}
      >
        Level {seat.level}
      </p>

      {!seat.ready && (
        <p className="mt-2 animate-pulse text-[10px] font-bold italic text-amber-600">
          준비 중...
        </p>
      )}
    </div>
  );
}

function EmptySlot({ invitable }: { invitable: boolean }) {
  return (
    <div className="group flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-neutral-200 p-6 text-center transition-colors hover:border-indigo-300 hover:bg-indigo-50/30">
      <span className="mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-neutral-100 text-neutral-400 transition-colors group-hover:bg-white group-hover:text-indigo-600">
        <UserPlusIcon className="h-6 w-6" />
      </span>
      <p className="text-xs font-bold uppercase tracking-widest text-neutral-400">
        플레이어 대기 중...
      </p>
      {invitable && (
        <button
          type="button"
          className="mt-4 rounded-full border border-neutral-200 px-4 py-1.5 text-[10px] font-black uppercase tracking-widest text-neutral-500 transition-colors hover:border-neutral-900 hover:bg-neutral-900 hover:text-white"
        >
          Invite
        </button>
      )}
    </div>
  );
}

/* ───────────────────────────── 오른쪽 패널 ───────────────────────────── */

function RulesPanel() {
  return (
    <section className="rounded-2xl border border-neutral-200 bg-neutral-50/60 p-5">
      <h3 className="mb-4 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-neutral-900">
        <InfoIcon className="h-4 w-4 text-indigo-600" />
        게임 규칙
      </h3>

      <dl className="space-y-3">
        {rules.map((rule) => (
          <div key={rule.label} className="flex items-center justify-between text-xs">
            <dt className="text-neutral-400">{rule.label}</dt>
            <dd
              className={
                rule.accent ? "font-black text-indigo-600" : "font-bold text-neutral-900"
              }
            >
              {rule.value}
            </dd>
          </div>
        ))}
      </dl>

      <p className="mt-4 border-t border-neutral-200 pt-3 text-[11px] leading-relaxed text-neutral-500">
        <span className="font-bold text-indigo-600">승리 조건:</span> 인간은 진짜 AI를
        찾아 투표해야 합니다. AI와 스파이는 인간들을 속여 끝까지 살아남아야 합니다.
      </p>
    </section>
  );
}

function RoomChat({ online }: { online: number }) {
  return (
    <section className="flex flex-1 flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white">
      <div className="flex items-center justify-between border-b border-neutral-200 p-4">
        <span className="text-xs font-bold uppercase tracking-widest text-neutral-900">
          Room Chat
        </span>
        <span className="text-[10px] text-neutral-400">{online} Online</span>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {messages.map((message, i) =>
          message.kind === "system" ? (
            <div key={i} className="py-1 text-center">
              <span className="rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1 text-[9px] uppercase tracking-widest text-neutral-400">
                {message.text}
              </span>
            </div>
          ) : (
            <div
              key={i}
              className={`flex flex-col gap-1 ${
                message.mine ? "items-end" : "items-start"
              }`}
            >
              <span
                className={`text-[10px] font-bold uppercase ${
                  message.mine ? "text-neutral-400" : "text-indigo-600"
                }`}
              >
                {message.author}
              </span>
              <p
                className={`inline-block max-w-[90%] rounded-lg p-2 text-xs ${
                  message.mine
                    ? "rounded-tr-none bg-indigo-600 font-medium text-white"
                    : "rounded-tl-none bg-neutral-100 text-neutral-900"
                }`}
              >
                {message.text}
              </p>
            </div>
          ),
        )}
      </div>

      <div className="border-t border-neutral-200 bg-neutral-50/60 p-4">
        <div className="relative">
          <input
            type="text"
            placeholder="메시지를 입력하세요..."
            className="w-full rounded-xl border border-neutral-200 bg-white py-3 pl-4 pr-10 text-xs text-neutral-900 transition-colors placeholder:text-neutral-400 focus:border-indigo-500 focus:outline-none"
          />
          <button
            type="button"
            aria-label="전송"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-indigo-600 transition-transform hover:scale-110"
          >
            <SendIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </section>
  );
}

function ActionButtons({ canStart }: { canStart: boolean }) {
  return (
    <div className="flex gap-3">
      <button
        type="button"
        className="flex-1 rounded-xl bg-neutral-100 py-4 text-xs font-black uppercase tracking-widest text-neutral-900 transition-colors hover:bg-neutral-200"
      >
        준비 해제
      </button>
      <button
        type="button"
        disabled={!canStart}
        title={canStart ? undefined : "8명이 모두 준비하면 시작할 수 있습니다"}
        className="flex-1 rounded-xl py-4 text-xs font-black uppercase tracking-widest transition-colors enabled:bg-indigo-600 enabled:text-white enabled:hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:text-neutral-400"
      >
        게임 시작
      </button>
    </div>
  );
}

/* ─────────────────────────────── 공통 ─────────────────────────────── */

/** 흰 배경에 얹는 은은한 색 번짐. 원본의 네온 글로우를 대신한다. */
function Backdrop() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10">
      <div className="absolute -right-40 -top-40 h-[500px] w-[500px] rounded-full bg-indigo-100/50 blur-[120px]" />
      <div className="absolute -bottom-40 -left-40 h-[500px] w-[500px] rounded-full bg-purple-100/40 blur-[120px]" />
    </div>
  );
}

/**
 * 이니셜 아바타. 외부 이미지 호스트에 의존하지 않는다.
 * TODO(C): mask_id 기반 아바타 에셋으로 교체 (SPEC 용어표).
 */
function Avatar({ name, className = "" }: { name: string; className?: string }) {
  return (
    <span
      className={`flex items-center justify-center rounded-full bg-neutral-900 font-bold text-white ${className}`}
      aria-hidden
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}
