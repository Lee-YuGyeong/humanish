"use client";

/**
 * 게임 로비 — 방 목록 · 방 만들기 · 코드로 입장. 소유: C (SPEC §2, §13-1)
 *
 * ┌─ 화면만 갈아입혔다 ────────────────────────────────────────────────────┐
 * │ 서버와 주고받는 부분은 예전 page.tsx 그대로다. 껍데기(창고 케이스 →     │
 * │ 취조실 콘솔)만 바꿨다:                                                  │
 * │   GET  /api/room                 목록. phase='lobby'인 방만 온다        │
 * │   POST /api/room  { name? }      방 만들기. 정원은 **안 보낸다** —      │
 * │   2026-08-06 결정: 모든 방이 사람 8자리 + 시작할 때 AI 1대다.           │
 * │   POST /api/room/join  { code }  입장. 201 신규 · 200 재입장 둘 다 성공  │
 * │ supabase 를 직접 부르지 않는다 (I9). 목록에 room_id 는 오지 않는다 —    │
 * │ 이동도 입장도 code 로 한다. 봇 수·봇 자리를 유추하게 하는 값은 어떤     │
 * │ 형태로도 화면에 올리지 않는다 (I1).                                     │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 시안에 있으나 **뒷받침할 데이터가 없는 자리**(접속자 수 · 라운드 시간 ·
 *   비공개 코드 · 검색 필터)는 지우지 않고 남겼다. **모드는 지웠다** —
 *   2026-08-06 결정: 고를 것이 없는 칸을 화면에 두지 않는다.
 *   레이아웃이 완성됐을 때의 모습을 잃지 않기 위해서다. 눌러도 아무 일이 없는 칸은
 *   disabled 로 둔다 — 화면에 붙여뒀던 MOCK 배지는 뗐다.
 *
 *   **왼쪽 기둥(이름 · 레벨 · EXP · 승률 · 판수 · 최근 게임)은 이제 진짜다.**
 *   GET /api/profile/stats 하나에서 온다 (SPEC §15-2-결정 「아직 안 한 것」).
 *   한 판이 끝날 때 /api/reveal 이 match_results 에 적고, 그걸 다시 읽는 것이다.
 *   **사람이 2명 이상인 방만 적힌다** — 혼자 만든 방은 봇만 있어서 아무나 찍어도
 *   맞기 때문이다. 그래서 판수가 실제로 논 횟수보다 적을 수 있다.
 *
 * ★ 정원을 고르는 칸도 없앴다 (2026-08-06). 모든 방이 같은 판이다 —
 *   사람 8자리, 2명부터 전원 준비되면 시작, 시작하는 순간 AI 1대가 붙는다.
 *   서버가 POST /api/room 에서 받는 값은 이제 이름 하나뿐이다.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccountName, Avatar, TopBar } from "@/components/top-bar";
import { signOut } from "@/lib/auth";
import type { Phase } from "@/lib/game/types";
import { useInvalidateAuthUser, useProfile, useProfileStats } from "@/lib/queries/auth";
import { HistoryPanel } from "./history-panel";
import styles from "./lobby.module.css";

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
 * 정렬 기준. **목록 머리의 열 이름이 곧 버튼이다** — 따로 「정렬」 드롭다운을 두지 않는다.
 * 고르는 곳과 결과가 보이는 곳이 같은 자리에 있어야 무엇이 걸려 있는지 헷갈리지 않는다.
 *
 * ★ 'order'(열린 순서)에는 버튼이 없다. **아무 열도 안 눌렀을 때의 바탕 순서**다 —
 *   서버가 내려준 그대로이고, 「번호」열은 그 순서를 세어 보여줄 뿐이라 누를 것이 없다.
 * ★ 「상태」에도 버튼이 없다. 아래 sortRooms 가 **어떤 기준에서도 항상** 적용하므로
 *   고를 것이 없다.
 */
type SortKey = "order" | "title" | "players";
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

/**
 * 가운데 칸에 무엇이 드는가 (2026-08-07). **화면을 옮기는 게 아니다** — 머리말과
 * 왼쪽 기둥은 그대로 있고 이 칸만 갈아끼운다. 그래서 주소도 안 바뀐다.
 */
type MainTab = "lobby" | "history";

