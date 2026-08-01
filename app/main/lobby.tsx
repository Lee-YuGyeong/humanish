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
 *   모드 · 라운드 시간 · 비공개 코드 · 검색 필터)는 지우지 않고 남겼다.
 *   레이아웃이 완성됐을 때의 모습을 잃지 않기 위해서다. 눌러도 아무 일이 없는 칸은
 *   disabled 로 둔다 — 화면에 붙여뒀던 MOCK 배지는 뗐다.
 *   진짜로 동작하는 것은 **방 목록 · 정원 · 방 만들기 · 코드 입장** 넷뿐이다.
 *
 * ★ 시안의 "5명 중 AI 1명" · "AI 2명" 같은 모드 설명은 그대로 옮기지 않았다.
 *   정원은 방마다 2~8이고(UI 표기) 서버가 받는 값은 capacity 하나뿐이다.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Phase } from "@/lib/game/types";
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

/**
 * 방 제목 길이 상한. lib/server/room.ts 의 MAX_ROOM_NAME_LEN 과 같아야 한다.
 * 정원과 같은 이유로 여기 다시 적는다 — 그 모듈은 service role 키를 쥐고 있어
 * 클라이언트 번들에 넣을 수 없다.
 *
 * 어긋나도 서버가 400으로 막는다. 다만 그때는 화면이 다 쳐 놓고 나서야 거절당한다.
 */
const MAX_ROOM_NAME_LEN = 20;

/** 목록 폴링 간격. 로비는 Realtime을 붙이지 않았다 — 방 하나가 아니라 방 목록이라 I10의 방 필터를 걸 수 없다. */
const POLL_MS = 3000;

/** GET /api/room 의 한 줄. room_id는 내려오지 않는다 (lib/server/room.ts의 OpenRoom). */
interface OpenRoom {
  code: string;
  /** 방 제목. 없으면 null — 그때는 코드로 대신 부른다 (lib/server/room.ts의 OpenRoom). */
  name: string | null;
  capacity: number;
  players: number;
  created_at: string;
  /**
   * 'lobby'면 대기 중, 그 밖은 전부 게임 중.
   *
   * ★ 게임 중인 방의 인원은 **봇까지 포함한 수**라 언제나 정원과 같다. 그래서
   *   "정원 − 인원"으로 봇 수를 역산할 수 없다 (I1). 서버가 그렇게 세어서 준다 —
   *   화면에서 이 숫자를 다시 만지지 않는다 (lib/server/room.ts의 listOpenRooms).
   */
  phase: Phase;
}

/** 목록에서 방을 부르는 이름. 제목이 있으면 제목, 없으면 코드다. */
function roomLabel(room: OpenRoom): string {
  return room.name ?? room.code;
}

/**
 * 방의 모드.
 *
 * ★ **서버에 그런 값이 없다** — rooms 에 모드 컬럼이 없어서 지금은 전부 '표준' 하나다.
 *   그래서 「모드」로 정렬해도 눈에 띄게 달라지지 않는다: 비교값이 전부 같고 Array.sort 가
 *   안정 정렬이라 들어온 순서가 그대로 남는다. 정렬 자체는 제대로 걸려 있어서,
 *   컬럼이 생기는 날 **여기 한 줄만** 고치면 목록 표시와 정렬이 같이 살아난다.
 */
function modeOf(_room: OpenRoom): string {
  return "표준";
}

/**
 * 정렬 기준. **목록 머리의 열 이름이 곧 버튼이다** — 따로 「정렬」 드롭다운을 두지 않는다.
 * 고르는 곳과 결과가 보이는 곳이 같은 자리에 있어야 무엇이 걸려 있는지 헷갈리지 않는다.
 *
 * ★ 'order'(열린 순서)에는 버튼이 없다. **아무 열도 안 눌렀을 때의 바탕 순서**다 —
 *   서버가 내려준 그대로이고, 「번호」열은 그 순서를 세어 보여줄 뿐이라 누를 것이 없다.
 * ★ 「상태」에도 버튼이 없다. 아래 sortRooms 가 **어떤 기준에서도 항상** 적용하므로
 *   고를 것이 없다.
 */
