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
 * 정원은 SPEC §17.6·§18.1. 자리 수를 숫자로 말하지 않는다 — 방에 몇이 모였느냐로
 * 달라지기 때문이다.
 * ※ 2026-08-06 결정으로 **AI 수는 언제나 1대**가 됐다 (사람 2~8 + AI 1 = 최대 9).
 *   그 수는 규칙이라 미리 적어도 된다 (§15-3 — 수는 공개, 자리는 비밀).
 *   §18.1 이 적어 둔 인원표(`capacity` 3~10에서 6 제외, `seat_count`)는 이 결정으로
 *   대체됐다.
 * ※ 2026-08-07: 진행 카드를 **3D 월드 라운드테이블** 기준으로 바꿨다. 실제 판은
 *   대기방 → /world 로 흐르고, 단계·시간은 lib/mp/constants.ts 의 ROUND_*
 *   (worker/src/roundtable.ts 상태머신)가 기준이다. SPEC §5.1 의 2D 흐름(서면
 *   공통 질문 · 지목 질문 · 재투표)은 월드 판에 해당하지 않는다 — roundtable.ts
 *   머리말의 「두 무대는 별개다」 참고. 단계 이름은 HUD(PHASE_LABEL)와 같은 말을 쓴다.
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
    title: "집결",
    timing: "시작 직전",
    body: "대기방에서 전원이 준비하면 게임이 시작된다. 전원이 들어오면 카운트다운과 함께 각자 역할 카드를 받는다 — 그 순간 AI 1명이 사람들 사이에 섞인다. 몇인지는 이렇게 미리 알려주지만 어느 자리인지는 끝까지 숨긴다. 사람 중 누가 연기자인지, 연기자가 몇인지는 아무도 모른다.",
    tags: ["AI 1명", "자리 비공개"],
  },
  {
    index: "02",
    title: "다같이 말하기",
    timing: "45초 × 2라운드",
    body: "모두에게 같은 주제가 뜬다. 1라운드는 사실을 묻고, 2라운드는 감정을 묻는다 — 한 사람의 두 답이 서로 결이 맞는지 지켜봐야 한다. 45초 동안 전원이 자유롭게 말한다.",
    tags: ["사실 → 감정", "2라운드"],
  },
  {
    index: "03",
    title: "자유 대화",
    timing: "60초",
    body: "정해진 순서 없이 자유롭게 대화한다. 앞선 답에서 드러난 모순을 파고들며 서로를 떠보는 시간이다.",
    tags: ["실시간", "교차 심문"],
  },
  {
    index: "04",
    title: "지목 투표",
    timing: "30초",
    body: "AI라고 의심되는 한 명을 지목한다. 표는 비밀이고, 시간 안에는 마음을 바꿔도 된다 — 마지막 선택이 유효하다. 최다 득표가 동점이면 그중 무작위로 정해진다.",
    tags: ["비밀 투표", "동점은 무작위"],
  },
  {
    index: "05",
    title: "최후변론 · 생사 투표",
    timing: "20초 + 20초",
    body: "지목된 사람에게 조명이 떨어지고 20초의 최후변론이 주어진다. 그 말을 듣고 처형할지 살릴지를 찬반으로 정한다 — 찬성이 과반이면 처형되고, 아니면 지목 투표부터 다시 한다.",
    tags: ["조명", "과반이면 처형"],
  },
  {
    index: "06",
    title: "결과",
    timing: "마지막",
    body: "모두의 정체가 드러난다. 처형된 한 명이 진짜 AI였다면 시민의 승리, 연기자였다면 연기자의 승리, 시민이었다면 AI의 승리다. 아무도 처형하지 못한 판도 AI의 승리다.",
    tags: ["정체 공개", "한 진영만 승리"],
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

        <p className="mt-6 max-w-md text-[0.9rem] font-light leading-loose text-[#b3b3b3]">
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
              <h3 className="text-2xl font-semibold tracking-tight">{rule.title}</h3>
              <p className="text-[0.96rem] leading-[1.9] text-[#c9c9c9]">{rule.body}</p>
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