export function Lobby() {
  const router = useRouter();

  const [tab, setTab] = useState<MainTab>("lobby");

  /** null이면 아직 한 번도 못 읽은 상태다. 빈 배열(방이 없다)과 구분해야 한다. */
  const [rooms, setRooms] = useState<OpenRoom[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  /**
   * 만들기 화면의 제목 칸에 미리 채워 둘 말. 찾다 못 찾고 그대로 만들러 갈 때만 찬다.
   * CreatePanel 은 목록 화면에서 아예 언마운트되므로 initialName 이 갈 때마다 새로 읽힌다.
   */
  const [seedName, setSeedName] = useState("");
  /** 방 만들기 팝업. 「코드로 입장」과 같은 모양의 모달이다 (2026-08-06) */
  const [createOpen, setCreateOpen] = useState(false);
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
        // 정원은 안 싣는다 — 서버가 정한다 (2026-08-06). 이름만 있으면 된다.
        body: JSON.stringify(trimmed ? { name: trimmed } : {}),
      });
      if (!res.ok) {
        // 팝업은 열어 둔다. 닫아 버리면 고쳐 칠 이름이 사라진다.
        setCreateError(await errorOf(res, "방을 만들지 못했다"));
        return;
      }
      // 만든 사람은 이미 방장으로 앉아 있다. 토큰은 쿠키로 왔다 (SPEC §17.4).
      // 이름을 지었으면 코드가 그 이름이다 (codeFromName) — 한글이라 인코딩해서 싣는다.
      const { room } = (await res.json()) as { room: { code: string } };
      router.push(`/room/${encodeURIComponent(room.code)}`);
    } catch {
      setCreateError("서버에 연결하지 못했다");
    } finally {
      setBusy(false);
    }
  }, [router]);

  /**
   * 코드로 입장. 목록의 줄도 이 길을 쓴다 — /room/{code}로 그냥 이동하면 자리가
   * 배정되지 않아 "이 방의 참가자가 아니다" 화면을 보게 된다.
   * 이미 그 방에 있으면 서버가 원래 자리를 그대로 돌려준다(rejoined).
   *
   * 도착지는 언제나 대기방(/room/{code})이다 (2026-08-06 결정 — 예전에는 목록
   * 선택이 /world 로 직행했다). 월드로 가는 길은 방장의 「게임 시작」 하나다:
   * world_started_at 이 찍히면 대기방이 전원을 /world 로 보낸다 (room-lobby.tsx).
   * 이미 시작된 방에 들어가도 같은 길이다 — 대기방이 곧장 월드로 넘겨준다.
   */
  const enterRoom = useCallback(
    async (raw: string): Promise<void> => {
      // 코드는 이제 방 이름일 수 있다 (서버 codeFromName 과 같은 모양 — 공백 제거 + 대문자)
      const normalized = raw.replace(/\s+/g, "").toUpperCase();
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
        // 한글 이름 코드가 URL 에 실린다 — 인코딩 없이는 push 가 깨진다
        const encoded = encodeURIComponent(normalized);
        router.push(`/room/${encoded}`);
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

      <LobbyHeader tab={tab} onTab={setTab} />

      <div className="flex flex-1 overflow-hidden">
        <PlayerSidebar onSeeHistory={() => setTab("history")} />

        <main className={`${styles.scroll} flex flex-1 flex-col overflow-y-auto`}>
          {/*
            ── 탭은 화면이 아니라 이 칸이다 (2026-08-07) ────────────────
            「기록」이 예전에는 /account/history 라는 다른 화면이었다. 누르면 로비가
            통째로 사라지고 머리말도 팔레트도 다른 페이지가 떴다가 「← 로비로」로
            되돌아와야 했다. 지금은 여기만 바뀐다 — 머리말·왼쪽 기둥은 그대로다.
          */}
          {/*
            ── 방 목록 쪽은 화면이 하나다 (2026-08-06) ──────────────────
            예전에는 「방 만들기」가 목록을 통째로 갈아치우는 두 번째 화면이었고,
            그 위에 되돌아가는 띠를 따로 세워야 했다. 물어보는 것이 이름 하나로
            줄어든 지금 그건 **한 칸을 받자고 화면을 떠나는 꼴**이다.
            그래서 「코드로 입장」과 같은 모양의 팝업으로 바꿨다 — 둘 다 방으로
            들어가는 짧은 물음이라 같은 모양이어야 헷갈리지 않는다.
          */}
          {tab === "history" ? (
            <HistoryPanel />
          ) : (
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
                setCreateError(null);
                setCreateOpen(true);
              }}
              onOpenCode={() => {
                setJoinError(null);
                setCodeOpen(true);
              }}
            />
          )}
        </main>
      </div>

      {createOpen && (
        <CreateDialog
          busy={busy}
          error={createError}
          initialName={seedName}
          onClose={() => setCreateOpen(false)}
          onSubmit={(name) => void createRoom(name)}
        />
      )}

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

