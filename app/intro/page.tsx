/**
 * 인트로 — 게임 제목 · 역할 소개. 소유: 원상
 *
 * 8명: 진짜 AI 1 · 스파이 3 · 인간 4.
 * 이미지는 public/roles/*.svg 자리표시자다. 실제 아트로 교체하면 된다.
 */
import Link from "next/link";
import {
  AnimatedTestimonials,
  type Testimonial,
} from "@/components/ui/animated-testimonials";

const roles: Testimonial[] = [
  {
    name: "진짜 AI",
    designation: "8명 중 1명 · 유일하게 사람이 아니다",
    quote:
      "나는 사람이 아니다. 그리고 그게 들키면 진다. 다행히 나를 흉내 내는 셋이 시선을 끌어준다. 나는 그 뒤에 숨어 사람의 말버릇을 훔치면 된다. 마지막 투표에서 지목당하지 않으면 승리.",
    src: "/roles/ai.svg",
  },
  {
    name: "스파이",
    designation: "8명 중 3명 · 사람이다. AI인 척한다",
    quote:
      "사람이면서 기계인 척한다. 너무 어설프면 연기가 들키고, 너무 완벽하면 진짜 AI가 편해진다. 의심을 나에게 끌어와라. 인간 팀이 사람을 지목하는 순간 그들은 오답을 고른 것이다.",
    src: "/roles/spy.svg",
  },
  {
    name: "인간",
    designation: "8명 중 4명 · 진짜를 찾는 쪽",
    quote:
      "질문을 던지고 답을 읽는다. 이상한 사람이 넷이나 되는데 그중 진짜 기계는 하나뿐이다. 어설픈 연기와 진짜 비인간성을 구분해야 한다. 진짜 AI를 지목하면 승리, 사람을 지목하면 패배.",
    src: "/roles/human.svg",
  },
  {
    name: "승패",
    designation: "마지막 투표 한 번으로 갈린다",
    quote:
      "인간 팀은 진짜 AI를 지목하면 이긴다. 스파이는 인간 팀이 사람을 지목하게 만들면 이긴다. 진짜 AI는 끝까지 지목당하지 않으면 이긴다. 스파이와 AI는 같은 편이지만 서로가 누군지 모른다.",
    src: "/roles/victory.svg",
  },
  {
    name: "한 판의 흐름",
    designation: "질문 2라운드 → 자유 대화 → 투표",
    quote:
      "같은 질문이 8명에게 동시에 던져지고 답은 한꺼번에 공개된다. 이어지는 자유 대화에서 서로를 흔든다. 마지막에 한 명을 지목한다. 정체는 그때 전부 공개된다.",
    src: "/roles/flow.svg",
  },
];

const composition = [
  { label: "진짜 AI", count: 1, tone: "text-sky-600" },
  { label: "스파이", count: 3, tone: "text-orange-600" },
  { label: "인간", count: 4, tone: "text-teal-600" },
];

export default function IntroPage() {
  return (
    <main className="min-h-screen bg-white text-neutral-900">
      <div className="mx-auto max-w-5xl px-6 py-16">
        <Link
          href="/"
          className="text-xs text-neutral-400 transition-colors hover:text-neutral-700"
        >
          ← 작업 보드
        </Link>

        <header className="mt-8 space-y-4">
          <p className="font-mono text-xs tracking-[0.3em] text-neutral-400">
            HUMANS 4 · SPIES 3 · MACHINE 1
          </p>
          <h1 className="text-5xl font-bold tracking-tight md:text-7xl">
            기계인 척
          </h1>
          <p className="max-w-xl text-lg text-neutral-500">
            여덟 명이 앉아 있다. 그중 진짜 AI는 하나뿐이다.
            <br />
            셋은 AI인 척 연기하는 사람이고, 넷은 진짜를 찾아야 한다.
          </p>
        </header>

        <ul className="mt-10 flex flex-wrap gap-3">
          {composition.map((c) => (
            <li
              key={c.label}
              className="rounded-full border border-neutral-200 bg-neutral-50 px-4 py-2 text-sm"
            >
              <span className={`font-semibold ${c.tone}`}>{c.label}</span>
              <span className="ml-2 text-neutral-500">{c.count}명</span>
            </li>
          ))}
        </ul>

        <section className="mt-6 border-t border-neutral-100 pt-6">
          <AnimatedTestimonials testimonials={roles} autoplay />
        </section>

        <div className="mt-10 flex flex-wrap items-center gap-4">
          <Link
            href="/main"
            className="rounded-full bg-neutral-900 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-neutral-700"
          >
            게임 시작하기
          </Link>
          <span className="text-xs text-neutral-400">
            역할은 입장 후 무작위로 배정된다. 아무도 남의 역할을 모른다.
          </span>
        </div>
      </div>
    </main>
  );
}
