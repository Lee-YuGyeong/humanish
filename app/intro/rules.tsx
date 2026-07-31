"use client";

/**
 * 규칙 카드 오버레이 — "규칙" 을 눌렀을 때만 나온다. 소유: 원상 (app/intro/)
 *
 * ★ 왜 섹션이 아니라 오버레이인가
 *   시안의 규칙 섹션은 스크롤하면 그냥 보이는 자리였다. 요청은 "규칙 탭을 눌렀을 때
 *   카드가 나오게" 이므로, 규칙은 **열어야 보이는 것**이 된다. 그러면 첫 화면은
 *   제목·소개만 남고, 규칙은 필요한 사람만 편다.
 *
 * ★ 여는 버튼이 두 군데(상단 내비 · 히어로)라 상태를 컨텍스트로 올렸다.
 *   서버 컴포넌트인 page.tsx 가 <RulesProvider> 로 감싸고, 버튼 자리에는
 *   <RulesTrigger> 만 꽂는다 — 나머지 본문은 그대로 서버에서 그려진다.
 *
 * ★ 카드 한 장은 한 호흡이다. 처음엔 조기 종료·봇 지연 같은 예외까지 적었는데,
 *   그건 규칙이 아니라 구현 메모라서 읽는 사람을 지치게 했다. 여기 남기는 것은
 *   **무엇을 언제 하는가** 뿐이다.
 *
 * 정원(UI 표기 2~8, 기본 5)은 SPEC §17.6. 고정 숫자를 쓰지 않는다 — "5명"이라 적으면 다른 정원 방에서 거짓말이 된다.
 * ※ 서버·DB 하한은 아직 3이다(§17.6). UI만 먼저 2로 내렸고 백엔드는 다음에 논의한다.
 */

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import styles from "./intro.module.css";

type Rule = {
  index: string;
  title: string;
  timing: string;
  body: string;
  tags: string[];
};

/*
 * 배역(인간 · 연기자 · AI · 승리)은 이 카드에서 뺐다 — page.tsx 의 배역 섹션이
 * 이미 같은 내용을 다뤄서 중복이었다. 규칙 카드는 **진행 순서**만 담는다.
 */

const rules: Rule[] = [
  {
    index: "01",
    title: "자리 배정",
    timing: "시작 직전",
    body: "방 정원은 2~8명. 사람이 채우지 못한 빈자리는 AI 봇이 대신 앉는다. 봇이 몇인지는 알려주지만, 어느 자리인지는 끝까지 숨긴다.",
    tags: ["정원 2–8", "자리 비공개"],
  },
  {
    index: "02",
    title: "공통 질문",
    timing: "60초 × 2라운드",
    body: "모두에게 똑같은 질문이 동시에 나온다. 답은 60초가 끝나야 한꺼번에 공개된다 — 남의 답을 훔쳐보고 따라 쓸 수 없다. 이 과정을 두 번 반복한다.",
    tags: ["동시 공개", "2라운드"],
  },
  {
    index: "03",
    title: "지목 질문",
    timing: "30초",
    body: "한 사람을 콕 집어 질문한다. 답하는 사람은 지목된 그 한 명뿐. 나머지는 그가 어떻게 답하는지를 지켜본다.",
    tags: ["1:1", "응답 패턴"],
  },
  {
    index: "04",
    title: "자유 채팅",
    timing: "120초",
    body: "정해진 순서 없이 자유롭게 대화한다. 앞선 답에서 드러난 모순을 파고들며 서로를 떠보는 시간이다.",
    tags: ["실시간", "교차 심문"],
  },
  {
    index: "05",
    title: "투표",
    timing: "30초",
    body: "각자 AI라고 의심되는 한 명을 뽑는다. 표는 비밀이며, 30초가 끝나면 모두 한꺼번에 공개된다.",
    tags: ["비밀 투표", "동시 개표"],
  },
  {
    index: "06",
    title: "공개",
    timing: "마지막",
    body: "모두의 정체가 드러난다. 진짜 AI를 맞혔다면 사람들의 승리, AI를 못 찾고 연기자에게 표가 몰렸다면 연기자의 승리다.",
    tags: ["정체 공개", "승패 확정"],
  },
];

const RulesContext = createContext<(() => void) | null>(null);

export function RulesProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);

  // 열려 있는 동안 뒤 페이지가 같이 스크롤되면 닫았을 때 엉뚱한 자리에 서 있게 된다
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <RulesContext.Provider value={show}>
      {children}
      {open ? <RulesOverlay onClose={() => setOpen(false)} /> : null}
    </RulesContext.Provider>
  );
}

/** 규칙을 여는 버튼. 생김새는 부르는 쪽이 정한다 (내비 · 히어로가 서로 다르다) */
export function RulesTrigger({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const show = useContext(RulesContext);
  return (
    <button type="button" className={className} onClick={show ?? undefined}>
      {children}
    </button>
  );
}

function RulesOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      className={styles.veil}
      role="dialog"
      aria-modal="true"
      aria-label="게임 규칙"
      // 카드가 아니라 바깥 여백을 눌렀을 때만 닫는다
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`${styles.panel} mx-auto max-w-6xl px-6 py-16 sm:px-10 sm:py-24`}>
        <div className="flex items-start justify-between gap-6">
          <div>
            <span className={styles.numberLabel}>규칙 — 진행</span>
            <h2 className="mt-5 text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl">
              한 판은
              <br />
              이 순서로 흐른다.
            </h2>
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="닫기">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
              <path
                d="M1 1l12 12M13 1L1 13"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <p className="mt-6 max-w-md text-[0.8rem] font-light leading-loose text-[#4a4a4a]">
          역할은 시작할 때 무작위로 배정된다. 배역과 승리 조건은 &lsquo;배역&rsquo; 섹션에 있다.
        </p>

        {/* ── 진행 순서 여섯 장 ──────────────────────────────────────── */}
        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {rules.map((rule) => (
            <article key={rule.index} className={styles.ruleCard}>
              <div className="flex items-baseline justify-between gap-4">
                <span className={styles.ruleIndex}>{rule.index}</span>
                <span className={`${styles.tag} ${styles.tagLive}`}>{rule.timing}</span>
              </div>
              <h3 className="text-xl font-semibold tracking-tight">{rule.title}</h3>
              <p className="text-[0.86rem] leading-[1.9] text-[#c9c9c9]">{rule.body}</p>
              <div className="mt-auto flex flex-wrap gap-2 pt-2">
                {rule.tags.map((tag) => (
                  <span key={tag} className={styles.tag}>
                    {tag}
                  </span>
                ))}
              </div>
            </article>
          ))}
        </div>

        <div className="mt-14 flex justify-center">
          <button type="button" className={styles.btnGhost} onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
