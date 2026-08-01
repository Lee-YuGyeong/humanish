"use client";

/**
 * 게임 로비 — 방 목록 · 방 만들기 · 코드로 입장. 소유: C (SPEC §2, §13-1)
 *
 * ┌─ 화면만 갈아입혔다 ────────────────────────────────────────────────────┐
 * │ 서버와 주고받는 부분은 예전 page.tsx 그대로다. 껍데기(창고 케이스 →     │
 * │ 취조실 콘솔)만 바꿨다:                                                  │
 * │   GET  /api/room                 목록. phase='lobby'인 방만 온다        │
 * │   POST /api/room  { capacity }   방 만들기. 정원 2~8*, 기본 5 (§17.6)   │
 * │   * UI 표기만 2~8. 서버 하한은 아직 3 — MIN_CAPACITY 주석 참고           │
 * │   POST /api/room/join  { code }  입장. 201 신규 · 200 재입장 둘 다 성공  │
 * │ supabase 를 직접 부르지 않는다 (I9). 목록에 room_id 는 오지 않는다 —    │
 * │ 이동도 입장도 code 로 한다. 봇 수·봇 자리를 유추하게 하는 값은 어떤     │
 * │ 형태로도 화면에 올리지 않는다 (I1).                                     │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 시안에 있으나 **뒷받침할 데이터가 없는 자리**(레벨 · EXP · 승률 · 접속자 수 ·
 *   방 이름 · 모드 · 라운드 시간 · 비공개 코드 · 검색 필터)는 지우지 않고 남겼다.
 *   레이아웃이 완성됐을 때의 모습을 잃지 않기 위해서다. 대신 전부 MOCK 배지를 달고
 *   disabled 로 뒀다 — 눌러도 아무 일이 없다는 게 화면에서 드러나야 한다.
 *   진짜로 동작하는 것은 **방 목록 · 정원 · 방 만들기 · 코드 입장** 넷뿐이다.
 *
 * ★ 시안의 "5명 중 AI 1명" · "AI 2명" 같은 모드 설명은 그대로 옮기지 않았다.
 *   정원은 방마다 2~8이고(UI 표기) 서버가 받는 값은 capacity 하나뿐이다.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./lobby.module.css";
import { recentGames } from "./mock-lobby";

/**
 * 정원 범위. lib/server/room.ts 의 MIN/MAX/DEFAULT_ROOM_CAPACITY 와 같은 값이어야 한다.
 * 그 모듈은 service role 키를 쥐고 있어 클라이언트 번들에 넣을 수 없어서 여기 다시 적는다.
 * 어긋나도 서버가 400으로 막지만, 그러면 고를 수 없는 칸이 화면에 생긴다 (SPEC §17.6).
 *
 * ⚠️ 임시 불일치(2026-07): CEO 결정으로 UI 표기만 하한 2로 먼저 내렸다. 서버·DB 하한은
 *    아직 3이라 **2로 방을 만들면 POST /api/room 이 400으로 거절한다.** 백엔드(§17.6 규칙·
 *    스파이 배정)는 다음에 논의해 맞춘다. 그때 lib/server/room.ts 의 MIN 도 2로 내린다.
 */
const MIN_CAPACITY = 2;
const MAX_CAPACITY = 8;
const DEFAULT_CAPACITY = 5;

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

