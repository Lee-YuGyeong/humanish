/**
 * 인트로 — 게임 제목 · 역할 소개. 소유: 원상 (app/intro/)
 *
 * ┌─ 시안과 달라진 점 ──────────────────────────────────────────────────────┐
 * │ 화면(형광 초록 취조실 · Space Grotesk · 카드형 규칙)은 시안 그대로다.   │
 * │ **문구만 실제 규칙에 맞췄다.** 시안에는 "5명 중 단 1명이 AI" 라고 적혀  │
 * │ 있었는데 자리 수가 틀렸고 연기자가 빠져 있었다 (근거는 SPEC §18):       │
 * │   - 자리 수는 고정이 아니다. 시작할 때 모인 사람 수가 정한다 (§18.1)    │
 * │   - AI는 언제나 1대다 (2026-08-06 결정). 여기만 시안이 맞았다           │
 * │   - 연기자가 섞일 수 있다(0명도 정상). **몇인지는 숨긴다** (§18.2)      │
 * │ 첫 화면에 적힌 숫자가 방에 들어가서 틀리면 그 뒤 화면을 전부 의심하게   │
 * │ 되므로, 고정 숫자 대신 범위와 기호(N · ?)로 적는다.                     │
 * │                                                                        │
 * │ 시안이 물고 있던 CDN 세 개(tailwind 런타임 · font-awesome · Google      │
 * │ Fonts)는 전부 뺐다. 폰트는 next/font 가 빌드 때 받아 자체 호스팅하고,   │
 * │ 아이콘은 인라인 SVG 다 — 배포본(Workers)에서 외부 요청이 나가지 않는다. │
 * │                                                                        │
 * │ 사진 두 장(스톡 이미지)도 뺐다. 위에서 떨어지는 취조등 하나를 CSS       │
 * │ 그라디언트로 세웠다 (intro.module.css 의 .heroLamp — 나가기 직전처럼    │
 * │ 깜빡인다. 바닥 어둠은 .heroLight 로 따로 두어 같이 흐려지지 않는다).    │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * 규칙 카드는 상단 "규칙" 을 눌렀을 때 열린다 → ./rules.tsx
 */

import Image from "next/image";
import Link from "next/link";
import { Space_Grotesk } from "next/font/google";
import { PlayButton } from "@/components/play-button";
import {
  ROUND_DEFENSE_MS,
  ROUND_FREECHAT_MS,
  ROUND_REVEAL_MS,
  ROUND_SPEAK_MS,
  ROUND_TOPIC_MS,
  ROUND_TOPIC_ROUNDS,
  ROUND_VERDICT_MS,
  ROUND_VOTE_MS,
  VERDICT_MAX_REVOTES,
} from "@/lib/mp/constants";
import { CastDeck } from "./cast";
import styles from "./intro.module.css";
import { RulesProvider, RulesTrigger } from "./rules";

/**
 * 라틴 전용이다. 한글은 layout.tsx 의 IBM Plex Sans KR 로 떨어진다
 * (.root 의 font-family 순서 참고). 한글 글자가 없는 서체를 앞에 세우는 건
 * 의도한 것이다 — 이 화면의 큰 글자는 대부분 라틴이다.
 */
const space = Space_Grotesk({
  variable: "--font-space",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
});

/**
 * 한 판이 짜이는 순서. 숫자표 대신 **자리를 그려서** 보여준다.
 *
 * ★ 예시는 **사람 5명이 모인 방**이다. 사람 수는 2~8 사이라 그림 하나로 다 담을 수
 *   없어 하나만 그리고 "예"라고 밝힌다. 5는 규칙이 아니라 그 줄의 값이다.
 *   **AI 1대는 규칙이다** (2026-08-06 결정) — 사람이 몇이든 딱 한 대다.
 */
const HUMANS_IN_EXAMPLE = 5;

/** 동그라미 한 개 = 자리 하나. `plus` 만 자리가 아니라 기호다 */
type Seat = "human" | "ai" | "unknown" | "plus";

const seatsOf = (n: number, kind: Seat): Seat[] =>
  Array.from({ length: n }, () => kind);

/** AI는 사람이 몇이든 1대다 (2026-08-06 결정 — lib/game/rules.ts 의 AI_SEATS_PER_ROUND) */
const AI_IN_EXAMPLE = 1;

