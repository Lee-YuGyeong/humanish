/**
 * 메인 로비 — 공개 대기방 목록. 소유: C (SPEC §2)
 *
 * 지금은 목업 데이터로 그린 화면이다 (app/main/mock-lobby.ts).
 * TODO(A): 방 목록 조회 · 방 만들기 · 입장을 서버 경유로 연결 (SPEC I9).
 * TODO(C): 검색 · 필터 · 채팅 입력 동작.
 * 이 폴더(app/main) 밖은 건드리지 않는다.
 */
import Link from "next/link";
import {
  ChipIcon,
  CoinIcon,
  CrownIcon,
  ExpandIcon,
  GearIcon,
  GemIcon,
  LockIcon,
  PlusIcon,
  SearchIcon,
  SendIcon,
  SlidersIcon,
  SpyIcon,
  UserPlusIcon,
  VolumeIcon,
} from "@/components/ui/icons";
import {
  chat,
  friendStyle,
  friends,
  MAX_PLAYERS,
  modeStyle,
  recentGames,
  rooms,
} from "./mock-lobby";

export default function MainPage() {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-white text-neutral-600">
      <Header />

      <main className="flex flex-1 overflow-hidden">
        <ProfileSidebar />
        <RoomList />
        <SocialSidebar />
      </main>

      <Footer />
    </div>
  );
}

/* ─────────────────────────────── 헤더 ─────────────────────────────── */

const navItems = ["멀티플레이", "상점", "컬렉션", "기록"];