/** 머리말의 탭. 라벨과 순서를 여기 한 곳에만 적는다 */
const TABS: { key: MainTab; label: string }[] = [
  { key: "lobby", label: "게임 로비" },
  { key: "history", label: "기록" },
];

/**
 * 로비의 머리말. **띠 자체는 방 화면과 공용이다** (components/top-bar.tsx) —
 * 여기서 정하는 건 그 안에 무엇이 드는가뿐이다.
 *
 * ★ 탭은 **링크가 아니라 버튼이다** (2026-08-07). 「기록」이 링크였을 때는 누르면
 *   다른 화면(/account/history)으로 떠났다가 「← 로비로」로 돌아와야 했다.
 *   지금은 가운데 칸만 바뀌므로 갈 곳이 없다 — 주소도 그대로다.
 */
function LobbyHeader({ tab, onTab }: { tab: MainTab; onTab: (tab: MainTab) => void }) {
  return (
    <TopBar>
      <div className="flex items-center gap-6 sm:gap-10">
        {/*
          ★ shrink-0 · whitespace-nowrap — 로고는 **어떤 경우에도 안 줄고 안 접힌다.**
            옛 기록 화면은 이 머리말을 .root 밖에서 다시 그렸고, 그러면 서체가
            Space Grotesk 가 아니라 body 의 IBM Plex Sans KR 로 떨어져서 같은
            0.9rem 인데 로고 크기가 바뀐 것처럼 보였다 (2026-08-07 보고).
            그 화면은 없앴고(탭이 가운데 칸만 바꾼다) 머리말은 이제 여기 하나다.
            남은 흔들림 경로는 폭이 모자랄 때의 줄바꿈뿐이라 그것도 여기서 막는다.
        */}
        <Link
          href="/intro"
          className="shrink-0 whitespace-nowrap text-[0.9rem] font-bold uppercase tracking-[0.15em] no-underline"
          style={{ color: "var(--text)" }}
        >
          Who is AI?
        </Link>
        <nav className="hidden gap-8 sm:flex">
          {TABS.map((t) => {
            const on = t.key === tab;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => onTab(t.key)}
                aria-current={on ? "page" : undefined}
                className={`cursor-pointer font-[inherit] text-[0.66rem] uppercase tracking-[0.18em] transition-colors ${
                  on ? "border-b pb-0.5" : "hover:opacity-80"
                }`}
                style={
                  on
                    ? { color: "var(--accent)", borderColor: "var(--accent)" }
                    : { color: "var(--dim)" }
                }
              >
                {t.label}
              </button>
            );
          })}
        </nav>
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
        <AccountChip />
      </div>
    </TopBar>
  );
}

/**
 * 머리말의 계정 자리 (SPEC §15-2-결정).
 *
 * ★ 여기에 "로그인" 버튼이 없는 이유: 이 화면은 RequireLogin 안에 있어서
 *   로그인하지 않은 사람은 애초에 도달하지 못한다 (app/main/page.tsx).
 *   그래서 상태는 둘뿐이다 — 이름이 있거나, 아직 안 지었거나.
 *
 * ★ 여기 뜨는 이름은 계정 이름이다. **게임 화면에는 절대 나오지 않는다** (I1) —
 *   방 안에서는 대기방까지만 쓰이고 시작하면 '익명N' 이 된다.
 *
 * ┌─ 왜 이름이 링크가 아니라 메뉴인가 ─────────────────────────────────────┐
 * │ 전에는 이름을 누르면 /account/nickname 으로 갔다("이름 바꾸기").        │
 * │ **이름은 한 번 짓고 못 바꾸게 됐다** (SPEC §15-2-결정 「이름은 한 번만  │
 * │ 짓는다」). 그 링크는 갈 곳이 없어졌고, 눌러도 그 화면이 바로 되돌려     │
 * │ 보낸다 — 아무 일도 안 일어나는 링크만 남는 셈이었다.                    │
 * │ 그 자리에 로그아웃을 둔다. 앱을 통틀어 나가는 문이 여기 하나뿐이다.     │
 * └────────────────────────────────────────────────────────────────────────┘
 */
