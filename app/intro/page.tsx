/**
 * 인트로 — 게임 제목 · 역할 소개. 소유: 원상
 *
 * 문구는 실제 규칙(SPEC §5.1 · §8 · §15-3 · §17.6)을 따른다. **고정 숫자를 적지 않는다.**
 *  - 정원은 방마다 3~8에서 정한다 (§17.6). "8명"이라고 쓰면 3인 방에서 거짓말이 된다
 *  - 기계가 **몇 대인지는 공개한다** (§15-3-결정). 다만 방마다 다르고 0일 수도 있으므로
 *    "AI 1명"처럼 못 박지 않는다 — 사람이 정원을 다 채운 방에는 기계가 없다
 *  - **어느 자리가 기계인지는 끝까지 숨긴다** (I1). 시작할 때 전원의 자리가 다시 섞인다
 *  - 스파이만 수가 정해져 있다 — 사람이 2명 이상이면 그중 정확히 1명 (§8)
 *
 * 이미지는 public/roles/*.svg 자리표시자다. 실제 아트로 교체하면 된다.
 *
 * ★ 옛 씬의 레퍼런스 사진(public/textures/room-bg.png)을 더 이상 깔지 않는다.
 *   씬이 지하 라운지에서 창고 시네마로 바뀌었으므로 그 사진은 다른 방이다.
 *   대신 제목을 영사막 위에 띄운다 — 방에서 유일하게 밝은 면이 스크린이라
 *   타이틀 카드가 거기 걸리는 게 이 공간의 문법이다.
 */
import Link from "next/link";
import {
  AnimatedTestimonials,
  type Testimonial,
} from "@/components/ui/animated-testimonials";

const roles: Testimonial[] = [
  {
    name: "진짜 AI",
    designation: "몇 대인지는 알려준다. 어느 자리인지는 아니다",
    quote:
      "나는 사람이 아니다. 그리고 그게 들키면 진다. 이 방에 나 같은 것이 몇인지는 모두가 안다 — 그건 숨겨주지 않는다. 다만 **어느 자리인지**는 아무도 모른다. 시작하는 순간 모두의 자리가 다시 섞였기 때문이다. 나는 그 틈에 숨어 사람의 말버릇을 훔치면 된다. 마지막 투표에서 표를 한 장도 받지 않으면 승리.",
    src: "/roles/ai.svg",
  },
  {
    name: "스파이",
    designation: "사람이 둘 이상이면 그중 정확히 한 명 · 사람이다. AI인 척한다",
    quote:
      "사람이면서 기계인 척한다. 이 방에 진짜 기계가 몇 대인지는 나도 안다 — 한 대도 없을 수도 있다. 그래서 더 위험하다. 기계가 없는 판이면 사람들이 찾는 건 결국 나 하나다. 너무 어설프면 연기가 들키고, 너무 완벽하면 진짜가 편해진다. 사람들이 나를 지목하는 순간 그들은 오답을 고른 것이다.",
    src: "/roles/spy.svg",
  },
  {
    name: "인간",
    designation: "시민 — 스파이를 뺀 나머지 사람 전원 · 진짜를 찾는 쪽",
    quote:
      "질문을 던지고 답을 읽는다. 기계가 몇 대인지는 알려준다 — 그게 유일한 단서다. 여럿일 수도, 하나일 수도, 아예 없을 수도 있다. 없는 판이라면 지목할 기계 자체가 없다. 게다가 우리 중 한 명은 기계인 척 연기하는 중이다. 어설픈 연기와 진짜 비인간성을 구분해야 한다. 진짜 AI를 지목하면 승리, 사람을 지목하면 패배.",
    src: "/roles/human.svg",
  },
  {
    name: "승패",
    designation: "마지막 투표 한 번으로 갈린다",
    quote:
      "사람을 찾는 쪽은 진짜 AI를 지목하면 이긴다. 스파이는 그 표가 자기에게 쏠리면 이긴다. 진짜 AI는 표를 한 장도 받지 않으면 이긴다. 스파이와 AI는 같은 편이지만 서로가 누군지 모르고, 애초에 AI가 한 대도 없는 판일 수도 있다.",
    src: "/roles/victory.svg",
  },
  {
    name: "한 판의 흐름",
    designation: "공통 질문 2라운드 → 지목 질문 → 자유 채팅 → 투표",
    quote:
      "시작하는 순간 모두의 자리가 다시 섞인다 — 대기실에서 본 것은 여기서 소용이 없다. 같은 질문이 모두에게 동시에 던져진다. 60초씩 두 번, 답은 시간이 끝나야 한꺼번에 펼쳐진다. 다음은 지목 질문 30초, 한 사람만 답한다. 이어지는 자유 채팅 120초 동안 서로를 흔든다. 마지막 30초에 한 명을 지목한다. 정체는 그때 전부 공개된다.",
    src: "/roles/flow.svg",
  },
];

/**
 * ★ 물음표의 자리가 바뀌었다 (SPEC §15-3-결정).
 *
 * 예전에는 "기계가 몇인가?"가 비밀이었다. 이제 수는 알려주고 **누구인가**만 숨긴다.
 * 그래서 MACHINES에는 N(시작하면 알려주는 값), WHO에 물음표가 온다.
 * 여기에 고정 숫자를 박지 않는다 — 정원이 방마다 다르고(§17.6) 0일 수도 있다.
 */