const setup: { index: string; title: string; body: string; seats: Seat[] }[] = [
  {
    index: "01",
    title: "방을 만들고 대기방에 모인다",
    body: `사람은 8자리까지 들어온다. 2명만 모여 전원이 준비하면 시작할 수 있다 — ${HUMANS_IN_EXAMPLE}명이 모인 방을 예로 든다.`,
    seats: seatsOf(HUMANS_IN_EXAMPLE, "human"),
  },
  {
    index: "02",
    title: "게임이 시작되면 다 같이 입장한다",
    body: "전원이 캐릭터로 한 공간에 입장하고, 그 사이에 AI 1명이 사람인 척 섞여 들어온다. 언제나 한 대이고, 어느 자리인지만 숨긴다.",
    seats: [
      ...seatsOf(HUMANS_IN_EXAMPLE, "human"),
      "plus",
      ...seatsOf(AI_IN_EXAMPLE, "ai"),
    ],
  },
  {
    index: "03",
    title: "역할 카드를 받고, 추리가 시작된다",
    body: "겉모습으로는 누가 누군지 알 수 없다. 게다가 사람 중 누군가는 AI인 척 연기 중일지도 모른다.",
    seats: seatsOf(HUMANS_IN_EXAMPLE + AI_IN_EXAMPLE, "unknown"),
  },
];

/**
 * 한 판의 흐름 — 3D 월드 라운드테이블 기준 (lib/mp/constants.ts 의 ROUND_*).
 * 이름은 게임 HUD(app/world/game-hud.tsx 의 PHASE_LABEL)와 같은 말을 쓴다.
 *
 * ★ 2026-08-08 — 세 군데를 고쳤다. 전부 **숫자를 손으로 적어서** 생긴 일이다:
 *   · 주제(6초)가 통째로 빠져 있었다. 화면에 「곧 주제가 나온다」가 뜨고 세는 진짜
 *     단계다 (stepRound 의 topic → speak). 말하기 앞에 붙여 한 칸으로 묶는다.
 *   · 결과가 "—" 였다. 끝나고 마는 게 아니라 ROUND_REVEAL_MS 동안 정체가 한 겹씩
 *     열린다.
 *   · **한 줄로 흐르지 않는다.** 생사 투표가 부결되면 지목 투표로 되돌아간다
 *     (VERDICT_MAX_REVOTES 번까지). 목록 밑에 그 한 줄을 붙인다.
 *   이제 초는 전부 상수에서 뽑는다 — 다음에 시간이 바뀌면 여기도 같이 바뀐다.
 */
const sec = (ms: number) => `${Math.round(ms / 1000)}s`;

const flow = [
  { name: "주제 공개", sec: `${sec(ROUND_TOPIC_MS)} ×${ROUND_TOPIC_ROUNDS}` },
  { name: "다같이 말하기", sec: `${sec(ROUND_SPEAK_MS)} ×${ROUND_TOPIC_ROUNDS}` },
  { name: "자유 대화", sec: sec(ROUND_FREECHAT_MS) },
  { name: "지목 투표", sec: sec(ROUND_VOTE_MS) },
  { name: "최후변론", sec: sec(ROUND_DEFENSE_MS) },
  { name: "생사 투표", sec: sec(ROUND_VERDICT_MS) },
  { name: "결과", sec: sec(ROUND_REVEAL_MS) },
];