type SortKey = "order" | "title" | "mode" | "players";
/** 목록 머리에서 실제로 누를 수 있는 열. 'order'는 버튼이 없어 빠진다. */
type SortableCol = Exclude<SortKey, "order">;
type SortDir = "asc" | "desc";
interface Sort {
  key: SortKey;
  dir: SortDir;
}

/**
 * 그 열을 **처음 눌렀을 때**의 방향. 두 번째부터는 뒤집힌다.
 * 각 열에서 사람이 먼저 보고 싶어 하는 쪽을 기본으로 둔다 — 가나다순, 사람이 많이 모인 방.
 */
const FIRST_DIR: Record<SortableCol, SortDir> = {
  title: "asc",
  mode: "asc",
  players: "desc",
};

/** 아무 열도 안 눌렀을 때. 서버가 준 순서(대기 방 먼저 · 최근 열린 순)를 그대로 쓴다. */
const DEFAULT_SORT: Sort = { key: "order", dir: "desc" };

/**
 * 목록 정렬.
 *
 * ★ **어떤 기준을 고르든 게임 중인 방은 항상 뒤로 간다.** 고른 기준은 그 안에서만
 *   적용된다. 들어갈 수 있는 방이 위에 있어야 목록이 쓸모가 있어서다 — 「인원」을
 *   내림차순으로 걸면 게임 중인(=언제나 꽉 찬) 방이 전부 맨 위로 올라와 목록이 뒤집힌다.
 *   이 갈래는 뒤집기(dir)의 대상이 아니다.
 *
 * 원본을 제자리에서 뒤집지 않는다. rooms는 폴링이 3초마다 갈아끼우는 상태값이라
 * 그 배열을 건드리면 정렬을 바꿀 때마다 순서가 누적된다.
 */
function sortRooms(rooms: OpenRoom[], { key, dir }: Sort): OpenRoom[] {
  const waitingFirst = (r: OpenRoom): number => (r.phase === "lobby" ? 0 : 1);
  const sign = dir === "asc" ? 1 : -1;

  return [...rooms].sort((a, b) => {
    const byStatus = waitingFirst(a) - waitingFirst(b);
    if (byStatus !== 0) return byStatus;

    switch (key) {
      case "title":
        // 한글·영문·숫자가 섞인다. numeric을 켜야 '방 10'이 '방 9' 뒤에 온다.
        return sign * roomLabel(a).localeCompare(roomLabel(b), "ko", { numeric: true });
      case "mode":
        // 지금은 값이 하나뿐이라 늘 0이다 — 그러면 안정 정렬이 앞의 순서를 지킨다 (modeOf).
        return sign * modeOf(a).localeCompare(modeOf(b), "ko");
      case "players":
        return sign * (a.players - b.players);
      default:
        // 바탕 순서 = 열린 순서. created_at은 ISO 문자열이라 사전순 = 시간순이다 (CLAUDE.md).
        return sign * a.created_at.localeCompare(b.created_at);
    }
  });
}

/** 같은 열을 다시 누르면 방향만 뒤집고, 다른 열이면 그 열의 기본 방향으로 간다. */
function nextSort(current: Sort, col: SortableCol): Sort {
  if (current.key !== col) return { key: col, dir: FIRST_DIR[col] };
  return { key: col, dir: current.dir === "asc" ? "desc" : "asc" };
}

/**
 * 검색 비교용으로 문자열을 접는다. 찾는 말과 방 제목에 **똑같이** 걸어야 한다.
 *
 * ┌─ 왜 그냥 includes 가 아닌가 ──────────────────────────────────────────────┐
 * │ 서버가 저장 전에 제목을 다듬는다(lib/server/room.ts 의 normalizeRoomName). │
 * │ 찾는 말은 그 길을 지나지 않으므로, 여기서 **같은 모양으로 맞춰 준 다음에**  │
 * │ 견줘야 눈에 같아 보이는 둘이 실제로 같아진다.                              │
 * │                                                                          │
 * │  · NFC — 이게 한글에서 제일 자주 터진다. 맥에서 복사해 온 '초보'는 자모가  │
 * │    풀린 형태(ㅊ+ㅗ+ㅂ+ㅗ)로 들어오고, 키보드로 친 '초보'는 합쳐진 형태다.  │
 * │    바이트가 달라서 includes 가 조용히 빗나간다 — 실패가 화면에 안 보인다.  │
 * │  · \p{Cf} — 서식문자. 저장된 제목에서는 서버가 이미 털었으므로, 찾는 말에  │
 * │    붙어 오면(역시 붙여넣기) 영영 안 맞는다.                                │
 * │  · 공백 접기 · 소문자 — '초보  방'으로 '초보 방'을, 'ai'로 'AI'를 찾는다.  │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * toLocaleLowerCase 가 아니라 toLowerCase 다. 지역 설정에 따라 결과가 달라지면
 * 같은 방 목록이 사람마다 다르게 걸린다 (터키어의 I → ı).
 */
