/**
 * 메인 로비 — 대기 중인 방 목록 · 방 만들기 · 코드로 입장. 소유: C (SPEC §2, §13-1)
 *
 * 서버 경유만 쓴다. 이 화면은 supabase를 직접 부르지 않는다 (I9).
 *   GET  /api/room                  목록. phase='lobby'인 방만 온다 (§17.6, I1)
 *   POST /api/room  { capacity }    방 만들기. 정원은 3~8, 기본 5 (§17.6)
 *   POST /api/room/join  { code }   입장. 201 신규 · 200 재입장 둘 다 성공이다
 *
 * 목록에 room_id는 오지 않는다 — 이동도 입장도 code로 한다.
 * 봇 수·봇 자리를 유추하게 하는 값은 어떤 형태로도 화면에 올리지 않는다 (I1).
 *
 * 프로필·경험치·친구·전체 채팅·상점처럼 **아직 뒷받침할 데이터가 없는 자리는 지우지 않고
 * 남겼다.** 레이아웃이 완성됐을 때의 모습을 잃지 않기 위해서다. 대신 "MOCK" 배지를 달고
 * 버튼을 disabled로 두어, 눌러도 아무 일이 없다는 것이 화면에서 드러나게 했다.
 * 값 자체는 app/main/mock-lobby.ts에 있다.
 *
 * 화면은 창고의 상영 안내판으로 읽힌다 — 골강판 기둥 사이에 케이스가 늘어서 있고
 * 각 케이스에 코드가 스텐실로 찍혀 있다. 재질은 app/globals.css의 .rib / .case / .cut 셋뿐이다.
 *
 * ★ 좌석은 막대가 아니라 **칸**으로 그린다. 정원이 방마다 3~8로 다르므로(§17.6)
 *   비율 막대는 "몇 자리짜리 방인지"를 지워버린다. 칸을 정원만큼 그리면 8인 방과
 *   3인 방이 한눈에 갈린다.
 *
 * TODO(C): 필터 · 전체 채팅 입력 동작.
 */
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChipIcon,
  CoinIcon,
  ExpandIcon,
  GearIcon,
  GemIcon,
  PlusIcon,
  SearchIcon,
  SendIcon,
  SlidersIcon,
  SpyIcon,
  UserPlusIcon,
} from "@/components/ui/icons";
import { chat, friendStyle, friends, recentGames } from "./mock-lobby";

/**
 * 정원 범위. lib/server/room.ts의 MIN/MAX/DEFAULT_ROOM_CAPACITY와 같은 값이어야 한다.
 * 그 모듈은 service role 키를 쥐고 있어 클라이언트 번들에 넣을 수 없어서 여기 다시 적는다.
 * 어긋나도 서버가 400으로 막지만, 그러면 고를 수 없는 칸이 화면에 생긴다 (SPEC §17.6).
 */
const MIN_CAPACITY = 3;
const MAX_CAPACITY = 8;
const DEFAULT_CAPACITY = 5;

const CAPACITY_OPTIONS = Array.from(
  { length: MAX_CAPACITY - MIN_CAPACITY + 1 },
  (_, i) => MIN_CAPACITY + i,
);

/** 목록 폴링 간격. 로비는 Realtime을 붙이지 않았다 — 방 하나가 아니라 방 목록이라 I10의 방 필터를 걸 수 없다. */
const POLL_MS = 3000;

/** GET /api/room 의 한 줄. room_id는 내려오지 않는다 (lib/server/room.ts의 OpenRoom). */
interface OpenRoom {
  code: string;
  capacity: number;
  players: number;
  created_at: string;
}