export default function IntroPage() {
  return (
    <RulesProvider>
      <div className={`${space.variable} ${styles.root}`}>
        <div aria-hidden className={styles.backdrop} />
        <div aria-hidden className={styles.scanline} />
        <div aria-hidden className={styles.noise} />

        {/* ── 내비 ──────────────────────────────────────────────────────── */}
        {/* 스크롤하면 내용이 내비 밑을 지난다. 흐림을 얹어 글자끼리 겹쳐 읽히지 않게 한다 */}
        <nav className="fixed left-0 top-0 z-50 flex w-full items-center justify-between bg-gradient-to-b from-[#080808f2] to-transparent px-6 py-6 backdrop-blur-[6px] sm:px-10 lg:px-16">
          <Link
            href="#hero"
            className="text-[1.05rem] font-bold uppercase tracking-[0.15em] text-[#e8e8e8] no-underline"
          >
            Who is AI
          </Link>
          <div className="flex items-center gap-6 sm:gap-10">
            <a href="#about" className={`${styles.navLink} hidden sm:inline`}>
              게임 소개
            </a>
            <a href="#roles" className={`${styles.navLink} hidden sm:inline`}>
              배역
            </a>
            {/* ★ 규칙은 링크가 아니라 버튼이다 — 눌러야 카드가 열린다 */}
            <RulesTrigger className={styles.navLink}>규칙</RulesTrigger>
            <span className="hidden items-center gap-2 md:flex">
              <span aria-hidden className={styles.glowDot} />
              <span className="text-[0.8rem] uppercase tracking-[0.25em] text-[#00ff66]">
                Live
              </span>
            </span>
          </div>
        </nav>

        {/* ── 히어로 ────────────────────────────────────────────────────── */}
        <section
          id="hero"
          // 세로 900px 노트북에서도 버튼이 'scroll' 표시와 겹치지 않게 아래를 비워 둔다
          className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6 pb-28 pt-32 text-center"
        >
          <div aria-hidden className={styles.heroBg} />
          {/* 등(깜빡인다) → 바닥 어둠(가만히 있다) 순서를 지킨다 — intro.module.css 의 .heroLamp */}
          <div aria-hidden className={styles.heroLamp} />
          <div aria-hidden className={styles.heroLight} />

          <div className="relative z-10 max-w-3xl">
            <p className={`${styles.fadeUp} mb-8`}>
              <span className={styles.tag}>Social Deduction Game</span>
            </p>

            <h1
              className={`${styles.fadeUp} ${styles.d1} mb-9 text-[clamp(3.2rem,9.5vw,9rem)] font-bold leading-[0.88] tracking-[-0.03em]`}
            >
              Who is
              <br />
              <span className="text-[#00ff66]">
                AI?<span className={styles.blink}>_</span>
              </span>
            </h1>

            <p
              className={`${styles.fadeUp} ${styles.d2} mx-auto mb-11 max-w-md text-[1.05rem] font-light leading-[1.95] text-[#b3b3b3]`}
            >
              사람들 사이에 <span className="text-[#e8e8e8]">AI가</span> 섞여
              있다.
              <br />
              사람 중 누군가는{" "}
              <span className="text-[#e8e8e8]">
                AI인 척 연기 중일지도 모른다.
              </span>
              <br />
              <span className="font-semibold text-[#00ff66]">
                진짜 AI를 처형하면 이긴다.
              </span>
            </p>

            <div
              className={`${styles.fadeUp} ${styles.d3} flex flex-wrap justify-center gap-4`}
            >
              {/*
                ★ 여기가 게임의 문이다. 누르면 로그인부터 한다 (SPEC §15-2-결정).
                  이미 로그인해 있으면 곧장 /main 으로 넘어간다.
                  <Link href="/main"> 로 되돌리지 않는다 — 그러면 로그인하지 않은
                  사람이 로비에 닿았다가 RequireLogin 에 걸려 튕긴다.
              */}
              <PlayButton className={styles.btnPrimary}>
                게임 접속하기
              </PlayButton>
              <RulesTrigger className={styles.btnGhost}>
                게임 규칙 보기
              </RulesTrigger>
            </div>
          </div>

          <div
            aria-hidden
            className="absolute bottom-10 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-2 opacity-60"
          >
            <span className="text-[0.75rem] uppercase tracking-[0.4em]">
              Scroll
            </span>
            <svg width="10" height="7" viewBox="0 0 10 7">
              <path
                d="M1 1l4 4 4-4"
                stroke="currentColor"
                strokeWidth="1.2"
                fill="none"
                strokeLinecap="round"
              />
            </svg>
          </div>
        </section>

        {/* ── 001 게임 소개 ─────────────────────────────────────────────── */}
        <section
          id="about"
          className="mx-auto max-w-6xl scroll-mt-24 px-6 py-16 sm:px-10 lg:py-24"
        >
          <div className="grid items-center gap-20 lg:grid-cols-2 lg:gap-28">
            <div>
              <span className={`${styles.numberLabel} block`}>
                001 — 게임 소개
              </span>
              <h2 className="mt-8 text-[clamp(2.2rem,5vw,3.2rem)] font-bold leading-[1.1] tracking-[-0.03em]">
                인간인 척하는
                <br />
                AI를 찾아라.
              </h2>

              {/*
                ★ 짧게 쓴다. 시안의 소개 문단은 "참가자 5명 중 1명의 AI" 였고, 그걸
                  고치겠다고 규칙을 다 풀어 썼더니 아무도 안 읽을 길이가 됐다.
                  세 줄이면 이 게임은 설명된다: 섞인 AI · 흉내 내는 사람 · 찾아내면 승리.
                  나머지(시간·순서)는 '규칙' 카드에 있다.
              */}
              <div className="mt-10 flex flex-col gap-5 text-[1.1rem] font-light leading-[1.9] text-[#b3b3b3]">
                <p>
                  사람들 사이에 <span className="text-[#e8e8e8]">AI가</span>{" "}
                  섞여 앉는다. AI는 사람인 척한다.
                </p>
                <p>
                  그리고 사람 중 누군가는 반대로{" "}
                  <span className="text-[#e8e8e8]">
                    AI인 척 연기 중일지도 모른다.
                  </span>
                </p>
                <p>
                  시민 · 연기자 · 진짜 AI —{" "}
                  <span className="text-[#00ff66]">
                    이 셋 중에서 진짜 AI를 처형하면 시민이 이긴다.
                  </span>
                </p>
              </div>

              <div className="mt-12 flex flex-col gap-6">
                <div className="flex items-start gap-5">
                  <span
                    aria-hidden
                    className="mt-1 h-10 w-px shrink-0 bg-[rgba(0,255,102,0.3)]"
                  />
                  <div>
                    <div className="mb-1.5 text-[0.88rem] uppercase tracking-[0.2em] text-[#00ff66]">
                      One Of Us Is Acting
                    </div>
                    <p className="text-[0.9rem] leading-[1.8] text-[#b3b3b3]">
                      연기자는 AI처럼 말하려 한다. &lsquo;AI 같은 답&rsquo;이 곧
                      함정이다.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-5">
                  <span
                    aria-hidden
                    className="mt-1 h-10 w-px shrink-0 bg-[rgba(0,255,102,0.3)]"
                  />
                  <div>
                    <div className="mb-1.5 text-[0.88rem] uppercase tracking-[0.2em] text-[#00ff66]">
                      Human Imperfection
                    </div>
                    <p className="text-[0.9rem] leading-[1.8] text-[#b3b3b3]">
                      감정, 모순, 즉흥성이 무기다. 너무 매끄러운 문장은 의심을
                      산다.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/*
              시안의 인물 사진 자리. 원본의 회색 배경은 지우고 인물만 남겼다 —
              틀도 배경색도 주지 않는다 (styles.figure 주석 참고).
            */}
            <div className="relative">
              <div className={styles.figure}>
                <Image
                  src="/intro/machine.webp"
                  alt="어둠 속에서 이쪽을 보고 있는 AI"
                  width={762}
                  height={779}
                  className={styles.figureImg}
                  priority={false}
                />
                <div aria-hidden className={styles.figureVeil} />
              </div>

              {/*
                시안에는 "1,204 agents online" 이 있었다. 지어낸 숫자는 넣지 않는다 —
                접속자 수를 세는 곳이 아직 없다. 대신 이 방의 구성을 같은 자리에 놓는다.
              */}
              <div className={styles.figureBadge}>
                <div className="mb-2 text-[0.8rem] uppercase tracking-[0.3em] text-[#00ff66]">
                  In This Room
                </div>
                <div className="text-4xl font-bold tracking-[-0.03em]">
                  AI + 1
                </div>
                <div className="mt-1 text-[0.85rem] text-[#b3b3b3]">
                  누구인지는 끝까지 모른다
                </div>
              </div>
            </div>
          </div>

          {/*
            ★ 여기 있던 숫자표(SEATS 3–8 / AI +1 / ACTOR 1 / WHO ?)를 걷어냈다.
              규칙을 이미 아는 사람에게만 읽히는 표였다. 처음 온 사람에게 필요한 건
              "몇 명인데 AI가 몇이지?"가 아니라 **자리가 어떻게 채워지는가**다.
              그래서 자리를 동그라미로 그려서 세 걸음으로 보여준다.
          */}
          <div className="mt-24 overflow-hidden rounded-3xl border border-white/[0.07]">
            <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-white/[0.06] px-7 py-5">
              <p className="text-[0.8rem] uppercase tracking-[0.3em] text-[#00ff66]">
                How It Works
              </p>
              <p className="text-[0.9rem] text-[#b3b3b3]">
                예: 사람 {HUMANS_IN_EXAMPLE}명이 모인 방
              </p>
            </div>

            {setup.map((s) => (
              <div
                key={s.index}
                className="flex flex-col gap-6 border-b border-white/[0.06] px-7 py-8 last:border-b-0 lg:flex-row lg:items-center lg:gap-10"
              >
                <span className="text-[0.9rem] tracking-[0.2em] text-[#9a9a9a] lg:w-10">
                  {s.index}
                </span>
                <div className="lg:flex-1">
                  <p className="text-[1.15rem] font-semibold tracking-tight text-[#e8e8e8]">
                    {s.title}
                  </p>
                  <p className="mt-2 text-[0.92rem] font-light leading-[1.8] text-[#9a9a9a]">
                    {s.body}
                  </p>
                </div>
                <div className={styles.seatRow}>
                  {s.seats.map((kind, i) =>
                    kind === "plus" ? (
                      <span key={i} aria-hidden className={styles.seatOp}>
                        +
                      </span>
                    ) : (
                      <span
                        key={i}
                        className={`${styles.seat} ${
                          kind === "ai"
                            ? styles.seatAi
                            : kind === "unknown"
                              ? styles.seatUnknown
                              : ""
                        }`}
                      >
                        {kind === "ai"
                          ? "AI"
                          : kind === "unknown"
                            ? "?"
                            : "사람"}
                      </span>
                    ),
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* 그래서 어떻게 이기나 — 위 세 걸음의 결론 한 줄 */}
          <p className="mt-8 text-center text-[1rem] font-light leading-[1.9] text-[#9a9a9a]">
            <span className="text-[#00ff66]">
              진짜 AI를 처형하면 시민의 승리.
            </span>{" "}
            연기자가 처형되면 연기자의 승리, 시민이 처형되거나 아무도 처형하지
            못하면 AI의 승리다.
          </p>

          <div className="mt-14 overflow-hidden rounded-3xl border border-white/[0.07] px-7 py-8">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <p className="text-[0.8rem] uppercase tracking-[0.3em] text-[#00ff66]">
                Sequence
              </p>
              <p className="text-[0.9rem] text-[#b3b3b3]">
                시작하면 이 순서로 흐른다
              </p>
            </div>
            <ol className="mt-5 flex flex-wrap gap-x-10 gap-y-4">
              {flow.map((f, i) => (
                <li key={f.name} className="flex items-baseline gap-2">
                  <span className="text-[0.8rem] text-[#9a9a9a]">{`0${i + 1}`}</span>
                  <span>
                    <span className="block text-[0.92rem] font-medium text-[#e8e8e8]">
                      {f.name}
                    </span>
                    <span className="block text-[0.85rem] tracking-wider text-[#00ff66]/70">
                      {f.sec}
                    </span>
                  </span>
                </li>
              ))}
            </ol>

            {/*
              ★ 목록이 한 줄로 흐르는 것처럼 보이는데 실제로는 되돌아가는 길이 있다
                (stepRound 의 verdict 분기). 그 한 줄이 없으면 부결됐을 때 화면이
                지목으로 돌아가는 것이 고장처럼 보인다.
            */}
            <p className="mt-6 border-t border-white/[0.06] pt-5 text-[0.85rem] font-light leading-[1.9] text-[#9a9a9a]">
              생사 투표가 부결되면 지목 투표로 돌아간다 — {VERDICT_MAX_REVOTES}번까지고,
              그래도 과반이 안 나오면 살려 둔 채 결과로 넘어간다.
            </p>
          </div>
        </section>

        {/* ── 002 배역 ──────────────────────────────────────────────────── */}
        <section
          id="roles"
          className="scroll-mt-24 border-t border-white/5 px-6 py-14 sm:px-10 lg:py-24"
        >
          <div className="mx-auto max-w-6xl">
            <div className="flex flex-wrap items-end justify-between gap-8">
              <div>
                <span className={`${styles.numberLabel} block`}>
                  002 — 배역
                </span>
                <h2 className="mt-6 text-[clamp(2.2rem,5vw,3.2rem)] font-bold leading-[1.1] tracking-[-0.03em]">
                  누구도
                  <br />
                  남의 역할을 모른다.
                </h2>
              </div>
              {/*
                ★ "역할은 시작할 때 무작위로 배정된다" 한 줄이었다. 세 배역이 참가자
                  전원에게 골고루 뿌려지는 것처럼 읽혀서 고쳤다 — **사람은 AI 역할을
                  받지 않는다.** AI 자리는 봇이고(worker 의 seatRole 이 봇 좌석에
                  무조건 'ai' 를 준다), 사람에게 배달되는 카드는 시민 아니면 연기자
                  둘뿐이다 (app/world/game-hud.tsx 의 ROLE_CARD 에 그 둘만 있다).
                ★ 둘째 줄은 사람 둘이 서로 반대로 이긴다는 것만 한 호흡에 보여주는
                  **요약**이다 (문구는 사용자 지정, 2026-08-08). 정확한 조건 — 지목이
                  아니라 **처형**까지 가야 갈린다는 것 — 은 바로 아래 배역 카드 세 장이
                  적는다. 여기서 그것까지 적으면 세 줄이 규칙 카드가 된다.
              */}
              <p className="max-w-[280px] text-[0.9rem] font-light leading-[1.9] text-[#9a9a9a] sm:text-right">
                게임에 접속한 사람은 시민 아니면 연기자다.
                <br />
                각자의 역할에 맞게 AI를 지목하거나 AI를 대신해 처형당하면
                승리한다.
                <br />
                진행 순서는 상단 &lsquo;규칙&rsquo;에 있다.
              </p>
            </div>

            {/*
              ★ 같은 크기 카드 세 장이었다. 셋이 동등해 보여 고를 이유가 없었고 인물이
                설 자리도 없었다 — 왼쪽 설명 · 오른쪽 인물의 덱으로 바꿨다 (./cast.tsx).
                배역 데이터도 그 파일로 옮겼다: 그림·색이 문구와 한 덩어리라 여기 두면
                반드시 갈린다.
            */}
            <CastDeck />

            <div className="mt-12 flex justify-center">
              <RulesTrigger className={styles.btnGhost}>
                규칙 카드 열기
              </RulesTrigger>
            </div>
          </div>
        </section>

        {/* ── CTA ───────────────────────────────────────────────────────── */}
        <section className="relative overflow-hidden px-6 py-20 text-center sm:px-10 lg:py-28">
          <span aria-hidden className={styles.ghostType}>
            AI
          </span>
          <div className="relative z-10">
            <div className="mb-12 flex items-center justify-center gap-3">
              <span aria-hidden className={styles.glowDot} />
              <span className="text-[0.8rem] uppercase tracking-[0.4em] text-[#00ff66]">
                서버 접속 가능
              </span>
            </div>
            <h2 className="mb-14 text-[clamp(2.6rem,8vw,7rem)] font-bold leading-[0.95] tracking-[-0.04em]">
              당신은
              <br />
              찾을 수 있습니까?
            </h2>
            {/* 위 히어로의 「게임 접속하기」와 같은 문이다. 누르면 로그인부터 한다 */}
            <PlayButton
              className={styles.btnPrimary}
              style={{ padding: "1.3rem 3.4rem" }}
              dot={false}
            >
              지금 게임 시작하기
            </PlayButton>
          </div>
        </section>

        {/* ── 바닥 ──────────────────────────────────────────────────────── */}
        <footer className="flex flex-wrap items-center justify-between gap-6 border-t border-white/5 px-6 py-12 sm:px-10">
          <span className="text-[0.82rem] uppercase tracking-[0.25em] text-[#888]">
            Who is AI? — 사람인 척
          </span>
          <div className="flex gap-8">
            {/* 개발용 작업 보드(Manifest)로 가던 길은 2026-08-08에 뺐다 — 보드 자체가 없다 */}
            <Link href="/world" className={styles.navLink}>
              World
            </Link>
          </div>
        </footer>
      </div>
    </RulesProvider>
  );
}
