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
 * 색은 /bg-3d 지하 라운지에서 온다 (app/globals.css). 배경은 layout이 깐 .room-backdrop이
 * 맡으므로 여기서 배경색을 칠하지 않는다 — 칠하면 조명이 가려진다.
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
    <div className="flex h-screen flex-col overflow-hidden text-dust">
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

/* ─────────────────────────────── 헤더 ─────────────────────────────── */

const navItems = ["멀티플레이", "상점", "컬렉션", "기록"];

function Header() {
  return (
    <header className="flex h-20 shrink-0 items-center justify-between border-b border-bone/10 bg-ink/60 px-8 backdrop-blur-md">
      <div className="flex items-center gap-8">
        <Link href="/" className="text-2xl font-black tracking-tighter text-bone">
          기계인 척
        </Link>
        <nav className="hidden items-center gap-6 md:flex">
          {navItems.map((item, i) => (
            <button
              key={item}
              type="button"
              disabled={i !== 0}
              className={
                i === 0
                  ? "border-b-2 border-blood pb-1 text-sm font-bold text-bone"
                  : "cursor-default text-sm text-ash"
              }
            >
              {item}
            </button>
          ))}
          <MockBadge />
        </nav>
      </div>

      <div className="flex items-center gap-6">
        <div className="panel flex items-center gap-3 rounded-full px-4 py-2">
          <MockBadge />
          <span className="flex items-center gap-2">
            <CoinIcon className="h-4 w-4 text-lamp" />
            <span className="text-sm font-bold tracking-wider text-bone">12,450</span>
          </span>
          <span className="h-4 w-px bg-bone/15" />
          <span className="flex items-center gap-2">
            <GemIcon className="h-4 w-4 text-ember" />
            <span className="text-sm font-bold tracking-wider text-bone">420</span>
          </span>
        </div>

        <div className="flex items-center gap-3 border-l border-bone/10 pl-4">
          <div className="text-right">
            <p className="text-xs font-bold uppercase tracking-widest text-bone">
              Player_K
            </p>
            <p className="flex items-center justify-end gap-1.5 text-[10px] font-black text-lamp">
              LV. 24
              <MockBadge />
            </p>
          </div>
          <div className="relative">
            <Avatar name="Player_K" className="h-10 w-10 ring-2 ring-blood/60" />
            <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-ink bg-door" />
          </div>
        </div>

        <button
          type="button"
          aria-label="설정 (목업)"
          disabled
          className="cursor-default text-ash"
        >
          <GearIcon className="h-5 w-5" />
        </button>
      </div>
    </header>
  );
}

/* ───────────────────────────── 왼쪽 사이드바 ───────────────────────────── */

function ProfileSidebar() {
  return (
    <aside className="hidden w-80 shrink-0 overflow-y-auto border-r border-bone/10 bg-ink/40 p-6 lg:block">
      <SectionTitle mock>플레이어 정보</SectionTitle>
      <div className="panel mb-8 rounded-2xl p-4">
        <div className="mb-4">
          <div className="mb-1 flex justify-between text-[10px] font-bold uppercase">
            <span className="text-grime">경험치 (EXP)</span>
            <span className="text-lamp">75%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/40">
            <div className="h-full w-3/4 rounded-full bg-lamp/80" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Stat label="승률" value="64%" />
          <Stat label="판수" value="128" />
        </div>
      </div>

      <SectionTitle mock>선호 역할</SectionTitle>
      <div className="mb-8 space-y-3">
        <RolePreference
          icon={<ChipIcon className="h-4 w-4" />}
          name="진짜 AI"
          level="High"
          accent
        />
        <RolePreference
          icon={<SpyIcon className="h-4 w-4" />}
          name="스파이"
          level="Mid"
        />
      </div>

      <SectionTitle mock>최근 게임</SectionTitle>
      <div className="space-y-2">
        {recentGames.map((game) => (
          <div
            key={game.result}
            className={`flex items-center gap-3 rounded-xl border p-3 ${
              game.win
                ? "border-door/25 bg-door/10"
                : "border-blood/25 bg-blood/10"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                game.win ? "bg-door" : "bg-blood"
              }`}
            />
            <div className="flex-1">
              <p className="text-xs font-bold text-bone">{game.result}</p>
              <p className="text-[10px] text-grime">{game.time}</p>
            </div>
            <span
              className={`text-xs font-bold ${
                game.win ? "text-door" : "text-blood"
              }`}
            >
              {game.score}
            </span>
          </div>
        ))}
      </div>
    </aside>
  );
}