/** 실패 응답은 { error: '...' }다. 본문이 JSON이 아닐 수도 있어 감싼다. */
async function errorOf(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * created_at을 "n분 전"으로. 표시용이라 클라이언트 시계를 써도 된다 —
 * 페이즈 전환 판정이 아니다 (I2).
 */
function timeAgo(iso: string): string {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return "방금";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간 전`;
  return `${Math.floor(hour / 24)}일 전`;
}

export default function MainPage() {
  const router = useRouter();

  /** null이면 아직 한 번도 못 읽은 상태다. 빈 배열(방이 없다)과 구분해야 한다. */
  const [rooms, setRooms] = useState<OpenRoom[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  /** 방을 만들거나 들어가는 중. 한 번에 하나만 돈다 — 두 번 눌러 방이 두 개 생기면 곤란하다. */
  const [busy, setBusy] = useState(false);

  const loadRooms = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/room", { cache: "no-store" });
      if (!res.ok) {
        setListError(await errorOf(res, "방 목록을 불러오지 못했다"));
        return;
      }
      const body = (await res.json()) as { rooms: OpenRoom[] };
      setRooms(body.rooms);
      setListError(null);
    } catch {
      // 폴링 한 번이 실패해도 이미 받은 목록은 지우지 않는다. 화면이 깜빡이는 게 더 나쁘다.
      setListError("서버에 연결하지 못했다");
    }
  }, []);

  useEffect(() => {
    void loadRooms();
    const timer = setInterval(() => void loadRooms(), POLL_MS);
    return () => clearInterval(timer);
  }, [loadRooms]);

  const createRoom = useCallback(
    async (capacity: number): Promise<void> => {
      setBusy(true);
      setCreateError(null);
      try {
        const res = await fetch("/api/room", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ capacity }),
        });
        if (!res.ok) {
          setCreateError(await errorOf(res, "방을 만들지 못했다"));
          return;
        }
        // 만든 사람은 이미 방장으로 앉아 있다. 토큰은 쿠키로 왔다 (SPEC §17.4).
        const { room } = (await res.json()) as { room: { code: string } };
        setCreateOpen(false);
        router.push(`/room/${room.code}`);
      } catch {
        setCreateError("서버에 연결하지 못했다");
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  /**
   * 코드로 입장. 목록의 카드도 이 길을 쓴다 — /room/{code}로 그냥 이동하면 자리가
   * 배정되지 않아 "이 방의 참가자가 아니다" 화면을 보게 된다.
   * 이미 그 방에 있으면 서버가 원래 자리를 그대로 돌려준다(rejoined).
   */
  const enterRoom = useCallback(
    async (code: string): Promise<void> => {
      const normalized = code.trim().toUpperCase();
      setBusy(true);
      setJoinError(null);
      try {
        const res = await fetch("/api/room/join", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: normalized }),
        });
        // 404 그런 방이 없다 · 409 꽉 찼다 / 이미 시작된 방. 문구를 그대로 보여준다.
        if (!res.ok) {
          setJoinError(await errorOf(res, "입장하지 못했다"));
          return;
        }
        router.push(`/room/${normalized}`);
      } catch {
        setJoinError("서버에 연결하지 못했다");
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  const openCreate = useCallback(() => {
    setCreateError(null);
    setCreateOpen(true);
  }, []);

  const closeCreate = useCallback(() => {
    setCreateOpen(false);
    setCreateError(null);
  }, []);

  const visible = useMemo(
    () => (rooms ?? []).filter((room) => room.code.includes(query)),
    [rooms, query],
  );
  /** 4자 알파벳이면 목록에 없는 방이어도 코드로 바로 들어갈 수 있다. */
  const isCode = /^[A-Z]{4}$/.test(query);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Header />

      <main className="flex flex-1 overflow-hidden">
        <ProfileSidebar />
        <RoomList
          rooms={rooms}
          visible={visible}
          query={query}
          isCode={isCode}
          busy={busy}
          listError={listError}
          joinError={joinError}
          // 상태에 이미 정규화된 값만 담는다. 화면에 보이는 값과 거르는 값이 같아야 한다.
          onQueryChange={(value) => setQuery(value.replace(/\s/g, "").toUpperCase())}
          onRetry={() => void loadRooms()}
          onCreate={openCreate}
          onEnter={(code) => void enterRoom(code)}
        />
        <SocialSidebar />
      </main>

      <Footer />

      {createOpen && (
        <CreateRoomDialog
          busy={busy}
          error={createError}
          onClose={closeCreate}
          onSubmit={(capacity) => void createRoom(capacity)}
        />
      )}
    </div>
  );
}

/* ─────────────────────────────── 머리말 ─────────────────────────────── */

const navItems = ["멀티플레이", "상점", "컬렉션", "기록"];

function Header() {
  return (
    <header className="rib flex h-16 shrink-0 items-center justify-between border-b border-black/70 px-6 shadow-[0_1px_0_rgba(214,207,194,0.05)]">
      <div className="flex items-center gap-7">
        <Link href="/" className="engraved text-xl font-black tracking-tighter">
          기계인 척
        </Link>
        <nav className="hidden items-center gap-5 md:flex">
          {navItems.map((item, i) => (
            <button
              key={item}
              type="button"
              disabled={i !== 0}
              className={
                i === 0
                  ? "stencil border-b border-signal pb-1 text-[10px] text-bone"
                  : "stencil cursor-default pb-1 text-[10px] text-ash"
              }
            >
              {item}
            </button>
          ))}
          <MockBadge />
        </nav>
      </div>

      <div className="flex items-center gap-5">
        <div className="cut flex items-center gap-3 px-3 py-1.5">
          <MockBadge />
          <span className="flex items-center gap-1.5">
            <CoinIcon className="h-3.5 w-3.5 text-tung" />
            <span className="readout text-xs text-bone">12,450</span>
          </span>
          <span className="h-3 w-px bg-bone/10" />
          <span className="flex items-center gap-1.5">
            <GemIcon className="h-3.5 w-3.5 text-bounce" />
            <span className="readout text-xs text-bone">420</span>
          </span>
        </div>

        <div className="flex items-center gap-3 border-l border-bone/10 pl-5">
          <div className="text-right">
            <p className="stencil text-[10px] text-bone">Player_K</p>
            <p className="readout flex items-center justify-end gap-1.5 text-[10px] text-tung/70">
              LV 24
              <MockBadge />
            </p>
          </div>
          <div className="relative">
            <Avatar name="Player_K" className="h-9 w-9" />
            <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-tung shadow-[0_0_8px_2px] shadow-tung/60" />
          </div>
        </div>

        <button type="button" aria-label="설정 (목업)" disabled className="cursor-default text-ash">
          <GearIcon className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}

/* ───────────────────────────── 왼쪽 기둥 ───────────────────────────── */

function ProfileSidebar() {
  return (
    <aside className="hidden w-72 shrink-0 overflow-y-auto border-r border-black/60 bg-void/50 p-5 lg:block">
      <SectionTitle mock>운영자</SectionTitle>
      <div className="case p-4">
        <div className="flex items-baseline justify-between">
          <span className="stencil text-[9px] text-ash">exp</span>
          <span className="readout text-[11px] text-tung">75%</span>
        </div>
        {/* 눈금 막대. 매끄러운 바 대신 칸으로 — 계기판처럼 읽힌다 */}
        <div className="mt-2 flex gap-px" aria-hidden>
          {Array.from({ length: 20 }, (_, i) => (
            <span
              key={i}
              className={`h-2 flex-1 ${
                i < 15 ? "bg-tung/80 shadow-[0_0_5px] shadow-tung/40" : "bg-bone/8"
              }`}
            />
          ))}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-px">
          <Stat label="승률" value="64%" />
          <Stat label="판수" value="128" />
        </div>
      </div>

      <SectionTitle mock>선호 배역</SectionTitle>
      <div className="space-y-px">
        <RolePreference icon={<ChipIcon className="h-3.5 w-3.5" />} name="진짜 AI" level="High" accent />
        <RolePreference icon={<SpyIcon className="h-3.5 w-3.5" />} name="스파이" level="Mid" />
      </div>

      <SectionTitle mock>최근 판</SectionTitle>
      <div className="space-y-px">
        {recentGames.map((game) => (
          <div key={game.result} className="case flex items-center gap-3 px-3 py-2.5">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                game.win ? "bg-tung shadow-[0_0_8px_2px] shadow-tung/50" : "bg-signal/70"
              }`}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] text-bone">{game.result}</p>
              <p className="text-[10px] text-ash">{game.time}</p>
            </div>
            <span className={`readout text-[11px] ${game.win ? "text-tung" : "text-signal/80"}`}>
              {game.score}
            </span>
          </div>
        ))}
      </div>
    </aside>
  );
}