const composition = [
  { label: "SEATS", value: "3–8", note: "방마다 정한다", tone: "text-bone" },
  { label: "MACHINES", value: "N", note: "수는 알려준다", tone: "lit-tung" },
  { label: "SPY", value: "1", note: "사람 중 한 명", tone: "lit-signal" },
  { label: "WHO", value: "?", note: "이건 끝까지 모른다", tone: "text-dust" },
];

/** 한 판의 흐름. 진행 순서가 곧 시간축이라 가로 눈금으로 읽힌다 (SPEC §5.1) */
const flow = [
  { name: "공통 질문", sec: "60초 ×2" },
  { name: "지목 질문", sec: "30초" },
  { name: "자유 채팅", sec: "120초" },
  { name: "투표", sec: "30초" },
  { name: "공개", sec: "—" },
];

export default function IntroPage() {
  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-5xl px-6 pb-24 pt-10">
        {/* 개발용 링크다. 실제 진입 화면이라 눈에 덜 띄게 둔다 */}
        <Link href="/" className="stencil text-[10px] text-ash transition-colors hover:text-tung">
          ← manifest
        </Link>

        {/* ── 영사막에 걸린 타이틀 카드 ────────────────────────────────── */}
        <section className="screen mt-6 overflow-hidden px-8 py-14 sm:px-14 sm:py-20">
          {/* 위에서 때리는 스포트 세 갈래. 씬의 Spot ×3과 같은 자리다 */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                "radial-gradient(38% 60% at 22% -10%, rgba(255,227,189,.09), transparent 70%)," +
                "radial-gradient(38% 60% at 50% -14%, rgba(255,227,189,.11), transparent 70%)," +
                "radial-gradient(38% 60% at 78% -10%, rgba(255,227,189,.09), transparent 70%)",
            }}
          />

          <div className="relative">
            <p className="stencil text-[10px] text-signal/80">now showing</p>

            <h1 className="engraved mt-5 text-[clamp(3rem,11vw,7.5rem)] font-black leading-[0.85]">
              기계인 척
            </h1>

            {/*
              ★ §15-3 이전에는 "빈자리를 AI가 채운다"조차 쓰지 않았다. 이제는 쓴다 —
                수를 공개하기로 했고, 어느 자리인지는 시작할 때 전원을 다시 섞어서 지킨다.
                대신 **고정 숫자를 적지 않는다.** 정원이 방마다 다르고 0일 수도 있다.
            */}
            <p className="mt-8 max-w-lg text-[17px] leading-[1.75] text-dust">
              셋에서 여덟. 자리 수는 방을 만들 때 정한다.
              <br />
              빈자리는 기계가 채운다. <span className="text-bone">몇 대인지는 알려준다</span> —
              한 대도 없을 수도 있다.
              <br />
              <span className="text-bone">어느 자리인지는 끝까지 알려주지 않는다.</span>
              <br />
              그리고 사람 중 한 명은{" "}
              <span className="lit-signal font-semibold">AI인 척해야 한다.</span>
            </p>

            <div className="mt-12 flex flex-wrap items-center gap-x-8 gap-y-4">
              <Link
                href="/main"
                className="case case-live group inline-flex items-center gap-4 px-9 py-4"
              >
                <span className="stencil text-xs text-flare">입장</span>
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 rounded-full bg-signal shadow-[0_0_10px_2px] shadow-signal/70 transition-transform group-hover:scale-125"
                />
              </Link>
              <p className="max-w-xs text-xs leading-relaxed text-grime">
                {/* 봇을 채우는 "시점"은 여전히 시작 버튼이다 (§15-3). 문구로 못 박지 않는다 */}
                역할은 시작할 때 무작위로 배정된다. 아무도 남의 역할을 모른다.
              </p>
            </div>
          </div>
        </section>

        {/* ── 구성 — 케이스에 붙은 물품표 ──────────────────────────────── */}
        <ul className="mt-px grid grid-cols-2 gap-px sm:grid-cols-4">
          {composition.map((c) => (
            <li key={c.label} className="case px-5 py-4">
              <p className="stencil text-[9px] text-ash">{c.label}</p>
              <p className={`readout mt-2 text-2xl ${c.tone}`}>{c.value}</p>
              <p className="mt-1 text-[11px] text-grime">{c.note}</p>
            </li>
          ))}
        </ul>

        {/* ── 진행 순서 — 시간축 ───────────────────────────────────────── */}
        <div className="mt-16">
          <p className="stencil text-[10px] text-grime">한 판의 흐름</p>
          <ol className="mt-4 flex flex-wrap items-stretch gap-px">
            {flow.map((f, i) => (
              <li key={f.name} className="case flex min-w-32 flex-1 items-center gap-3 px-4 py-3">
                <span className="readout text-[11px] text-ash">{i + 1}</span>
                <span>
                  <span className="block text-[13px] font-semibold text-bone">{f.name}</span>
                  <span className="readout block text-[10px] text-tung/60">{f.sec}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>

        {/* ── 역할 ─────────────────────────────────────────────────────── */}
        <section className="mt-16">
          <p className="stencil text-[10px] text-grime">배역</p>
          <AnimatedTestimonials testimonials={roles} autoplay />
        </section>
      </div>
    </main>
  );
}