function SectionTitle({
  children,
  mock = false,
}: {
  children: React.ReactNode;
  mock?: boolean;
}) {
  return (
    <h3 className="mb-4 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-bone">
      {children}
      {mock && <MockBadge />}
    </h3>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="inset rounded-xl p-2 text-center">
      <p className="text-[10px] uppercase text-grime">{label}</p>
      <p className="text-lg font-bold text-bone">{value}</p>
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
    <div className="panel flex items-center justify-between rounded-xl p-3">
      <div className="flex items-center gap-3">
        <span
          className={`flex h-8 w-8 items-center justify-center rounded-lg ${
            accent
              ? "bg-lamp/15 text-lamp"
              : "bg-bone/5 text-grime"
          }`}
        >
          {icon}
        </span>
        <span className="text-sm font-medium text-bone">{name}</span>
      </div>
      <span className="text-xs italic text-grime">{level}</span>
    </div>
  );
}

/* ───────────────────────────── 가운데 방 목록 ───────────────────────────── */

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
    <section className="flex-1 overflow-y-auto p-8">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-black tracking-tight text-bone">
            공개 대기방
          </h2>
          <p className="text-sm text-grime">
            {loading
              ? "방 목록을 불러오는 중…"
              : query
                ? `${total}개 중 ${visible.length}개가 “${query}”와 맞습니다.`
                : `현재 ${total}개의 방이 시작을 기다리는 중입니다.`}
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-grime" />
            <input
              type="text"
              value={query}
              // 코드는 대문자 4자다. maxLength는 걸지 않는다 — 이 칸은 검색도 겸한다.
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="방 코드 검색"
              aria-label="방 코드 검색"
              className="inset w-56 rounded-xl py-3 pl-11 pr-6 font-mono text-sm tracking-widest text-bone transition-colors placeholder:font-sans placeholder:tracking-normal placeholder:text-grime focus:border-lamp/50 focus:outline-none"
            />
          </div>

          {isCode && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onEnter(query)}
              className="rounded-xl border border-lamp/30 bg-lamp/10 px-5 py-3 text-sm font-bold text-lamp transition-colors hover:bg-lamp/20 disabled:opacity-50"
            >
              이 코드로 입장
            </button>
          )}

          <button
            type="button"
            aria-label="필터 (목업)"
            disabled
            className="panel cursor-default rounded-xl p-3 text-ash"
          >
            <SlidersIcon className="h-4 w-4" />
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={onCreate}
            className="rounded-xl bg-blood px-6 py-3 text-sm font-black uppercase tracking-widest text-white shadow-[0_0_24px_-8px_rgba(255,43,29,0.9)] transition-colors hover:bg-blood/85 disabled:opacity-50"
          >
            방 만들기
          </button>
        </div>
      </div>

      {listError && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-blood/30 bg-blood/10 p-4">
          <p className="text-sm text-blood">{listError}</p>
          <button
            type="button"
            onClick={onRetry}
            className="rounded-lg border border-blood/40 px-4 py-2 text-xs font-bold text-blood transition-colors hover:bg-blood/20"
          >
            다시 시도
          </button>
        </div>
      )}

      {joinError && (
        <div
          role="alert"
          className="mb-4 rounded-2xl border border-blood/30 bg-blood/10 p-4 text-sm text-blood"
        >
          {joinError}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {loading
          ? [0, 1, 2].map((i) => <RoomCardSkeleton key={i} />)
          : visible.map((room) => (
              <RoomCard key={room.code} room={room} busy={busy} onEnter={onEnter} />
            ))}

        <button
          type="button"
          disabled={busy}
          onClick={onCreate}
          className="group flex min-h-44 flex-col items-center justify-center rounded-2xl border-2 border-dashed border-bone/10 p-6 transition-colors hover:border-blood/40 hover:bg-blood/5 disabled:opacity-50"
        >
          <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-bone/5 text-grime transition-colors group-hover:bg-blood/15 group-hover:text-blood">
            <PlusIcon className="h-5 w-5" />
          </span>
          <span className="text-sm font-bold text-grime transition-colors group-hover:text-blood">
            새로운 방 만들기
          </span>
        </button>
      </div>

      {!loading && visible.length === 0 && (
        <p className="mt-6 text-sm text-grime">
          {query
            ? `“${query}”와 맞는 방이 목록에 없다. 코드가 정확하면 위의 “이 코드로 입장”으로 바로 들어갈 수 있다.`
            : "아직 기다리는 방이 없다. 새로 만들면 첫 방이 된다."}
        </p>
      )}

      <p className="mt-6 text-xs leading-relaxed text-ash">
        목록에는 아직 시작하지 않은 방만 나온다. 이미 시작한 방은 코드를 알아도 들어갈 수 없다.
      </p>
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
  const ratio = Math.min(100, Math.round((room.players / room.capacity) * 100));
  const full = room.players >= room.capacity;

  return (
    // 카드도 /api/room/join을 거친다. /room/{code}로 그냥 이동하면 자리가 없어
    // "이 방의 참가자가 아니다" 화면이 나온다. 정원이 찼어도 막지 않는다 —
    // 이미 그 방에 앉아 있던 사람은 서버가 원래 자리로 돌려보내 준다.
    <button
      type="button"
      disabled={busy}
      onClick={() => onEnter(room.code)}
      className="panel group min-h-44 rounded-2xl p-6 text-left transition-all hover:-translate-y-0.5 hover:border-blood/40 hover:shadow-[0_0_36px_-14px_rgba(255,43,29,0.8)] disabled:pointer-events-none disabled:opacity-50"
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-grime">
            Room Code
          </p>
          <p className="mt-1 truncate font-mono text-2xl font-black tracking-widest text-bone">
            {room.code}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm font-bold text-bone">
            {room.players} / {room.capacity}
          </p>
          <p className="text-[10px] uppercase text-grime">Players</p>
        </div>
      </div>

      <div className="mb-6 flex items-center gap-2 text-xs text-grime">
        <span>{timeAgo(room.created_at)} 만들어짐</span>
        {full && (
          <>
            <span>•</span>
            <span className="font-bold text-lamp">정원이 찼다</span>
          </>
        )}
      </div>

      <div className="h-1 w-full overflow-hidden rounded-full bg-black/40">
        <div
          className={`h-full rounded-full transition-all ${
            full ? "bg-lamp" : "bg-blood"
          }`}
          style={{ width: `${ratio}%` }}
        />
      </div>
    </button>
  );
}

function RoomCardSkeleton() {
  return (
    <div
      aria-hidden
      className="panel min-h-44 animate-pulse rounded-2xl p-6"
    >
      <div className="h-2.5 w-16 rounded bg-bone/10" />
      <div className="mt-2 h-7 w-28 rounded bg-bone/10" />
      <div className="mt-6 h-2.5 w-24 rounded bg-bone/10" />
      <div className="mt-7 h-1 w-full rounded-full bg-bone/10" />
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-6 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="panel w-full max-w-md rounded-2xl p-8 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9)]"
      >
        <h2
          id="create-room-title"
          className="text-2xl font-black tracking-tight text-bone"
        >
          방 만들기
        </h2>
        <p className="mt-1 text-sm text-grime">
          정원을 고르면 바로 방이 열리고 방장으로 앉는다.
        </p>

        <p className="mt-8 text-[10px] font-bold uppercase tracking-[0.2em] text-grime">
          정원
        </p>
        <div className="mt-3 grid grid-cols-6 gap-2">
          {CAPACITY_OPTIONS.map((n) => {
            const selected = n === capacity;
            return (
              <button
                key={n}
                type="button"
                aria-pressed={selected}
                disabled={busy}
                onClick={() => setCapacity(n)}
                className={`rounded-xl border py-3 text-sm font-black tabular-nums transition-colors disabled:opacity-50 ${
                  selected
                    ? "border-blood bg-blood text-white"
                    : "border-bone/10 bg-black/30 text-dust hover:border-blood/40 hover:text-blood"
                }`}
              >
                {n}
              </button>
            );
          })}
        </div>

        {/* ★ 빈자리를 "무엇이" 채우는지 말하지 않는다. 그 사실은 공개되지 않는다 (I1). */}
        <p className="mt-3 text-xs leading-relaxed text-grime">
          빈자리는 시작할 때 채워진다. 몇 자리가 채워졌는지는 아무에게도 보이지 않는다.
        </p>

        {error && (
          <p
            role="alert"
            className="mt-5 rounded-xl border border-blood/30 bg-blood/10 p-3 text-sm text-blood"
          >
            {error}
          </p>
        )}

        <div className="mt-8 flex justify-end gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-xl border border-bone/10 px-5 py-3 text-sm font-bold text-dust transition-colors hover:border-bone/30 hover:text-bone disabled:opacity-50"
          >
            취소
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onSubmit(capacity)}
            className="rounded-xl bg-blood px-6 py-3 text-sm font-black uppercase tracking-widest text-white shadow-[0_0_24px_-8px_rgba(255,43,29,0.9)] transition-colors hover:bg-blood/85 disabled:opacity-50"
          >
            {busy ? "만드는 중…" : `${capacity}인 방 만들기`}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────────── 오른쪽 사이드바 ───────────────────────────── */

function SocialSidebar() {
  return (
    <aside className="hidden w-72 shrink-0 flex-col border-l border-bone/10 bg-ink/40 xl:flex">
      <div className="flex flex-1 flex-col overflow-hidden p-6">
        <div className="mb-6 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-bone">
            친구
            <MockBadge />
          </h3>
          <div className="flex gap-2 text-ash">
            <button
              type="button"
              aria-label="친구 추가 (목업)"
              disabled
              className="cursor-default"
            >
              <UserPlusIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label="친구 검색 (목업)"
              disabled
              className="cursor-default"
            >
              <SearchIcon className="h-4 w-4" />
            </button>
          </div>
        </div>

        <ul className="flex-1 space-y-4 overflow-y-auto pr-1">
          {friends.map((friend) => {
            const style = friendStyle[friend.state];
            return (
              <li
                key={friend.name}
                className={`flex items-center gap-3 ${
                  friend.state === "오프라인" ? "opacity-50" : ""
                }`}
              >
                <div className="relative">
                  <Avatar name={friend.name} className="h-10 w-10 ring-1 ring-bone/15" />
                  <span
                    className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-ink ${style.dot}`}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-bone">
                    {friend.name}
                  </p>
                  <p className={`text-[10px] ${style.text}`}>
                    {friend.state}
                    {friend.detail ? ` (${friend.detail})` : ""}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex h-72 flex-col border-t border-bone/10 bg-black/25 p-4">
        <div className="mb-4 flex items-center justify-between">
          <span className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-grime">
            Global Chat
            <MockBadge />
          </span>
          <button
            type="button"
            aria-label="채팅 확대 (목업)"
            disabled
            className="cursor-default text-ash"
          >
            <ExpandIcon className="h-3 w-3" />
          </button>
        </div>

        <div className="mb-4 flex-1 space-y-3 overflow-y-auto pr-1">
          {chat.map((line, i) => (
            <p key={i} className="text-[11px] leading-relaxed text-dust">
              <span className={`font-bold ${line.tone}`}>{line.user}:</span>{" "}
              {line.message}
            </p>
          ))}
        </div>

        <div className="relative">
          <input
            type="text"
            disabled
            placeholder="아직 보낼 수 없습니다"
            aria-label="전체 채팅 (목업)"
            className="inset w-full cursor-default rounded-lg py-2 pl-3 pr-9 text-xs text-bone placeholder:text-ash"
          />
          <button
            type="button"
            aria-label="전송 (목업)"
            disabled
            className="absolute right-2 top-1/2 -translate-y-1/2 cursor-default text-ash"
          >
            <SendIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
}

/* ─────────────────────────────── 푸터 ─────────────────────────────── */

function Footer() {
  return (
    <footer className="flex h-10 shrink-0 items-center justify-between border-t border-bone/10 bg-ink/60 px-6 text-[10px] font-medium backdrop-blur-md">
      <div className="flex items-center gap-4 text-grime">
        <MockBadge />
        <span>
          동시 접속자: <span className="text-bone">1,204명</span>
        </span>
        <span>
          서버 상태: <span className="text-door">쾌적</span>
        </span>
      </div>
      <div className="flex gap-4 text-grime">
        <Link href="/intro" className="transition-colors hover:text-bone">
          역할 설명
        </Link>
        <Link href="/" className="transition-colors hover:text-bone">
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
    <span className="rounded bg-bone/5 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-ash ring-1 ring-bone/10">
      Mock
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
      className={`flex items-center justify-center rounded-full bg-seam text-xs font-bold text-bone ${className}`}
      aria-hidden
    >
      {initial}
    </span>
  );
}