function foldForSearch(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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

export function Lobby() {
  const router = useRouter();

  /** null이면 아직 한 번도 못 읽은 상태다. 빈 배열(방이 없다)과 구분해야 한다. */
  const [rooms, setRooms] = useState<OpenRoom[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const [tab, setTab] = useState<"list" | "create">("list");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  /**
   * 만들기 화면의 제목 칸에 미리 채워 둘 말. 찾다 못 찾고 그대로 만들러 갈 때만 찬다.
   * CreatePanel 은 목록 화면에서 아예 언마운트되므로 initialName 이 갈 때마다 새로 읽힌다.
   */
  const [seedName, setSeedName] = useState("");
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

  /**
   * @param name 방 제목. 비어 있으면 아예 안 싣는다 — 서버가 이름 없는 방으로 만든다.
   *             길이·정화는 서버가 한다 (lib/server/room.ts의 normalizeRoomName, I9).
   */
  const createRoom = useCallback(async (name: string): Promise<void> => {
    setBusy(true);
    setCreateError(null);
    try {
      const trimmed = name.trim();
      const res = await fetch("/api/room", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(trimmed ? { capacity, name: trimmed } : { capacity }),
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

  /**
   * 제목으로 좁힌다. 코드로는 찾지 않는다 — 코드를 아는 사람은 목록을 훑을 게 아니라
   * 「코드로 입장」으로 바로 건너뛴다. 한 칸이 두 가지 일을 하면 어느 쪽으로도 안 읽힌다.
   *
   * ★ 이름 없는 방은 찾는 말이 있을 때 빠진다. 견줄 제목이 없어서지 코드가 비슷해서
   *   남는 게 아니다 — 코드로 걸리기 시작하면 위의 구분이 다시 무너진다.
   */
  const visible = useMemo(() => {
    const needle = foldForSearch(query);
    const found = !needle
      ? (rooms ?? [])
      : (rooms ?? []).filter((room) => room.name != null && foldForSearch(room.name).includes(needle));
    return sortRooms(found, sort);
  }, [rooms, query, sort]);

  return (
    <div className={`${styles.root} flex h-screen flex-col overflow-hidden`}>
      <div aria-hidden className={styles.backdrop} />
      <div aria-hidden className={styles.noise} />
      <div aria-hidden className={styles.scanlines} />

      <TopBar />

      <div className="flex flex-1 overflow-hidden">
        <PlayerSidebar />

        <main className={`${styles.scroll} flex flex-1 flex-col overflow-y-auto`}>
          {/*
            ── 머리 ────────────────────────────────────────────────────
            탭은 없다. 목록이 기본 화면이라 이름표를 달아 봐야 건너갈 곳 없는 탭
            하나만 남는다. **목록 화면에는 이 띠 자체를 두지 않는다** — 버튼 한 개를
            얹자고 빈 줄을 하나 세우는 꼴이었다. 목록의 도구는 목록이 직접 이고 있다
            (RoomListPanel 의 도구 띠). 여기 남는 건 만들기 화면의 되돌아가는 길뿐이다.
          */}
          {tab === "create" && (
            <div
              className="shrink-0 border-b px-5 pt-5 sm:px-8"
              style={{ borderColor: "var(--border)" }}
            >
              <div className="flex items-center justify-between pb-1">
                {/* 탭이 아니라 되돌아가는 길이다 — 이게 없으면 만들기 화면에 갇힌다 */}
                <button type="button" className={styles.tab} onClick={() => setTab("list")}>
                  ← 방 목록
                </button>
                <span className={`${styles.tab} ${styles.tabOn}`}>방 만들기</span>
              </div>
            </div>
          )}

          {tab === "list" ? (
            <RoomListPanel
              rooms={rooms}
              visible={visible}
              query={query}
              busy={busy}
              listError={listError}
              joinError={joinError}
              // 상태에 이미 정규화된 값만 담는다. 화면에 보이는 값과 거르는 값이 같아야 한다.
              // 친 그대로 담는다. 제목에는 공백도 대소문자도 있어서 여기서 깎으면
              // 띄어쓰기가 들어간 제목을 영영 못 찾는다. 맞추는 일은 foldForSearch 가 한다.
              onQueryChange={setQuery}
              sort={sort}
              onSort={(col) => setSort((cur) => nextSort(cur, col))}
              onRetry={() => void loadRooms()}
              onEnter={(c) => void enterRoom(c)}
              onCreate={(seed) => {
                setSeedName(seed ?? "");
                setTab("create");
              }}
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
              initialName={seedName}
              onCapacity={setCapacity}
              onSubmit={(name) => void createRoom(name)}
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
          <span className="text-[0.66rem] uppercase tracking-[0.18em]" style={{ color: "var(--dim)" }}>
            기록
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
        </span>
        <span className="h-4 w-px" style={{ background: "var(--border2)" }} />
        <div className="flex items-center gap-2">
          <Avatar name="Player_K" size={26} />
          <span className="text-[0.79rem] font-semibold uppercase tracking-[0.1em]">Player_K</span>
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
  sort,
  onQueryChange,
  onSort,
  onRetry,
  onEnter,
  onCreate,
  onOpenCode,
}: {
  rooms: OpenRoom[] | null;
  visible: OpenRoom[];
  query: string;
  busy: boolean;
  listError: string | null;
  joinError: string | null;
  sort: Sort;
  onQueryChange: (value: string) => void;
  onSort: (col: SortableCol) => void;
  onRetry: () => void;
  onEnter: (code: string) => void;
  /** @param seedName 만들기 화면의 제목 칸에 미리 채울 말. 없으면 빈 칸으로 연다. */
  onCreate: (seedName?: string) => void;
  onOpenCode: () => void;
}) {
  const loading = rooms === null;

  return (
    <div className="flex flex-1 flex-col">
      {/*
        ── 도구 띠 ─────────────────────────────────────────────────────
        찾기(왼쪽) · 지금 상태(가운데) · 할 일(오른쪽) 한 줄이다.

        ★ 「코드로 입장」을 검색칸 옆이 아니라 「방 만들기」 옆에 둔다. 둘 다 "방 코드"를
          말하지만 하는 일이 다르다 — 검색칸은 **아래 목록을 좁히고**, 코드로 입장은
          **목록에 없는 방으로 건너뛴다**. 나란히 두면 같은 기능의 두 입구로 읽힌다.
          움직이는 것끼리(입장·만들기) 오른쪽에 모으면 그 오해가 사라진다.
      */}
      <div
        className="shrink-0 border-b px-5 py-4 sm:px-8"
        style={{ borderColor: "var(--border)" }}
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="relative min-w-[160px] flex-1 sm:max-w-[260px]">
            <span
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
              style={{ color: "var(--muted)" }}
            >
              <SearchIcon />
            </span>
            {/*
              styles.mono 를 뗐다. 그건 코드(대문자 4자)를 가지런히 세우려고 붙였던 것이라
              제목처럼 사람이 쓴 말에는 자간만 벌어진다.
            */}
            <input
              className={styles.field}
              type="text"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              // 제목보다 긴 말은 어떤 방에도 안 걸린다. 서버 상한과 같은 자리에서 멈춘다.
              maxLength={MAX_ROOM_NAME_LEN}
              placeholder="방 제목으로 찾기"
              aria-label="방 제목 검색"
              style={{ paddingLeft: "2.2rem", fontSize: "0.81rem" }}
            />
          </div>

          {/*
            방 개수를 세어 보여주던 상태등은 뺐다. 목록이 바로 아래에 있어서 같은 것을
            두 번 말하는 자리였다 — 비었으면 빈 화면이, 불러오는 중이면 뼈대 줄이
            이미 그 말을 한다.
          */}

          {/* 정렬은 아래 목록 머리의 열 이름을 눌러서 한다 (SortHeader). 여기 따로 두지 않는다 */}

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              className={styles.btnGhost}
              style={{ padding: "0.6rem 1.2rem" }}
              onClick={onOpenCode}
              disabled={busy}
            >
              <LockIcon /> 코드로 입장
            </button>
            <button
              type="button"
              className={styles.btnAccent}
              style={{ padding: "0.6rem 1.4rem" }}
              // ★ onClick={onCreate} 로 넘기지 않는다 — 클릭 이벤트가 seedName 자리로 들어간다.
              //   빈 칸으로 여는 게 맞는 자리다. 찾던 말을 이어받는 건 아래 빈 화면의 버튼뿐이다.
              onClick={() => onCreate()}
              disabled={busy}
            >
              <PlusIcon /> 방 만들기
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 px-5 py-6 sm:px-8">
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
              className="text-[0.77rem] tracking-[0.02em] underline-offset-4 hover:underline"
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
          {/* 번호·상태는 누를 것이 없다 — 이유는 SortKey 주석에 있다 */}
          <div className={styles.label}>번호</div>
          {/* 이름 없는 방만 코드가 이 칸을 물려받는다 (RoomRow) */}
          <SortHeader label="제목" col="title" sort={sort} onSort={onSort} />
          <SortHeader label="모드" col="mode" sort={sort} onSort={onSort} />
          <div className={styles.label}>상태</div>
          <SortHeader label="인원" col="players" sort={sort} onSort={onSort} />
        </div>

        <div className="mt-1 flex flex-col gap-1">
          {loading ? (
            [0, 1, 2].map((i) => <RoomRowSkeleton key={i} />)
          ) : visible.length === 0 ? (
            <div
              className="flex flex-col items-center gap-4 border border-dashed px-6 py-14 text-center"
              style={{ borderColor: "var(--border2)" }}
            >
              <p className="text-[0.88rem]" style={{ color: "var(--muted)" }}>
                {query.trim() ? "그 제목으로 열린 방이 없다" : "지금 열린 방이 없다"}
              </p>
              {/*
                "위의 방 만들기로" 라고 손가락질하는 대신 여기서 바로 열게 한다.

                ★ 찾다 못 찾았을 때도 버튼을 낸다. 코드로 찾던 시절에는 없는 코드를 친
                  사람이 방을 새로 만들 리 없어서 감췄지만, 제목은 다르다 — '초보'를
                  찾아 아무것도 없으면 그 방을 만들고 싶은 게 자연스러운 다음 수다.
                  코드를 쥐고 있던 사람을 위한 길은 아래 줄에 따로 남긴다.
              */}
              <button
                type="button"
                className={styles.btnAccent}
                style={{ padding: "0.6rem 1.6rem" }}
                onClick={() => onCreate(query.trim())}
                disabled={busy}
              >
                <PlusIcon /> {query.trim() ? "이 이름으로 방 만들기" : "첫 방 만들기"}
              </button>
              {query.trim() && (
                <p className="text-[0.74rem]" style={{ color: "var(--dim)" }}>
                  방 코드를 알고 있으면 &lsquo;코드로 입장&rsquo;을 쓴다 — 제목 검색으로는
                  안 걸린다
                </p>
              )}
            </div>
          ) : (
            visible.map((room, i) => (
              <RoomRow key={room.code} room={room} index={i} busy={busy} onEnter={onEnter} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 목록 머리의 한 칸 — 누르면 그 열로 정렬한다.
 *
 * 지금 걸린 열에는 화살표를 띄우고, 나머지는 이름만 둔다. **화살표 자리는 늘 잡아 둔다** —
 * 걸릴 때만 끼워 넣으면 누를 때마다 열 이름이 옆으로 밀린다.
 *
 * ★ 정렬 상태를 aria-sort 로 말하지 않는다. 그건 진짜 표(role="columnheader")의 속성이라
 *   button 에 붙이면 보조기기가 무시한다. 이 목록은 grid 로 짠 <div>·<button> 더미지
 *   <table> 이 아니다. 그래서 **읽어 줄 문장을 aria-label 에 직접 적는다** — 지금 어떻게
 *   정렬돼 있고 누르면 어떻게 되는지까지. 화살표만으로는 눈으로 보는 사람만 안다.
 */
function SortHeader({
  label,
  col,
  sort,
  onSort,
}: {
  label: string;
  col: SortableCol;
  sort: Sort;
  onSort: (col: SortableCol) => void;
}) {
  const on = sort.key === col;
  const now = on ? (sort.dir === "asc" ? "오름차순" : "내림차순") : null;
  const next = on ? (sort.dir === "asc" ? "내림차순" : "오름차순") : "이 기준";

  return (
    <button
      type="button"
      onClick={() => onSort(col)}
      className={`${styles.sortHead} ${on ? styles.sortHeadOn : ""}`}
      aria-label={
        now ? `${label} ${now} 정렬 중. 누르면 ${next}` : `${label} 기준으로 정렬. 누르면 ${next}으로 정렬`
      }
    >
      <span className={styles.label}>{label}</span>
      <span aria-hidden className={styles.sortMark}>
        {on ? (sort.dir === "asc" ? "▲" : "▼") : ""}
      </span>
    </button>
  );
}

/**
 * 목록의 한 줄.
 *
 * ┌─ 줄 전체가 버튼이다 ──────────────────────────────────────────────────────┐
 * │ 오른쪽 끝의 「입장하기」 버튼은 없앴다. 누를 수 있는 곳이 줄 안의 작은 사각형   │
 * │ 하나뿐이면, 줄을 눌러 본 사람은 아무 일도 일어나지 않는 걸 겪는다.           │
 * │                                                                          │
 * │ ★ div + onClick 이 아니라 **button 이다.** div 는 탭으로 닿지도, 엔터로     │
 * │   눌리지도 않는다. 안에 다른 누를 것이 없어서(버튼을 없앴으므로) button      │
 * │   하나로 감쌀 수 있다 — 버튼 안에 버튼을 넣으면 그건 못 쓰는 마크업이다.     │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * @param index 목록에서 몇 번째인가. 화면에 그대로 「번호」로 나간다 — 방에 붙은
 *              고유 번호가 아니라 **지금 정렬에서의 자리**다. 정렬을 바꾸면 바뀐다.
 */
function RoomRow({
  room,
  index,
  busy,
  onEnter,
}: {
  room: OpenRoom;
  index: number;
  busy: boolean;
  onEnter: (code: string) => void;
}) {
  const playing = room.phase !== "lobby";
  const full = room.players >= room.capacity;

  return (
    /*
      정원이 차도, 게임 중이어도 누르는 걸 막지 않는다. 그 방에 이미 앉아 있던 사람은
      여기로 다시 들어가야 하고, /api/room/join 이 쿠키를 먼저 보고 원래 자리를
      돌려준다(rejoined). 새 사람이 누르면 409가 오고 그 문구가 위에 뜬다.
    */
    <button
      type="button"
      disabled={busy}
      onClick={() => onEnter(room.code)}
      className={`${styles.roomRow} ${playing || full ? styles.roomFull : ""}`}
      aria-label={`${roomLabel(room)} — ${playing ? "게임 중" : "대기 중"}, ${room.players}/${room.capacity}명`}
    >
      {/* 번호. 자리를 세는 값이라 폭이 흔들리면 안 된다 — 등폭 글꼴로 둔다 */}
      <span className={`${styles.mono} text-[0.79rem]`} style={{ color: "var(--dim)" }}>
        {index + 1}
      </span>

      {/*
        제목이 주인공이다. 이름이 없는 방만 코드가 그 자리를 물려받는다 — "(제목 없음)"
        같은 자리표시자는 넣지 않는다. 그건 정보가 아니라 빈칸을 채우는 말이다.

        ★ 제목은 남이 지은 문자열이다. 서버가 보이지 않는 글자를 털어서 주지만
          (normalizeRoomName), 길이는 여기서도 잘라야 한다 — 20자여도 넓은 글자만
          쓰면 한 줄을 넘긴다. truncate 가 그 일을 한다.
      */}
      <span className="min-w-0">
        <span
          className={`block truncate text-left ${
            room.name ? "text-[0.98rem] font-semibold" : `${styles.mono} text-[1.02rem] font-bold tracking-[0.22em]`
          }`}
        >
          {roomLabel(room)}
        </span>
      </span>

      {/* 표시와 정렬이 같은 곳을 본다 — modeOf 하나만 고치면 둘 다 따라온다 */}
      <span>
        <span className={styles.tag}>{modeOf(room)}</span>
      </span>

      {/* 상태. 색만으로 말하지 않는다 — 글자를 같이 적어야 색을 못 가리는 사람도 읽는다 */}
      <span>
        <span className={`${styles.tag} ${playing ? "" : styles.tagGreen}`}>
          {playing ? "게임 중" : "대기중"}
        </span>
      </span>

      <span className="flex items-center gap-2">
        <span className={`${styles.dot} ${full ? styles.dotRed : styles.dotGreen}`} />
        <span className={`${styles.mono} text-[0.85rem]`}>
          {room.players}/{room.capacity}
        </span>
      </span>
    </button>
  );
}

function RoomRowSkeleton() {
  return (
    <div aria-hidden className={`${styles.roomRow} animate-pulse`}>
      <div className="h-3 w-4" style={{ background: "var(--surface3)" }} />
      <div className="h-4 w-32" style={{ background: "var(--surface3)" }} />
      <div className="h-3 w-10" style={{ background: "var(--surface3)" }} />
      <div className="h-3 w-12" style={{ background: "var(--surface3)" }} />
      <div className="h-3 w-10" style={{ background: "var(--surface3)" }} />
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
  initialName,
  onCapacity,
  onSubmit,
}: {
  capacity: number;
  busy: boolean;
  error: string | null;
  /** 목록에서 찾다 못 찾고 넘어왔을 때 그 찾던 말. 없으면 빈 칸으로 연다. */
  initialName: string;
  onCapacity: (n: number) => void;
  /** @param name 방 제목. 비었으면 이름 없는 방이 된다 */
  onSubmit: (name: string) => void;
}) {
  // ★ name 만 서버로 간다. 아래 넷(모드 · 공개 설정 · 입장 코드 · 라운드 시간)은
  //   아직 뒷받침할 데이터가 없어서 화면 안에서만 산다 (파일 머리말의 MOCK 설명).
  const [name, setName] = useState(initialName);
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
                maxLength={MAX_ROOM_NAME_LEN}
                // 라벨이 이미 "방 이름"이라, 여기에는 화면으로 알 수 없는 것만 적는다 —
                // 비워도 되고, 그러면 방이 코드로 불린다는 사실.
                placeholder="비우면 코드로 부른다"
                onChange={(e) => setName(e.target.value)}
              />
              <div className="mt-1.5 text-right">
                <span className={styles.label}>
                  {name.length} / {MAX_ROOM_NAME_LEN}
                </span>
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

            {/* 왼쪽 열의 마지막 카드가 남은 높이를 먹는다 — 두 열이 같은 바닥에서 끝난다 */}
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

            {/* 오른쪽 열의 마지막 카드가 남은 높이를 먹는다 — 열이 아래 띠까지 닿는다 */}
            <div className={`${styles.panel} flex flex-1 flex-col p-5`}>
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

            둘째 줄은 정직성 표시다. **이름이 목록에서 빠졌다** — 이제 진짜로 저장된다.
            여기 목록과 실제 동작이 어긋나면 이 표시 자체가 거짓말이 되므로,
            값을 서버에 잇는 순간 같이 고친다.
          */}
          <p className="text-[0.77rem] font-light leading-[1.9]" style={{ color: "var(--muted)" }}>
            역할은 시작할 때 무작위로 배정된다. 누가 AI인지는 아무도 알 수 없다.
            <br />
            <span style={{ color: "var(--dim)" }}>
              모드·시간·공개 설정은 미리보기다 — 지금 방에 반영되는 값은 이름과 인원이다.
            </span>
          </p>
          <button
            type="button"
            className={styles.btnAccent}
            style={{ padding: "0.9rem 2.8rem", fontSize: "0.79rem" }}
            disabled={busy}
            onClick={() => onSubmit(name)}
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
function Avatar({ name, size }: { name: string; size: number }) {
  return (
    <span aria-hidden className={styles.avatar} style={{ width: size, height: size }}>
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