export function Lobby() {
  const router = useRouter();

  /** null이면 아직 한 번도 못 읽은 상태다. 빈 배열(방이 없다)과 구분해야 한다. */
  const [rooms, setRooms] = useState<OpenRoom[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const [tab, setTab] = useState<"list" | "create">("list");
  const [query, setQuery] = useState("");
  const [capacity, setCapacity] = useState(DEFAULT_CAPACITY);
  const [codeOpen, setCodeOpen] = useState(false);
  const [code, setCode] = useState("");

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

  const createRoom = useCallback(async (): Promise<void> => {
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
      router.push(`/room/${room.code}`);
    } catch {
      setCreateError("서버에 연결하지 못했다");
    } finally {
      setBusy(false);
    }
  }, [capacity, router]);

  /**
   * 코드로 입장. 목록의 줄도 이 길을 쓴다 — /room/{code}로 그냥 이동하면 자리가
   * 배정되지 않아 "이 방의 참가자가 아니다" 화면을 보게 된다.
   * 이미 그 방에 있으면 서버가 원래 자리를 그대로 돌려준다(rejoined).
   */
  const enterRoom = useCallback(
    async (raw: string): Promise<void> => {
      const normalized = raw.trim().toUpperCase();
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
        setCodeOpen(false);
        router.push(`/room/${normalized}`);
      } catch {
        setJoinError("서버에 연결하지 못했다");
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  const visible = useMemo(
    () => (rooms ?? []).filter((room) => room.code.includes(query)),
    [rooms, query],
  );

  return (
    <div className={`${styles.root} flex h-screen flex-col overflow-hidden`}>
      <div aria-hidden className={styles.backdrop} />
      <div aria-hidden className={styles.noise} />
      <div aria-hidden className={styles.scanlines} />

      <TopBar />

      <div className="flex flex-1 overflow-hidden">
        <PlayerSidebar />

        <main className={`${styles.scroll} flex flex-1 flex-col overflow-y-auto`}>
          {/* ── 탭 머리 ─────────────────────────────────────────────── */}
          <div
            className="shrink-0 border-b px-5 pt-5 sm:px-8"
            style={{ borderColor: "var(--border)" }}
          >
            <div className="flex items-center justify-between pb-1">
              <div className="flex gap-8">
                <button
                  type="button"
                  className={`${styles.tab} ${tab === "list" ? styles.tabOn : ""}`}
                  onClick={() => setTab("list")}
                >
                  방 목록
                </button>
                <button
                  type="button"
                  className={`${styles.tab} ${tab === "create" ? styles.tabOn : ""}`}
                  onClick={() => setTab("create")}
                >
                  방 만들기
                </button>
              </div>
              <button
                type="button"
                className={styles.btnAccent}
                style={{ fontSize: "0.68rem", padding: "0.55rem 1.4rem" }}
                disabled={busy}
                onClick={() => setTab("create")}
              >
                <PlusIcon /> 방 만들기
              </button>
            </div>
          </div>

          {tab === "list" ? (
            <RoomListPanel
              rooms={rooms}
              visible={visible}
              query={query}
              busy={busy}
              listError={listError}
              joinError={joinError}
              // 상태에 이미 정규화된 값만 담는다. 화면에 보이는 값과 거르는 값이 같아야 한다.
              onQueryChange={(value) => setQuery(value.replace(/\s/g, "").toUpperCase())}
              onRetry={() => void loadRooms()}
              onEnter={(c) => void enterRoom(c)}
              onOpenCode={() => {
                setJoinError(null);
                setCodeOpen(true);
              }}
            />
          ) : (
            <CreatePanel
              capacity={capacity}
              busy={busy}
              error={createError}
              onCapacity={setCapacity}
              onSubmit={() => void createRoom()}
            />
          )}
        </main>
      </div>

      {codeOpen && (
        <CodeDialog
          code={code}
          busy={busy}
          error={joinError}
          onCode={setCode}
          onClose={() => setCodeOpen(false)}
          onSubmit={() => void enterRoom(code)}
        />
      )}
    </div>
  );
}

/* ─────────────────────────────── 머리말 ─────────────────────────────── */

function TopBar() {
  return (
    <header
      className="flex h-12 shrink-0 items-center justify-between border-b px-4 sm:px-8"
      style={{ background: "var(--bg)", borderColor: "var(--border)" }}
    >
      <div className="flex items-center gap-6 sm:gap-10">
        <Link
          href="/intro"
          className="text-[0.9rem] font-bold uppercase tracking-[0.15em] no-underline"
          style={{ color: "var(--text)" }}
        >
          Who is AI?
        </Link>
        <div className="hidden gap-8 sm:flex">
          <span
            className="border-b pb-0.5 text-[0.66rem] uppercase tracking-[0.18em]"
            style={{ color: "var(--accent)", borderColor: "var(--accent)" }}
          >
            게임 로비
          </span>
          <span className="flex items-center gap-2">
            <span className="text-[0.66rem] uppercase tracking-[0.18em]" style={{ color: "var(--dim)" }}>
              기록
            </span>
            <span className={styles.mock}>mock</span>
          </span>
        </div>
      </div>

      <div className="flex items-center gap-4 sm:gap-6">
        {/* 접속자 수를 세는 곳이 아직 없다. 자리만 남기고 값은 비운다 */}
        <span className="hidden items-center gap-2 md:flex">
          <span className={`${styles.dot} ${styles.dotGreen}`} />
          <span
            className="text-[0.79rem] uppercase tracking-[0.22em]"
            style={{ color: "var(--accent)" }}
          >
            online
          </span>
          <span className={styles.mock}>mock</span>
        </span>
        <span className="h-4 w-px" style={{ background: "var(--border2)" }} />
        <div className="flex items-center gap-2">
          <Avatar name="Player_K" size={26} />
          <span className="text-[0.79rem] font-semibold uppercase tracking-[0.1em]">Player_K</span>
          <span className={styles.mock}>mock</span>
        </div>
      </div>
    </header>
  );
}

/* ───────────────────────────── 왼쪽 기둥 ───────────────────────────── */

function PlayerSidebar() {
  return (
    <aside
      className={`${styles.scroll} hidden w-[220px] shrink-0 flex-col overflow-y-auto border-r lg:flex`}
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
    >
      <div className="border-b p-5" style={{ borderColor: "var(--border)" }}>
        <div className="mb-4 flex items-center gap-3">
          <Avatar name="Player_K" size={34} />
          <div>
            <div className="text-[0.81rem] font-semibold uppercase tracking-[0.08em]">Player_K</div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className="text-[0.66rem]" style={{ color: "var(--muted)" }}>
                LV 24
              </span>
              <span className={styles.mock}>mock</span>
            </div>
          </div>
        </div>

        <div className="mb-1 flex justify-between">
          <span className={styles.label}>exp</span>
          <span className={`${styles.mono} text-[0.77rem]`} style={{ color: "var(--muted)" }}>
            75%
          </span>
        </div>
        <div className="mb-4 h-0.5" style={{ background: "var(--border2)" }}>
          <div
            className="h-full"
            style={{ width: "75%", background: "var(--accent)", boxShadow: "0 0 6px var(--accent-glow)" }}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Stat label="승률" value="64%" />
          <Stat label="판수" value="128" />
        </div>
      </div>

      <div className="p-5">
        <div className="mb-3 flex items-center gap-2">
          <span className={styles.label}>최근 게임</span>
          <span className={styles.mock}>mock</span>
        </div>
        <div className="flex flex-col gap-1.5">
          {recentGames.map((game) => (
            <div
              key={game.result}
              className={`${styles.inset} flex items-center justify-between px-3 py-2.5`}
            >
              <div className="flex items-center gap-2.5">
                <span
                  className={`${styles.dot} ${game.win ? styles.dotGreen : styles.dotRed}`}
                />
                <div>
                  <div className="text-[0.77rem]">{game.result}</div>
                  <div className="mt-0.5 text-[0.59rem]" style={{ color: "var(--muted)" }}>
                    {game.time}
                  </div>
                </div>
              </div>
              <span
                className={`${styles.mono} text-[0.79rem] font-bold`}
                style={{ color: game.win ? "var(--accent)" : "var(--red)" }}
              >
                {game.score}
              </span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={`${styles.inset} px-3 py-2.5`}>
      <div className={`${styles.label} mb-1`}>{label}</div>
      <div className={`${styles.mono} text-[1.1rem] font-bold tracking-tight`}>{value}</div>
    </div>
  );
}

/* ───────────────────────────── 방 목록 ───────────────────────────── */

function RoomListPanel({
  rooms,
  visible,
  query,
  busy,
  listError,
  joinError,
  onQueryChange,
  onRetry,
  onEnter,
  onOpenCode,
}: {
  rooms: OpenRoom[] | null;
  visible: OpenRoom[];
  query: string;
  busy: boolean;
  listError: string | null;
  joinError: string | null;
  onQueryChange: (value: string) => void;
  onRetry: () => void;
  onEnter: (code: string) => void;
  onOpenCode: () => void;
}) {
  const loading = rooms === null;

  return (
    <div className="flex-1 px-5 py-6 sm:px-8">
      {/* ── 거르개 ─────────────────────────────────────────────────── */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="relative max-w-[260px] flex-1">
          <span
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
            style={{ color: "var(--muted)" }}
          >
            <SearchIcon />
          </span>
          <input
            className={`${styles.field} ${styles.mono}`}
            type="text"
            value={query}
            // 코드는 대문자 4자다. maxLength는 걸지 않는다 — 이 칸은 검색도 겸한다.
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="방 코드"
            aria-label="방 코드 검색"
            style={{ paddingLeft: "2.2rem", fontSize: "0.81rem" }}
          />
        </div>

        {/* 모드·정렬은 서버에 그런 값이 없다. 자리만 남긴다 */}
        <span className="flex items-center gap-2">
          <select className={styles.select} disabled style={{ width: "auto", fontSize: "0.77rem", padding: "0.5rem 0.8rem" }}>
            <option>모든 모드</option>
          </select>
          <span className={styles.mock}>mock</span>
        </span>

        <button type="button" className={styles.btnGhost} onClick={onOpenCode} disabled={busy}>
          <LockIcon /> 코드로 입장
        </button>

        <div className="ml-auto flex items-center gap-2">
          <span className={`${styles.dot} ${styles.dotGreen}`} />
          <span
            className="text-[0.79rem] uppercase tracking-[0.2em]"
            style={{ color: "var(--muted)" }}
          >
            {loading ? "불러오는 중" : `${visible.length}개 방 열림`}
          </span>
        </div>
      </div>

      {listError && (
        <div
          className="mb-4 flex flex-wrap items-center justify-between gap-3 px-4 py-3"
          style={{ border: "1px solid rgba(255,59,48,0.3)", background: "var(--red-dim)" }}
        >
          <p className="text-[0.81rem]" style={{ color: "var(--red)" }}>
            {listError}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="text-[0.77rem] uppercase tracking-[0.2em] underline-offset-4 hover:underline"
            style={{ color: "var(--red)" }}
          >
            다시 시도
          </button>
        </div>
      )}

      {joinError && (
        <div
          role="alert"
          className="mb-4 px-4 py-3 text-[0.81rem]"
          style={{ border: "1px solid rgba(255,59,48,0.3)", background: "var(--red-dim)", color: "var(--red)" }}
        >
          {joinError}
        </div>
      )}

      {/* ── 목록 머리 ──────────────────────────────────────────────── */}
      <div
        className={`${styles.roomRow} border-x-0 border-t-0`}
        style={{ background: "transparent", padding: "0.5rem 1.2rem" }}
      >
        <div className={styles.label}>방 코드</div>
        <div className={styles.label}>모드</div>
        <div className={styles.label}>인원</div>
        <div className={styles.label}>열린 시각</div>
        <div />
      </div>

      <div className="mt-1 flex flex-col gap-1">
        {loading ? (
          [0, 1, 2].map((i) => <RoomRowSkeleton key={i} />)
        ) : visible.length === 0 ? (
          <div
            className="flex flex-col items-center gap-3 border border-dashed px-6 py-14 text-center"
            style={{ borderColor: "var(--border2)" }}
          >
            <p className="text-[0.88rem]" style={{ color: "var(--muted)" }}>
              {query ? "그 코드로 열린 방이 없다" : "지금 열린 방이 없다"}
            </p>
            <p className="text-[0.74rem]" style={{ color: "var(--dim)" }}>
              위의 &lsquo;방 만들기&rsquo;로 첫 방을 열 수 있다
            </p>
          </div>
        ) : (
          visible.map((room) => (
            <RoomRow key={room.code} room={room} busy={busy} onEnter={onEnter} />
          ))
        )}
      </div>
    </div>
  );
}

function RoomRow({
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
    <div className={`${styles.roomRow} ${full ? styles.roomFull : ""}`}>
      <div className="min-w-0">
        <div className={`${styles.mono} truncate text-[1.07rem] font-bold tracking-[0.22em]`}>
          {room.code}
        </div>
      </div>

      {/* 모드는 서버에 없는 값이다. 전부 같은 방식으로 돈다 */}
      <div>
        <span className={styles.tag}>표준</span>
      </div>

      <div className="flex items-center gap-2">
        <span className={`${styles.dot} ${full ? styles.dotRed : styles.dotGreen}`} />
        <span className={`${styles.mono} text-[0.85rem]`}>
          {room.players}/{room.capacity}
        </span>
      </div>

      <div className={`${styles.mono} text-[0.81rem]`} style={{ color: "var(--muted)" }}>
        {timeAgo(room.created_at)}
      </div>

      <div className="flex justify-end">
        {/*
          정원이 차도 버튼을 막지 않는다. 그 방에 이미 앉아 있던 사람은 여기로 다시
          들어가야 하고, 서버가 원래 자리를 돌려준다(rejoined). 새 사람이 누르면
          409가 오고 그 문구가 위에 뜬다.
        */}
        <button
          type="button"
          disabled={busy}
          onClick={() => onEnter(room.code)}
          className={full ? styles.btnQuiet : styles.btnSm}
        >
          {full ? "다시 입장" : "입장하기"}
        </button>
      </div>
    </div>
  );
}

function RoomRowSkeleton() {
  return (
    <div aria-hidden className={`${styles.roomRow} animate-pulse`}>
      <div className="h-4 w-24" style={{ background: "var(--surface3)" }} />
      <div className="h-3 w-12" style={{ background: "var(--surface3)" }} />
      <div className="h-3 w-10" style={{ background: "var(--surface3)" }} />
      <div className="h-3 w-12" style={{ background: "var(--surface3)" }} />
      <div className="h-6 w-full" style={{ background: "var(--surface3)" }} />
    </div>
  );
}

/* ───────────────────────────── 방 만들기 ───────────────────────────── */

/**
 * 시안의 방 만들기 콘솔을 그대로 살렸다. 모드·공개 설정·라운드 시간·방 이름은
 * 화면 안에서 진짜로 반응한다(클라이언트 상태) — 시안처럼 "만져지는" 느낌을 준다.
 *
 * ★ 다만 서버가 실제로 받는 값은 capacity 하나뿐이다 (POST /api/room, §17.6).
 *   나머지는 아직 저장할 곳이 없어 **화면 미리보기**다. 그래서 하단에 그 사실을
 *   한 줄로 정직하게 남긴다 — 동작하지 않는 걸 동작하는 척 두는 게 제일 나쁘다.
 *   정원 하한은 UI 표기 기준 2다 (MIN_CAPACITY). 서버 하한은 아직 3이라 2는 임시로
 *   거절되니, 백엔드가 맞춰질 때까지 유의한다.
 */

type Mode = "std" | "spd" | "hrd";

const MODE_TABS: { key: Mode; label: string; desc: string }[] = [
  {
    key: "std",
    label: "표준",
    desc: "기본 진행. 공통 질문 2라운드 → 지목 질문 → 자유 채팅 → 투표 순으로 흐른다.",
  },
  { key: "spd", label: "스피드", desc: "짧게 끊는 진행. 직관과 순발력으로 빠르게 가려낸다." },
  { key: "hrd", label: "하드", desc: "길게 파고드는 진행. 답을 더 촘촘히 검증하는 판이다." },
];

const ROUND_TIMES = [3, 7, 10, 15];

/** 비공개 코드 미리보기용. 표시만 하는 값이라 UI 랜덤을 써도 규칙에 걸리지 않는다 (lib/game 밖) */
function randomCode(): string {
  const pool = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i += 1) out += pool[Math.floor(Math.random() * pool.length)];
  return out;
}

function CreatePanel({
  capacity,
  busy,
  error,
  onCapacity,
  onSubmit,
}: {
  capacity: number;
  busy: boolean;
  error: string | null;
  onCapacity: (n: number) => void;
  onSubmit: () => void;
}) {
  // 아래 넷은 전부 화면 안에서만 사는 값이다 (서버로 가지 않는다)
  const [name, setName] = useState("");
  const [mode, setMode] = useState<Mode>("std");
  const [isPrivate, setIsPrivate] = useState(false);
  const [entryCode, setEntryCode] = useState("");
  const [roundTime, setRoundTime] = useState(7);

  const modeDesc = MODE_TABS.find((m) => m.key === mode)?.desc ?? "";

  return (
    /*
      ★ 폭을 제한하지 않는다. 예전에는 max-w-860 이라 넓은 화면에서 오른쪽이 통째로
        비었다. 두 열이 화면 끝까지 차고, 만들기 버튼은 아래에 붙은 띠로 내려간다 —
        그래야 "설정판 + 실행 바"로 읽히고 빈 구석이 남지 않는다.
    */
    <div className="flex flex-1 flex-col">
      <div className="flex-1 px-5 py-6 sm:px-8">
        {/* items-stretch(기본) — 두 열이 같은 높이로 끝난다. 한쪽만 짧으면 그 아래가 빈다 */}
        <div className="grid gap-5 xl:grid-cols-2">
          {/* ── 왼쪽 ─────────────────────────────────────────────── */}
          <div className="flex h-full flex-col gap-5">
            <div className={`${styles.panel} p-5`}>
              <div className={`${styles.label} mb-3`}>방 이름</div>
              <input
                className={styles.field}
                type="text"
                value={name}
                maxLength={20}
                placeholder="방 이름"
                onChange={(e) => setName(e.target.value)}
              />
              <div className="mt-1.5 text-right">
                <span className={styles.label}>{name.length} / 20</span>
              </div>
            </div>

            <div className={`${styles.panel} p-5`}>
              <div className={`${styles.label} mb-3`}>게임 모드</div>
              <div className="flex gap-2.5">
                {MODE_TABS.map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    className={`${styles.tog} ${mode === m.key ? styles.togOn : ""}`}
                    aria-pressed={mode === m.key}
                    onClick={() => setMode(m.key)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <div className={`${styles.inset} mt-3 px-3 py-3`}>
                <p className="text-[0.77rem] font-light leading-[1.8]" style={{ color: "var(--muted)" }}>
                  {modeDesc}
                </p>
              </div>
            </div>

            {/* 왼쪽 열의 마지막 카드가 남은 높이를 먹는다 — 오른쪽 슬롯 카드와 짝이다 */}
            <div className={`${styles.panel} flex flex-1 flex-col p-5`}>
              <div className={`${styles.label} mb-3`}>공개 설정</div>
              <div className="flex gap-2.5">
                <button
                  type="button"
                  className={`${styles.tog} ${!isPrivate ? styles.togOn : ""}`}
                  aria-pressed={!isPrivate}
                  onClick={() => setIsPrivate(false)}
                >
                  공개
                </button>
                <button
                  type="button"
                  className={`${styles.tog} ${isPrivate ? styles.togOn : ""}`}
                  aria-pressed={isPrivate}
                  onClick={() => setIsPrivate(true)}
                >
                  비공개
                </button>
              </div>

              {isPrivate ? (
                <div className="mt-4">
                  <div className={`${styles.label} mb-1.5`}>입장 코드</div>
                  <div className="flex">
                    <input
                      className={`${styles.field} ${styles.mono}`}
                      type="text"
                      value={entryCode}
                      maxLength={8}
                      placeholder="코드"
                      onChange={(e) =>
                        setEntryCode(e.target.value.replace(/\s/g, "").toUpperCase().slice(0, 8))
                      }
                      style={{ flex: 1, letterSpacing: "0.2em" }}
                    />
                    <button
                      type="button"
                      onClick={() => setEntryCode(randomCode())}
                      className="shrink-0 cursor-pointer border px-4 text-[0.79rem] uppercase tracking-[0.15em]"
                      style={{
                        background: "var(--surface3)",
                        borderColor: "var(--border2)",
                        borderLeft: "none",
                        color: "var(--muted)",
                      }}
                    >
                      랜덤
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {/* ── 오른쪽 ───────────────────────────────────────────── */}
          <div className="flex h-full flex-col gap-5">
            <div className={`${styles.panel} p-5`}>
              <div className="mb-3 flex items-baseline justify-between">
                <span className={styles.label}>참가 인원</span>
                <span className={styles.mono}>
                  <span className="text-[1.5rem] font-bold tracking-tight">{capacity}</span>
                  <span className="ml-1 text-[0.8rem]" style={{ color: "var(--muted)" }}>
                    명
                  </span>
                </span>
              </div>
              {/* 여기만 진짜다. POST /api/room 이 받는 유일한 값 (§17.6) */}
              <input
                className={styles.range}
                type="range"
                min={MIN_CAPACITY}
                max={MAX_CAPACITY}
                value={capacity}
                disabled={busy}
                aria-label="참가 인원"
                onChange={(e) => onCapacity(Number(e.target.value))}
              />
              <div className="mt-2 flex justify-between">
                <span className={styles.label}>{MIN_CAPACITY}명</span>
                <span className={styles.label}>{MAX_CAPACITY}명</span>
              </div>
            </div>

            <div className={`${styles.panel} p-5`}>
              <div className={`${styles.label} mb-3`}>라운드 시간</div>
              <div className="flex gap-2.5">
                {ROUND_TIMES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`${styles.tog} ${t === roundTime ? styles.togOn : ""}`}
                    aria-pressed={t === roundTime}
                    onClick={() => setRoundTime(t)}
                  >
                    {t}분
                  </button>
                ))}
              </div>
            </div>

            {/* 슬롯 카드가 남은 높이를 먹는다 — 오른쪽 열이 아래 띠까지 닿는다 */}
            <div className={`${styles.panel} flex flex-1 flex-col p-5`}>
              <div className="mb-3 flex items-center justify-between">
                <span className={styles.label}>참가자 슬롯</span>
                <span className={`${styles.tag} ${styles.mono}`}>
                  {capacity}/{MAX_CAPACITY}
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                <div className={styles.slotHost}>
                  <Avatar name="Player_K" size={26} accent />
                  <span className="flex-1 text-[0.79rem] font-medium">Player_K</span>
                  <span className={`${styles.tag} ${styles.tagGreen}`}>host</span>
                </div>
                {Array.from({ length: capacity - 1 }, (_, i) => (
                  <div key={i} className={styles.slotEmpty}>
                    <span className={styles.slotDot}>+</span>
                    <span className="text-[0.74rem] tracking-[0.08em]" style={{ color: "var(--dim)" }}>
                      대기 중...
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {error && (
          <p
            role="alert"
            className="mt-5 px-4 py-3 text-[0.81rem]"
            style={{ border: "1px solid rgba(255,59,48,0.3)", background: "var(--red-dim)", color: "var(--red)" }}
          >
            {error}
          </p>
        )}
      </div>

      {/*
        실행 띠. 스크롤해도 바닥에 붙어 있어야 "지금 이 설정으로 연다"가 항상 손에 닿는다.
        패널 안이 아니라 패널 폭 전체를 쓴다 — 시안의 바닥 바와 같은 자리다.
      */}
      <div
        className="sticky bottom-0 border-t px-5 py-4 sm:px-8"
        style={{ borderColor: "var(--border)", background: "var(--bg2)" }}
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          {/*
            자리·정체 이야기는 여기서 길게 하지 않는다. /intro 와 방 안의 「방 규칙」이
            같은 말을 더 정확하게 한다 — 세 군데로 갈리면 문구가 서로 어긋난다.
            둘째 줄은 정직성 표시다 — 위 콘솔에서 지금 방에 실제로 반영되는 값은 인원뿐이다.
          */}
          <p className="text-[0.77rem] font-light leading-[1.9]" style={{ color: "var(--muted)" }}>
            역할은 시작할 때 무작위로 배정된다. 누가 AI인지는 아무도 알 수 없다.
            <br />
            <span style={{ color: "var(--dim)" }}>
              이름·모드·시간·공개 설정은 미리보기다 — 지금 방에 반영되는 값은 인원뿐이다.
            </span>
          </p>
          <button
            type="button"
            className={styles.btnAccent}
            style={{ padding: "0.9rem 2.8rem", fontSize: "0.79rem" }}
            disabled={busy}
            onClick={onSubmit}
          >
            {busy ? "여는 중…" : `${capacity}자리로 연다`} <ArrowIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────────── 코드 입장 ───────────────────────────── */

function CodeDialog({
  code,
  busy,
  error,
  onCode,
  onClose,
  onSubmit,
}: {
  code: string;
  busy: boolean;
  error: string | null;
  onCode: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 들어가는 중에 닫으면 자리는 배정됐는데 화면은 안 넘어간다.
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="code-dialog-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className={styles.modal}>
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <div className={`${styles.label} mb-2`}>방 코드</div>
            <h3 id="code-dialog-title" className="text-[1.1rem] font-bold tracking-tight">
              코드로 입장
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="cursor-pointer border-none bg-transparent"
            style={{ color: "var(--muted)" }}
          >
            <CloseIcon />
          </button>
        </div>

        <input
          className={`${styles.field} ${styles.mono}`}
          type="text"
          value={code}
          // 코드는 대문자 4자다 (SPEC §13-1). 화면에 보이는 값과 보내는 값을 같게 둔다.
          onChange={(e) => onCode(e.target.value.replace(/\s/g, "").toUpperCase().slice(0, 4))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy && code.length === 4) onSubmit();
          }}
          placeholder="CODE"
          aria-label="방 코드"
          autoFocus
          style={{ letterSpacing: "0.3em", fontSize: "1.02rem", marginBottom: "1rem" }}
        />

        {error && (
          <p role="alert" className="mb-3 text-[0.79rem]" style={{ color: "var(--red)" }}>
            {error}
          </p>
        )}

        <button
          type="button"
          className={styles.btnAccent}
          style={{ width: "100%", padding: "0.85rem" }}
          disabled={busy || code.length !== 4}
          onClick={onSubmit}
        >
          {busy ? "들어가는 중…" : "입장하기"} <ArrowIcon />
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────────── 공통 ─────────────────────────────── */

/** 이니셜 아바타. 외부 이미지 호스트에 의존하지 않는다 (시안은 원격 URL을 썼다) */
function Avatar({ name, size, accent = false }: { name: string; size: number; accent?: boolean }) {
  return (
    <span
      aria-hidden
      className={styles.avatar}
      style={{
        width: size,
        height: size,
        borderColor: accent ? "rgba(53,208,127,0.4)" : undefined,
        color: accent ? "var(--accent)" : undefined,
      }}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

/* 아이콘 — font-awesome CDN 대신 인라인 SVG */
function SearchIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
      <circle cx="5" cy="5" r="3.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M7.8 7.8L11 11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden>
      <path d="M5 0v10M0 5h10" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="10" height="11" viewBox="0 0 10 11" fill="none" aria-hidden>
      <rect x="0.6" y="4.6" width="8.8" height="6" stroke="currentColor" strokeWidth="1.1" />
      <path d="M2.6 4.5V3a2.4 2.4 0 014.8 0v1.5" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="11" height="9" viewBox="0 0 11 9" fill="none" aria-hidden>
      <path
        d="M0 4.5h9.5M6.5 1l3.2 3.5L6.5 8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
