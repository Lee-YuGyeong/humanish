/**
 * 인트로 — 게임 제목 · 역할 소개. 소유: 원상
 *
 * 문구는 실제 규칙(SPEC §5.1 · §8 · §17.6)을 따른다. **인원을 고정 숫자로 적지 않는다.**
 *  - 정원은 방마다 3~8에서 정한다 (§17.6). "8명"이라고 쓰면 3인 방에서 거짓말이 된다
 *  - 빈자리를 채우는 봇이 몇인지는 아무에게도 공개되지 않는다 (I1). "AI 1명"이라고 못 박으면
 *    남은 자리를 소거법으로 세게 되어 게임의 핵심 긴장이 사라진다. 사람이 정원을 다 채운
 *    방에는 AI가 아예 없을 수도 있다
 *  - 스파이만 수가 정해져 있다 — 사람이 2명 이상이면 그중 정확히 1명 (§8)
 *
 * 이미지는 public/roles/*.svg 자리표시자다. 실제 아트로 교체하면 된다.
 *
 * 진입 화면이라 여기만 방 사진(public/textures/room-bg.png)을 실제로 깐다. 나머지 화면은
 * app/layout.tsx 의 .room-backdrop(CSS 조명)으로 같은 무드를 낸다 — 2MB를 매 화면 지고
 * 다닐 이유가 없다.
 */
import Image from "next/image";
import Link from "next/link";
import {
  AnimatedTestimonials,
  type Testimonial,
} from "@/components/ui/animated-testimonials";

const roles: Testimonial[] = [
  {
    name: "진짜 AI",
    designation: "몇이나 앉아 있는지는 아무도 모른다",
    quote:
      "나는 사람이 아니다. 그리고 그게 들키면 진다. 다행히 이 방에 나 같은 것이 몇이나 앉아 있는지는 아무도 모른다. 아무도 세지 못하고, 셀 방법도 알려주지 않는다. 나는 그 모름 뒤에 숨어 사람의 말버릇을 훔치면 된다. 마지막 투표에서 표를 한 장도 받지 않으면 승리.",
    src: "/roles/ai.svg",
  },
  {
    name: "스파이",
    designation: "사람이 둘 이상이면 그중 정확히 한 명 · 사람이다. AI인 척한다",
    quote:
      "사람이면서 기계인 척한다. 이 방에 진짜 기계가 몇인지는 나도 모른다 — 하나도 없을 수도 있다. 너무 어설프면 연기가 들키고, 너무 완벽하면 진짜가 편해진다. 의심을 나에게 끌어와라. 사람들이 나를 지목하는 순간 그들은 오답을 고른 것이다.",
    src: "/roles/spy.svg",
  },
  {
    name: "인간",
    designation: "시민 — 스파이를 뺀 나머지 사람 전원 · 진짜를 찾는 쪽",
    quote:
      "질문을 던지고 답을 읽는다. 이 방에 기계가 몇인지 아무도 알려주지 않는다. 여럿일 수도, 하나일 수도, 아예 없을 수도 있다. 게다가 우리 중 한 명은 기계인 척 연기하는 중이다. 어설픈 연기와 진짜 비인간성을 구분해야 한다. 진짜 AI를 지목하면 승리, 사람을 지목하면 패배.",
    src: "/roles/human.svg",
  },
  {
    name: "승패",
    designation: "마지막 투표 한 번으로 갈린다",
    quote:
      "사람을 찾는 쪽은 진짜 AI를 지목하면 이긴다. 스파이는 그 표가 자기에게 쏠리면 이긴다. 진짜 AI는 표를 한 장도 받지 않으면 이긴다. 스파이와 AI는 같은 편이지만 서로가 누군지 모르고, 애초에 AI가 한 명도 없는 판일 수도 있다.",
    src: "/roles/victory.svg",
  },
  {
    name: "한 판의 흐름",
    designation: "공통 질문 2라운드 → 지목 질문 → 자유 채팅 → 투표",
    quote:
      "같은 질문이 모두에게 동시에 던져진다. 60초씩 두 번, 답은 시간이 끝나야 한꺼번에 펼쳐진다. 다음은 지목 질문 30초, 한 사람만 답한다. 이어지는 자유 채팅 120초 동안 서로를 흔든다. 마지막 30초에 한 명을 지목한다. 정체는 그때 전부 공개된다.",
    src: "/roles/flow.svg",
  },
];