function SectionTitle({ children, mock = false }: { children: React.ReactNode; mock?: boolean }) {
  return (
    <h3 className="stencil mb-3 mt-7 flex items-center gap-2 text-[9px] text-grime first:mt-0">
      {children}
      {mock && <MockBadge />}
    </h3>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="cut px-2 py-2 text-center">
      <p className="stencil text-[8px] text-ash">{label}</p>
      <p className="readout mt-1 text-base text-bone">{value}</p>
    </div>
  );
}

function RolePreference({
  icon,
  name,
  level,
  accent = false,
}: {
  icon: React.ReactNode;
  name: string;
  level: string;
  accent?: boolean;
}) {
  return (
    <div className="case flex items-center justify-between px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <span className={accent ? "text-tung" : "text-grime"}>{icon}</span>
        <span className="text-[13px] text-bone">{name}</span>
      </div>
      <span className="stencil text-[9px] text-ash">{level}</span>
    </div>
  );
}

/* ───────────────────────────── 가운데 상영 안내 ───────────────────────────── */

function RoomList({
  rooms,
  visible,
  query,
  isCode,
  busy,
  listError,
  joinError,
  onQueryChange,
  onRetry,
  onCreate,
  onEnter,
}: {
  rooms: OpenRoom[] | null;
  visible: OpenRoom[];
  query: string;
  isCode: boolean;
  busy: boolean;
  listError: string | null;
  joinError: string | null;
  onQueryChange: (value: string) => void;
  onRetry: () => void;
  onCreate: () => void;
  onEnter: (code: string) => void;
}) {
  const loading = rooms === null;
  const total = rooms?.length ?? 0;

  return (
    <section className="flex-1 overflow-y-auto px-8 py-7">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="stencil text-[10px] text-signal/70">waiting rooms</p>
          <h2 className="engraved mt-2 text-3xl font-black">시작을 기다리는 방</h2>
          <p className="mt-1.5 text-[13px] text-grime">
            {loading
              ? "불러오는 중…"
              : query
                ? `${total}개 중 ${visible.length}개가 “${query}”와 맞는다.`
                : `${total}개가 열려 있다. 이미 시작한 방은 목록에 없다.`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ash" />
            <input
              type="text"
              value={query}
              // 코드는 대문자 4자다. maxLength는 걸지 않는다 — 이 칸은 검색도 겸한다.
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="CODE"
              aria-label="방 코드 검색"
              className="cut readout w-44 py-2.5 pl-9 pr-3 text-sm tracking-[0.3em] text-bone transition-colors placeholder:font-sans placeholder:tracking-[0.2em] placeholder:text-ash focus:border-tung/40 focus:outline-none"
            />
          </div>

          {isCode && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onEnter(query)}
              className="case case-live stencil px-4 py-2.5 text-[10px] text-tung disabled:opacity-40"
            >
              이 코드로 입장
            </button>
          )}

          <button
            type="button"
            aria-label="필터 (목업)"
            disabled
            className="case cursor-default px-3 py-2.5 text-ash"
          >
            <SlidersIcon className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={onCreate}
            className="case case-live group flex items-center gap-3 px-5 py-2.5 disabled:opacity-40"
          >
            <PlusIcon className="h-3.5 w-3.5 text-signal" />
            <span className="stencil text-[10px] text-flare">방 만들기</span>
          </button>
        </div>
      </div>

      {listError && (
        <div className="case mt-6 flex flex-wrap items-center justify-between gap-3 border-signal/30 px-5 py-3">
          <p className="text-[13px] text-signal">{listError}</p>
          <button
            type="button"
            onClick={onRetry}
            className="stencil text-[10px] text-signal/80 underline-offset-4 hover:underline"
          >
            다시 시도
          </button>
        </div>
      )}

      {joinError && (
        <div role="alert" className="case mt-6 border-signal/30 px-5 py-3 text-[13px] text-signal">
          {joinError}
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-px md:grid-cols-2 2xl:grid-cols-3">
        {loading
          ? [0, 1, 2].map((i) => <RoomCardSkeleton key={i} />)
          : visible.map((room) => (
              <RoomCard key={room.code} room={room} busy={busy} onEnter={onEnter} />
            ))}

        <button
          type="button"
          disabled={busy}
          onClick={onCreate}
          className="group flex min-h-[8.5rem] flex-col items-center justify-center gap-2 border border-dashed border-bone/10 transition-colors hover:border-tung/30 hover:bg-tung/[0.03] disabled:opacity-40"
        >
          <PlusIcon className="h-4 w-4 text-ash transition-colors group-hover:text-tung" />
          <span className="stencil text-[9px] text-ash transition-colors group-hover:text-tung">
            새 방
          </span>
        </button>
      </div>

      {!loading && visible.length === 0 && (
        <p className="mt-6 max-w-md text-[13px] leading-relaxed text-grime">
          {query
            ? `“${query}”와 맞는 방이 목록에 없다. 코드가 정확하면 위의 “이 코드로 입장”으로 바로 들어갈 수 있다.`
            : "기다리는 방이 없다. 새로 만들면 첫 방이 된다."}
        </p>
      )}
    </section>
  );
}

function RoomCard({
  room,
  busy,
  onEnter,
}: {
  room: OpenRoom;
  busy: boolean;
  onEnter: (code: string) => void;
}) {
  const full = room.players >= room.capacity;

  return (
    // 카드도 /api/room/join을 거친다. /room/{code}로 그냥 이동하면 자리가 없어
    // "이 방의 참가자가 아니다" 화면이 나온다. 정원이 찼어도 막지 않는다 —
    // 이미 그 방에 앉아 있던 사람은 서버가 원래 자리로 돌려보내 준다.
    <button
      type="button"
      disabled={busy}
      onClick={() => onEnter(room.code)}
      className="case case-live riveted group min-h-[8.5rem] px-7 py-5 text-left disabled:pointer-events-none disabled:opacity-40"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="stencil text-[9px] text-ash">room</p>
          <p className="readout mt-1 truncate text-3xl tracking-[0.28em] text-linen transition-colors group-hover:text-flare">
            {room.code}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="readout text-lg text-bone">
            {room.players}
            <span className="text-ash">/{room.capacity}</span>
          </p>
          <p className="stencil text-[8px] text-ash">seats</p>
        </div>
      </div>

      {/*
        ★ 좌석 칸. 정원만큼 그린다 — 8인 방과 3인 방이 눈으로 갈린다.
          비율 막대로 그리면 둘 다 같은 길이가 되어 정원 정보가 사라진다 (§17.6).
          채워진 칸은 사람 수다. 봇은 아직 없다 (lobby 목록이므로).
      */}
      <div className="mt-5 flex gap-1" aria-hidden>
        {Array.from({ length: room.capacity }, (_, i) => (
          <span
            key={i}
            className={`h-2.5 flex-1 rounded-[1px] transition-colors ${
              i < room.players
                ? full
                  ? "bg-signal/80 shadow-[0_0_7px] shadow-signal/50"
                  : "bg-tung/85 shadow-[0_0_7px] shadow-tung/40"
                : "bg-bone/8"
            }`}
          />
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between text-[11px]">
        <span className="text-ash">{timeAgo(room.created_at)}</span>
        {full && <span className="stencil text-[9px] text-signal">정원 참</span>}
      </div>
    </button>
  );
}

function RoomCardSkeleton() {
  return (
    <div aria-hidden className="case min-h-[8.5rem] animate-pulse px-7 py-5">
      <div className="h-2 w-8 bg-bone/8" />
      <div className="mt-2 h-8 w-32 bg-bone/8" />
      <div className="mt-6 h-2.5 w-full bg-bone/8" />
      <div className="mt-4 h-2 w-16 bg-bone/8" />
    </div>
  );
}

/* ───────────────────────────── 방 만들기 ───────────────────────────── */

function CreateRoomDialog({
  busy,
  error,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (capacity: number) => void;
}) {
  const [capacity, setCapacity] = useState(DEFAULT_CAPACITY);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 만드는 중에 닫으면 방만 생기고 화면은 안 넘어간다.
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-room-title"
      onClick={() => {
        if (!busy) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-void/85 p-6 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="case riveted w-full max-w-md px-9 py-8"
      >
        <p className="stencil text-[10px] text-signal/80">new room</p>
        <h2 id="create-room-title" className="engraved mt-2 text-2xl font-black">
          몇 자리로 열까
        </h2>

        {/* 정원 선택 — 좌석 수만큼 칸이 켜지는 다이얼 */}
        <div className="mt-8 flex gap-1.5">
          {CAPACITY_OPTIONS.map((n) => {
            const selected = n === capacity;
            return (
              <button
                key={n}
                type="button"
                aria-pressed={selected}
                disabled={busy}
                onClick={() => setCapacity(n)}
                className={`readout flex-1 py-4 text-lg transition-all disabled:opacity-40 ${
                  selected
                    ? "bg-tung/15 text-flare shadow-[inset_0_0_0_1px_rgba(255,217,172,0.45),0_0_22px_-8px_rgba(255,217,172,0.9)]"
                    : "cut text-grime hover:text-tung"
                }`}
              >
                {n}
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex gap-1" aria-hidden>
          {Array.from({ length: capacity }, (_, i) => (
            <span key={i} className="h-1.5 flex-1 rounded-[1px] bg-tung/70" />
          ))}
        </div>

        {/* ★ 빈자리를 "무엇이" 채우는지 말하지 않는다. 그 사실은 공개되지 않는다 (I1). */}
        <p className="mt-5 text-[12px] leading-relaxed text-grime">
          빈자리는 시작할 때 채워진다. 몇 자리가 채워졌는지는 아무에게도 보이지 않는다.
        </p>

        {error && (
          <p role="alert" className="cut mt-5 px-4 py-3 text-[13px] text-signal">
            {error}
          </p>
        )}

        <div className="mt-8 flex items-center justify-end gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="stencil px-4 py-3 text-[10px] text-grime transition-colors hover:text-bone disabled:opacity-40"
          >
            취소
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onSubmit(capacity)}
            className="case case-live stencil px-7 py-3.5 text-[10px] text-flare disabled:opacity-40"
          >
            {busy ? "여는 중…" : `${capacity}자리로 연다`}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────────── 오른쪽 기둥 ───────────────────────────── */

function SocialSidebar() {
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-l border-black/60 bg-void/50 2xl:flex">
      <div className="flex flex-1 flex-col overflow-hidden p-5">
        <div className="flex items-center justify-between">
          <h3 className="stencil flex items-center gap-2 text-[9px] text-grime">
            동료
            <MockBadge />
          </h3>
          <div className="flex gap-2 text-ash">
            <button type="button" aria-label="친구 추가 (목업)" disabled className="cursor-default">
              <UserPlusIcon className="h-3.5 w-3.5" />
            </button>
            <button type="button" aria-label="친구 검색 (목업)" disabled className="cursor-default">
              <SearchIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <ul className="mt-4 flex-1 space-y-3 overflow-y-auto pr-1">
          {friends.map((friend) => {
            const style = friendStyle[friend.state];
            return (
              <li
                key={friend.name}
                className={`flex items-center gap-3 ${friend.state === "오프라인" ? "opacity-40" : ""}`}
              >
                <div className="relative">
                  <Avatar name={friend.name} className="h-8 w-8" />
                  <span
                    className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ${style.dot}`}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] text-bone">{friend.name}</p>
                  <p className={`text-[10px] ${style.text}`}>
                    {friend.state}
                    {friend.detail ? ` · ${friend.detail}` : ""}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex h-64 flex-col border-t border-black/60 p-4">
        <div className="flex items-center justify-between">
          <span className="stencil flex items-center gap-2 text-[9px] text-grime">
            전체 채팅
            <MockBadge />
          </span>
          <button type="button" aria-label="채팅 확대 (목업)" disabled className="cursor-default text-ash">
            <ExpandIcon className="h-3 w-3" />
          </button>
        </div>

        <div className="mt-3 flex-1 space-y-2.5 overflow-y-auto pr-1">
          {chat.map((line, i) => (
            <p key={i} className="text-[11px] leading-relaxed text-dust">
              <span className={`font-semibold ${line.tone}`}>{line.user}</span>{" "}
              {line.message}
            </p>
          ))}
        </div>

        <div className="relative mt-3">
          <input
            type="text"
            disabled
            placeholder="아직 보낼 수 없다"
            aria-label="전체 채팅 (목업)"
            className="cut w-full cursor-default py-2 pl-3 pr-9 text-[11px] text-bone placeholder:text-ash"
          />
          <button
            type="button"
            aria-label="전송 (목업)"
            disabled
            className="absolute right-2 top-1/2 -translate-y-1/2 cursor-default text-ash"
          >
            <SendIcon className="h-3 w-3" />
          </button>
        </div>
      </div>
    </aside>
  );
}

/* ─────────────────────────────── 바닥글 ─────────────────────────────── */

function Footer() {
  return (
    <footer className="rib flex h-9 shrink-0 items-center justify-between border-t border-black/70 px-6 text-[10px]">
      <div className="flex items-center gap-4 text-ash">
        <MockBadge />
        <span className="readout">1,204 online</span>
        <span className="flex items-center gap-1.5">
          <span className="h-1 w-1 rounded-full bg-tung shadow-[0_0_6px_1px] shadow-tung/60" />
          정상
        </span>
      </div>
      <div className="flex gap-4 text-ash">
        <Link href="/intro" className="transition-colors hover:text-tung">
          배역 설명
        </Link>
        <Link href="/" className="transition-colors hover:text-tung">
          작업 보드
        </Link>
      </div>
    </footer>
  );
}

/* ─────────────────────────────── 공통 ─────────────────────────────── */

/**
 * 뒷받침할 데이터가 없는 자리라는 표시.
 * 진짜처럼 보이는 화면이 제일 나쁘다 — 눌리는 척하는 버튼은 disabled로 둔다.
 */
function MockBadge() {
  return (
    <span className="stencil rounded-[1px] bg-bone/5 px-1.5 py-0.5 text-[8px] text-ash">
      mock
    </span>
  );
}

/**
 * 이니셜 아바타. 외부 이미지 호스트에 의존하지 않는다.
 * TODO(C): mask_id 기반 아바타 에셋으로 교체 (SPEC 용어표).
 */
function Avatar({ name, className = "" }: { name: string; className?: string }) {
  const initial = name.trim().charAt(0).toUpperCase();
  return (
    <span
      className={`case flex items-center justify-center text-[11px] font-bold text-dust ${className}`}
      aria-hidden
    >
      {initial}
    </span>
  );
}