function Header() {
  return (
    <header className="flex h-20 shrink-0 items-center justify-between border-b border-neutral-200 bg-white/80 px-8 backdrop-blur-md">
      <div className="flex items-center gap-8">
        <Link href="/" className="text-2xl font-black tracking-tighter text-neutral-900">
          기계인 척
        </Link>
        <nav className="hidden items-center gap-6 md:flex">
          {navItems.map((item, i) => (
            <button
              key={item}
              type="button"
              className={
                i === 0
                  ? "border-b-2 border-indigo-600 pb-1 text-sm font-bold text-neutral-900"
                  : "text-sm text-neutral-400 transition-colors hover:text-neutral-900"
              }
            >
              {item}
            </button>
          ))}
        </nav>
      </div>

      <div className="flex items-center gap-6">
        <div className="flex items-center gap-4 rounded-full border border-neutral-200 bg-neutral-50 px-4 py-2">
          <span className="flex items-center gap-2">
            <CoinIcon className="h-4 w-4 text-amber-500" />
            <span className="text-sm font-bold tracking-wider text-neutral-900">12,450</span>
          </span>
          <span className="h-4 w-px bg-neutral-200" />
          <span className="flex items-center gap-2">
            <GemIcon className="h-4 w-4 text-indigo-600" />
            <span className="text-sm font-bold tracking-wider text-neutral-900">420</span>
          </span>
        </div>

        <div className="flex items-center gap-3 border-l border-neutral-200 pl-4">
          <div className="text-right">
            <p className="text-xs font-bold uppercase tracking-widest text-neutral-900">
              Player_K
            </p>
            <p className="text-[10px] font-black text-indigo-600">LV. 24</p>
          </div>
          <div className="relative">
            <Avatar name="Player_K" className="h-10 w-10 ring-2 ring-indigo-600" />
            <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-white bg-emerald-500" />
          </div>
        </div>

        <button
          type="button"
          aria-label="설정"
          className="text-neutral-400 transition-colors hover:text-neutral-900"
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
    <aside className="hidden w-80 shrink-0 overflow-y-auto border-r border-neutral-200 bg-neutral-50/60 p-6 lg:block">
      <SectionTitle>플레이어 정보</SectionTitle>
      <div className="mb-8 rounded-2xl border border-neutral-200 bg-white p-4">
        <div className="mb-4">
          <div className="mb-1 flex justify-between text-[10px] font-bold uppercase">
            <span className="text-neutral-400">경험치 (EXP)</span>
            <span className="text-indigo-600">75%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
            <div className="h-full w-3/4 rounded-full bg-indigo-600" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Stat label="승률" value="64%" />
          <Stat label="판수" value="128" />
        </div>
      </div>

      <SectionTitle>선호 역할</SectionTitle>
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

      <SectionTitle>최근 게임</SectionTitle>
      <div className="space-y-2">
        {recentGames.map((game) => (
          <div
            key={game.result}
            className={`flex items-center gap-3 rounded-xl border p-3 ${
              game.win
                ? "border-emerald-100 bg-emerald-50/60"
                : "border-red-100 bg-red-50/60"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                game.win ? "bg-emerald-500" : "bg-red-500"
              }`}
            />
            <div className="flex-1">
              <p className="text-xs font-bold text-neutral-900">{game.result}</p>
              <p className="text-[10px] text-neutral-400">{game.time}</p>
            </div>
            <span
              className={`text-xs font-bold ${
                game.win ? "text-emerald-600" : "text-red-500"
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

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-4 text-xs font-bold uppercase tracking-[0.2em] text-neutral-900">
      {children}
    </h3>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-neutral-100 bg-neutral-50 p-2 text-center">
      <p className="text-[10px] uppercase text-neutral-400">{label}</p>
      <p className="text-lg font-bold text-neutral-900">{value}</p>
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
    <div className="flex items-center justify-between rounded-xl border border-neutral-200 bg-white p-3">
      <div className="flex items-center gap-3">
        <span
          className={`flex h-8 w-8 items-center justify-center rounded-lg ${
            accent
              ? "bg-indigo-50 text-indigo-600"
              : "bg-neutral-100 text-neutral-400"
          }`}
        >
          {icon}
        </span>
        <span className="text-sm font-medium text-neutral-900">{name}</span>
      </div>
      <span className="text-xs italic text-neutral-400">{level}</span>
    </div>
  );
}

/* ───────────────────────────── 가운데 방 목록 ───────────────────────────── */

function RoomList() {
  return (
    <section className="flex-1 overflow-y-auto bg-neutral-50/40 p-8">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-black tracking-tight text-neutral-900">
            공개 대기방
          </h2>
          <p className="text-sm text-neutral-400">
            현재 {rooms.length}개의 활성 게임룸이 있습니다.
          </p>
        </div>

        <div className="flex gap-3">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
            <input
              type="text"
              placeholder="방 제목 또는 ID 검색..."
              className="w-64 rounded-xl border border-neutral-200 bg-white py-3 pl-11 pr-6 text-sm text-neutral-900 transition-colors placeholder:text-neutral-400 focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <button
            type="button"
            aria-label="필터"
            className="rounded-xl border border-neutral-200 bg-white p-3 text-neutral-600 transition-colors hover:border-indigo-500 hover:text-indigo-600"
          >
            <SlidersIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="rounded-xl bg-indigo-600 px-6 py-3 text-sm font-black uppercase tracking-widest text-white transition-colors hover:bg-indigo-500"
          >
            방 만들기
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {rooms.map((room) => (
          <RoomCard key={room.id} room={room} />
        ))}

        <button
          type="button"
          className="group flex min-h-44 flex-col items-center justify-center rounded-2xl border-2 border-dashed border-neutral-200 p-6 transition-colors hover:border-indigo-400 hover:bg-indigo-50/40"
        >
          <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-neutral-100 text-neutral-400 transition-colors group-hover:bg-white group-hover:text-indigo-600">
            <PlusIcon className="h-5 w-5" />
          </span>
          <span className="text-sm font-bold text-neutral-400 transition-colors group-hover:text-indigo-600">
            새로운 방 만들기
          </span>
        </button>
      </div>
    </section>
  );
}

function RoomCard({ room }: { room: (typeof rooms)[number] }) {
  const ratio = Math.round((room.players / MAX_PLAYERS) * 100);
  const full = room.players >= MAX_PLAYERS;

  return (
    <Link
      href={`/room/${room.id.toLowerCase()}`}
      className="group rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm transition-all hover:-translate-y-0.5 hover:border-indigo-400 hover:shadow-md"
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <span
            className={`rounded px-2 py-1 text-[10px] font-black uppercase tracking-widest ${
              modeStyle[room.mode]
            }`}
          >
            {room.mode}
          </span>
          <h4 className="mt-2 truncate font-bold text-neutral-900">{room.title}</h4>
        </div>
        <div className="shrink-0 text-right">
          {room.locked ? (
            <LockIcon className="ml-auto h-4 w-4 text-neutral-400" />
          ) : (
            <>
              <p className="text-sm font-bold text-neutral-900">
                {room.players} / {MAX_PLAYERS}
              </p>
              <p className="text-[10px] uppercase text-neutral-400">Players</p>
            </>
          )}
        </div>
      </div>

      <div className="mb-6 flex items-center gap-2 text-xs text-neutral-400">
        <CrownIcon className="h-3.5 w-3.5 text-indigo-500" />
        <span className="truncate text-neutral-500">{room.host}</span>
        <span>•</span>
        {room.voice ? (
          <VolumeIcon className="h-3.5 w-3.5" />
        ) : (
          <span>{room.language}</span>
        )}
      </div>

      <div className="h-1 w-full overflow-hidden rounded-full bg-neutral-100">
        <div
          className={`h-full rounded-full transition-colors ${
            full ? "bg-amber-500" : "bg-indigo-500"
          }`}
          style={{ width: `${ratio}%` }}
        />
      </div>
    </Link>
  );
}

/* ───────────────────────────── 오른쪽 사이드바 ───────────────────────────── */

function SocialSidebar() {
  return (
    <aside className="hidden w-72 shrink-0 flex-col border-l border-neutral-200 bg-neutral-50/60 xl:flex">
      <div className="flex flex-1 flex-col overflow-hidden p-6">
        <div className="mb-6 flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-neutral-900">
            친구
          </h3>
          <div className="flex gap-2 text-neutral-400">
            <button type="button" aria-label="친구 추가" className="hover:text-neutral-900">
              <UserPlusIcon className="h-4 w-4" />
            </button>
            <button type="button" aria-label="친구 검색" className="hover:text-neutral-900">
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
                  <Avatar name={friend.name} className="h-10 w-10 ring-1 ring-neutral-200" />
                  <span
                    className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-white ${style.dot}`}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-neutral-900">
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

      <div className="flex h-72 flex-col border-t border-neutral-200 bg-white p-4">
        <div className="mb-4 flex items-center justify-between">
          <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-400">
            Global Chat
          </span>
          <button
            type="button"
            aria-label="채팅 확대"
            className="text-neutral-400 transition-colors hover:text-neutral-900"
          >
            <ExpandIcon className="h-3 w-3" />
          </button>
        </div>

        <div className="mb-4 flex-1 space-y-3 overflow-y-auto pr-1">
          {chat.map((line, i) => (
            <p key={i} className="text-[11px] leading-relaxed text-neutral-600">
              <span className={`font-bold ${line.tone}`}>{line.user}:</span>{" "}
              {line.message}
            </p>
          ))}
        </div>

        <div className="relative">
          <input
            type="text"
            placeholder="메시지를 입력하세요..."
            className="w-full rounded-lg border border-neutral-200 bg-neutral-50 py-2 pl-3 pr-9 text-xs text-neutral-900 transition-colors placeholder:text-neutral-400 focus:border-indigo-500 focus:bg-white focus:outline-none"
          />
          <button
            type="button"
            aria-label="전송"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-indigo-600"
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
    <footer className="flex h-10 shrink-0 items-center justify-between border-t border-neutral-200 bg-neutral-50 px-6 text-[10px] font-medium">
      <div className="flex gap-4 text-neutral-400">
        <span>
          동시 접속자: <span className="text-neutral-900">1,204명</span>
        </span>
        <span>
          서버 상태: <span className="text-emerald-600">쾌적</span>
        </span>
      </div>
      <div className="flex gap-4 text-neutral-400">
        <Link href="/intro" className="transition-colors hover:text-neutral-900">
          역할 설명
        </Link>
        <Link href="/" className="transition-colors hover:text-neutral-900">
          작업 보드
        </Link>
      </div>
    </footer>
  );
}

/* ─────────────────────────────── 공통 ─────────────────────────────── */

/**
 * 이니셜 아바타. 외부 이미지 호스트에 의존하지 않는다.
 * TODO(C): mask_id 기반 아바타 에셋으로 교체 (SPEC 용어표).
 */
function Avatar({ name, className = "" }: { name: string; className?: string }) {
  const initial = name.trim().charAt(0).toUpperCase();
  return (
    <span
      className={`flex items-center justify-center rounded-full bg-neutral-900 text-xs font-bold text-white ${className}`}
      aria-hidden
    >
      {initial}
    </span>
  );
}