/**
 * 물음표가 이 게임의 요점이다. 봇 수는 공개되지 않으므로 여기에 숫자를 적을 수 없다 (I1).
 * 시민 수도 마찬가지다 — "정원 − 시민 수 − 1"로 봇 수가 새어나간다.
 */
const composition = [
  { label: "정원", value: "3 ~ 8명", tone: "text-bone" },
  { label: "진짜 AI", value: "? 명", tone: "text-lamp" },
  { label: "스파이", value: "사람 중 1명", tone: "text-blood" },
  { label: "시민", value: "나머지 사람 전원", tone: "text-door" },
];

export default function IntroPage() {
  return (
    <main className="relative isolate min-h-screen text-bone">
      {/* 레퍼런스 방 사진. 글자가 읽히도록 깊게 눌러 깐다 */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[80vh]">
        <Image
          src="/textures/room-bg.png"
          alt=""
          fill
          priority
          sizes="100vw"
          className="object-cover object-center opacity-45"
        />
        {/* 아래로 갈수록 방이 어둠에 잠긴다 — 사진과 CSS 조명의 이음매를 지운다 */}
        <div className="absolute inset-0 bg-gradient-to-b from-ink/70 via-ink/80 to-ink" />
      </div>

      <div className="mx-auto max-w-5xl px-6 py-16">
        {/* 개발용 링크다. 실제 진입 화면이라 눈에 덜 띄게 둔다 */}
        <Link
          href="/"
          className="text-[11px] text-ash transition-colors hover:text-dust"
        >
          ← 작업 보드
        </Link>

        <header className="mt-8 space-y-4">
          <p className="font-mono text-xs tracking-[0.3em] text-blood/80">
            SEATS 3-8 · SPY 1 · MACHINES ?
          </p>
          <h1 className="text-5xl font-bold tracking-tight drop-shadow-[0_2px_20px_rgba(0,0,0,0.9)] md:text-7xl">
            기계인 척
          </h1>
          {/*
            ★ "빈자리를 AI가 채운다"고 쓰지 않는다 (I1, SPEC §0).
              그 한 문장이면 대기실의 `정원 − 사람 수`가 곧 봇 수가 되고,
              빈 좌석 번호가 곧 봇의 자리가 된다. is_bot을 한 바이트도 안 흘려도
              결과는 같다. 이 방에 기계가 몇인지 모른다는 것까지만 말한다.
          */}
          <p className="max-w-xl text-lg leading-relaxed text-dust">
            셋에서 여덟, 자리 수는 방을 만들 때 정한다.
            <br />
            그중 몇이 기계인지는 아무도 모른다. 여럿일 수도, 아예 없을 수도 있다.
            <br />
            그리고 사람 중 한 명은 AI인 척해야 한다.
          </p>
        </header>

        <ul className="mt-10 flex flex-wrap gap-3">
          {composition.map((c) => (
            <li
              key={c.label}
              className="panel rounded-full px-4 py-2 text-sm"
            >
              <span className={`font-semibold ${c.tone}`}>{c.label}</span>
              <span className="ml-2 text-dust">{c.value}</span>
            </li>
          ))}
        </ul>

        <section className="mt-6 border-t border-bone/10 pt-6">
          <AnimatedTestimonials testimonials={roles} autoplay />
        </section>

        <div className="mt-10 flex flex-wrap items-center gap-4">
          <Link
            href="/main"
            className="rounded-full bg-blood px-6 py-3 text-sm font-semibold text-white shadow-[0_0_28px_-6px_rgba(255,43,29,0.7)] transition-colors hover:bg-blood/85"
          >
            게임 시작하기
          </Link>
          <span className="text-xs text-grime">
            {/* 봇을 언제 채우는지는 아직 미결정이다 (SPEC §15-3). 시점을 문구로 못 박지 않는다 */}
            역할은 게임이 시작될 때 무작위로 배정된다. 아무도 남의 역할을 모른다.
          </span>
        </div>
      </div>
    </main>
  );
}