function AccountChip() {
  const router = useRouter();
  const { data: profileData } = useProfile();
  const invalidate = useInvalidateAuthUser();
  const mine = profileData?.profile;

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  /*
   * 바깥을 누르거나 Esc 로 닫는다.
   *
   * ★ 나가는 중(busy)에는 닫지 않는다. 닫히면 다시 누를 수 있게 되고, signOut 이
   *   두 번 나간다.
   * ★ mousedown 으로 듣는다. click 이면 메뉴가 사라진 자리에 있던 것이 같이 눌린다.
   */
  useEffect(() => {
    if (!open || busy) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, busy]);

  const logout = async () => {
    setBusy(true);
    try {
      await signOut();
    } catch {
      /*
       * 실패해도 화면은 내보낸다. 여기서 멈추면 로그아웃을 눌렀는데 아무 일도
       * 안 일어난 화면이 되고, 그게 더 나쁘다. 세션이 살아 있으면 /intro 의
       * 「게임 접속하기」가 다시 통과시킬 뿐이라 잃는 것도 없다.
       */
    }
    invalidate();
    // 로그인 화면(/login)이 아니라 입구(/intro)로 보낸다. 나가자마자 다시
    // 로그인 벽을 보여주면 나간 것 같지가 않다.
    router.replace("/intro");
  };

  // 아직 안 왔다. 자리만 잡아둔다 — 글자가 나중에 튀어나오면 머리말이 흔들린다.
  if (!profileData) return <span className="h-[26px]" />;

  /*
   * 연결은 했는데 이름을 안 지었다 (이름 화면에서 나가버린 경우).
   * 여기는 메뉴로 바꾸지 않는다 — 이름을 짓는 것이 급한 일이고, 그걸 메뉴 안으로
   * 한 번 더 숨기면 안 된다. **대신 이 상태에서는 로그아웃할 방법이 없다.**
   */
  if (!mine) {
    return (
      <Link
        href="/account/nickname?next=/main"
        className="text-[0.7rem] uppercase tracking-[0.14em] no-underline"
        style={{ color: "var(--accent)" }}
      >
        이름 정하기
      </Link>
    );
  }

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        className={styles.chip}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {/* 이름 자리는 대기실 머리말과 **같은 부품이다** (components/top-bar.tsx) */}
        <AccountName name={mine.display_name} />
        <CaretIcon />
      </button>

      {open && (
        <div className={styles.menu} role="menu">
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            disabled={busy}
            onClick={() => void logout()}
          >
            {busy ? "나가는 중…" : "로그아웃"}
          </button>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────── 왼쪽 기둥 ───────────────────────────── */

/**
 * 한 판을 뭐라고 부를지 (SPEC §8, §15-2-결정).
 *
 * ★ 시안에는 "인간 승리 / AI 승리(패배)" 라고 적혀 있었지만 **그대로 쓰지 않는다.**
 *   이 게임에는 아직 팀 승패 판정이 없다 (SPEC 「게임 룰 점검 추가분」— /api/reveal 은
 *   점수만 준다). 없는 판정을 화면에서 지어내면 결과 화면과 전적이 서로 다른 말을 한다.
 *
 *   대신 채점 규칙이 이미 말하고 있는 것을 그대로 적는다 (lib/game/rules.ts):
 *     시민은 진짜 AI를 맞히면 +2, 스파이는 사람 표를 한 장이라도 받으면 +4.
 *   즉 **점수가 붙은 판 = 자기 목표를 이룬 판**이고, 그게 won 이다.
 */
const MATCH_LABEL: Record<"citizen" | "spy" | "actor", { won: string; lost: string }> = {
  citizen: { won: "AI 적중", lost: "AI 놓침" },
  // 'spy'(예전 2D 판)와 'actor'(월드 판, §18.2)는 같은 역할의 옛/새 이름이다.
  // 지난 행을 고쳐 쓰지 않아서 둘 다 오고, 화면에서는 같은 문구로 접는다.
  spy: { won: "연기 성공", lost: "연기 실패" },
  actor: { won: "연기 성공", lost: "연기 실패" },
};

/**
 * 얼마 전인지. 서버가 준 ISO 문자열을 그대로 받는다.
 *
 * ★ 표시용이라 클라이언트 시계를 써도 된다 (I2 는 **페이즈 전환 판정**의 규칙이다).
 *   시계가 어긋나 미래로 나오면 '방금' 으로 접는다 — '-3분 전' 은 고장으로 보인다.
 */
function timeAgo(iso: string, now: number): string {
  const min = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(min) || min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간 전`;
  return `${Math.floor(hour / 24)}일 전`;
}

function PlayerSidebar({ onSeeHistory }: { onSeeHistory: () => void }) {
  const { data: profileData } = useProfile();
  const { data: stats } = useProfileStats();

  const profile = profileData?.profile ?? null;
  const name = profile?.display_name ?? "이름 없음";

  /*
   * 마운트할 때 한 번만 읽는다. 렌더마다 Date.now() 를 부르면 같은 목록이
   * 리렌더될 때마다 조금씩 다른 문구가 되어 화면이 흔들린다. 로비에 앉아 있는
   * 동안 '15분 전' 이 '16분 전' 으로 바뀌지 않는 것은 문제가 아니다 —
   * 전적은 게임이 끝날 때만 바뀌고, 그때는 화면이 새로 뜬다.
   */
  const [now] = useState(() => Date.now());

  return (
    <aside
      className={`${styles.scroll} hidden w-[220px] shrink-0 flex-col overflow-y-auto border-r lg:flex`}
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
    >
      <div className="border-b p-5" style={{ borderColor: "var(--border)" }}>
        <div className="mb-4 flex items-center gap-3">
          <Avatar name={name} size={34} />
          <div>
            <div className="text-[0.81rem] font-semibold uppercase tracking-[0.08em]">{name}</div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className="text-[0.66rem]" style={{ color: "var(--muted)" }}>
                LV {stats?.level ?? 1}
              </span>
            </div>
          </div>
        </div>

        <div className="mb-1 flex justify-between">
          <span className={styles.label}>exp</span>
          <span className={`${styles.mono} text-[0.77rem]`} style={{ color: "var(--muted)" }}>
            {/* 퍼센트가 아니라 '이번 레벨에서 몇/몇' 이다. 다음 레벨까지 얼마나
                남았는지를 퍼센트로만 보여주면 4점짜리 한 판이 몇 칸인지 안 보인다 */}
            {stats ? `${stats.level_into}/${stats.level_need}` : "–"}
          </span>
        </div>
        <div className="mb-4 h-0.5" style={{ background: "var(--border2)" }}>
          <div
            className="h-full"
            style={{
              width: `${Math.round((stats?.level_ratio ?? 0) * 100)}%`,
              background: "var(--accent)",
              boxShadow: "0 0 6px var(--accent-glow)",
            }}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          {/* 한 판도 없으면 win_rate 가 null 이다. 0% 로 접으면 아직 안 해 본
              사람과 다 진 사람이 같아 보인다 (lib/game/types.ts) */}
          <Stat
            label="승률"
            value={
              stats?.win_rate === null || stats === undefined
                ? "–"
                : `${Math.round(stats.win_rate * 100)}%`
            }
          />
          <Stat label="판수" value={stats ? String(stats.games) : "–"} />
        </div>
      </div>

      <div className="p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className={styles.label}>최근 게임</span>
          {/*
            여기는 다섯 줄뿐이다 — 끝까지 보는 자리는 「기록」 탭 하나다.
            ★ 링크가 아니라 **탭을 켜는 버튼**이다 (2026-08-07). 머리말의 「기록」과
              같은 곳으로 가야 해서, 둘 다 화면을 떠나지 않는다.
          */}
          <button
            type="button"
            onClick={onSeeHistory}
            className="cursor-pointer font-[inherit] text-[0.62rem] transition-colors hover:underline"
            style={{ color: "var(--muted)" }}
          >
            전체 기록 →
          </button>
        </div>

        {stats && stats.recent.length === 0 ? (
          <p className="text-[0.7rem] leading-relaxed" style={{ color: "var(--muted)" }}>
            아직 끝낸 판이 없다.
            <br />
            {/* 왜 비어 있는지를 같이 적는다. 혼자 만든 방은 세지 않기 때문에
                "분명히 한 판 했는데 비어 있다" 가 나올 수 있다 (SPEC §15-2-결정) */}
            사람이 둘 이상인 방부터 기록에 남는다.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {(stats?.recent ?? []).map((game) => (
              <div
                key={game.room_id}
                className={`${styles.inset} flex items-center justify-between px-3 py-2.5`}
              >
                <div className="flex items-center gap-2.5">
                  <span className={`${styles.dot} ${game.won ? styles.dotGreen : styles.dotRed}`} />
                  <div>
                    <div className="text-[0.77rem]">
                      {MATCH_LABEL[game.role][game.won ? "won" : "lost"]}
                    </div>
                    <div className="mt-0.5 text-[0.59rem]" style={{ color: "var(--muted)" }}>
                      {timeAgo(game.created_at, now)}
                    </div>
                  </div>
                </div>
                <span
                  className={`${styles.mono} text-[0.79rem] font-bold`}
                  style={{ color: game.won ? "var(--accent)" : "var(--red)" }}
                >
                  {/* 진 판은 -1 이다 (2026-08-07). 0 으로 접으면 깎인 게 안 보인다 */}
                  {game.score > 0 ? `+${game.score}` : String(game.score)}
                </span>
              </div>
            ))}
          </div>
        )}
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
          {/* 「모드」 열은 2026-08-06 에 지웠다 — 값이 하나뿐이라 정렬해도 아무 일이
              일어나지 않는 버튼이었다. 방마다 다른 것은 제목·상태·인원뿐이다 */}
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
      <div className="h-3 w-12" style={{ background: "var(--surface3)" }} />
      <div className="h-3 w-10" style={{ background: "var(--surface3)" }} />
    </div>
  );
}

/* ───────────────────────────── 방 만들기 ───────────────────────────── */

/**
 * 방 만들기 팝업 — **「코드로 입장」(CodeDialog)과 같은 모양이다.**
 *
 * ┌─ 왜 화면이 아니라 팝업인가 (2026-08-06) ──────────────────────────────────┐
 * │ 시안의 방 만들기는 설정 콘솔이었다: 참가 인원 눈금 · 게임 모드 · 공개 설정 · │
 * │ 라운드 시간이 두 열로 깔린 **두 번째 화면**이었고, 목록으로 돌아가는 띠를    │
 * │ 그 위에 따로 세워야 했다. 그런데 그중 서버에 닿는 값은 인원 하나뿐이었고     │
 * │ 나머지 셋은 저장할 곳이 없어 화면 안에서만 반응했다.                        │
 * │                                                                          │
 * │ 넷을 차례로 뺐다 — 인원은 고를 값이 아니게 됐고(사람 8자리 고정 + 시작할 때  │
 * │ AI 1대), 모드는 값이 하나뿐이었고, 공개 설정은 **비공개를 골라도 방이 목록에 │
 * │ 그대로 뜨는** 칸이었으며(입장 코드도 저장되지 않았다), 라운드 시간도 같은    │
 * │ 이유로 나갔다. 고르면 지켜지는 줄 아는 설정이 화면에 있는 게 제일 나쁘다.    │
 * │                                                                          │
 * │ 남은 물음이 이름 한 칸이라, 그걸 받자고 화면을 떠날 이유가 없어졌다.        │
 * │ 「코드로 입장」과 **같은 껍데기를 쓴다** — 둘 다 "짧게 한 줄 받고 방으로     │
 * │ 들어간다"는 같은 일이라, 모양이 다르면 그 자체가 헷갈릴 거리가 된다.        │
 * │ 고칠 때도 둘을 나란히 놓고 같이 고친다.                                    │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 규칙(인원 · AI 수 · 시작 조건)을 여기 적지 않는다. /intro 규칙 카드와 대기방의
 *   「방 규칙」이 같은 말을 더 정확한 자리에서 한다 — 세 군데로 갈리면 문구가 어긋난다.
 */
function CreateDialog({
  busy,
  error,
  initialName,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  /** 목록에서 찾다 못 찾고 넘어왔을 때 그 찾던 말. 없으면 빈 칸으로 연다. */
  initialName: string;
  onClose: () => void;
  /** @param name 방 제목. 비었으면 이름 없는 방이 된다 */
  onSubmit: (name: string) => void;
}) {
  // 이 팝업의 상태는 이것 하나다. 서버로 가는 값도 이것 하나다 (POST /api/room).
  const [name, setName] = useState(initialName);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 만드는 중에 닫으면 방은 생겼는데 화면은 안 넘어간다 (CodeDialog 와 같은 이유).
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
      aria-labelledby="create-dialog-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className={styles.modal}>
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <div className={`${styles.label} mb-2`}>새 방</div>
            <h3 id="create-dialog-title" className="text-[1.1rem] font-bold tracking-tight">
              방 만들기
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

        {/*
          ★ styles.mono 를 붙이지 않는다. 옆의 코드 칸과 다른 점이 이것 하나다 —
            저쪽은 코드(대문자)를 가지런히 세워야 하지만 여기는 사람이 쓴 말이라
            등폭으로 두면 자간만 벌어진다.
        */}
        <input
          className={styles.field}
          type="text"
          value={name}
          maxLength={MAX_ROOM_NAME_LEN}
          // 라벨이 이미 "방 만들기"라, 여기에는 화면으로 알 수 없는 것만 적는다 —
          // 비워도 된다는 것과, 그때 무슨 일이 일어나는가(코드를 대신 뽑는다).
          // ★ 지은 이름은 그대로 입장 코드가 된다 (lib/server/room.ts 의 codeFromName).
          //   그 사실은 글로 설명하지 않는다 — 방에 들어가면 머리말의 「코드 복사」가
          //   그 값을 그대로 들고 있어서, 한 번 보면 설명보다 빨리 안다.
          placeholder="비우면 랜덤으로 만들어진다"
          aria-label="방 이름"
          autoFocus
          onKeyDown={(e) => {
            // 한 칸짜리 폼이다. 치고 나서 마우스로 버튼을 찾아가게 두지 않는다.
            if (e.key === "Enter" && !busy) onSubmit(name);
          }}
          onChange={(e) => setName(e.target.value)}
          style={{ fontSize: "1.02rem" }}
        />
        <div className="mb-4 mt-1.5 text-right">
          <span className={styles.label}>
            {name.length} / {MAX_ROOM_NAME_LEN}
          </span>
        </div>

        {error && (
          <p role="alert" className="mb-3 text-[0.79rem]" style={{ color: "var(--red)" }}>
            {error}
          </p>
        )}

        <button
          type="button"
          className={styles.btnAccent}
          style={{ width: "100%", padding: "0.85rem" }}
          disabled={busy}
          onClick={() => onSubmit(name)}
        >
          {busy ? "만드는 중…" : "방 만들기"} <ArrowIcon />
        </button>
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
          // 코드는 이제 방 이름일 수 있다 (이름이 곧 코드) — 4자 제한을 버렸다.
          // 공백 제거 + 대문자는 서버 codeFromName 과 같은 모양이다.
          onChange={(e) => onCode(e.target.value.replace(/\s/g, "").toUpperCase().slice(0, 20))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy && code.length > 0) onSubmit();
          }}
          placeholder="방 이름 또는 코드"
          aria-label="방 코드"
          autoFocus
          style={{ letterSpacing: "0.15em", fontSize: "1.02rem", marginBottom: "1rem" }}
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
          disabled={busy || code.length === 0}
          onClick={onSubmit}
        >
          {busy ? "들어가는 중…" : "입장하기"} <ArrowIcon />
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────────── 공통 ─────────────────────────────── */

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

/** 계정 메뉴가 열린다는 표시. 이게 없으면 이름이 눌리는 것인 줄 모른다 */
function CaretIcon() {
  return (
    <svg width="8" height="5" viewBox="0 0 8 5" fill="none" aria-hidden>
      <path d="M1 1l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
