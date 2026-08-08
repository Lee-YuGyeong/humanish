"use client";

/**
 * 배역 덱 — 왼쪽에 배역 설명, 오른쪽에 그 배역의 인물이 선다. 소유: 원상 (app/intro/)
 *
 * ★ 파일 이름이 rules.tsx 와 헷갈리기 쉬워 일부러 cast(배역)로 뒀다. 규칙 카드는
 *   rules.tsx(진행 순서), 이 파일은 **배역 셋과 그 인물**이다. 한 글자 차이(roles/rules)로
 *   두면 다음 사람이 반드시 잘못 연다.
 *
 * ┌─ 왜 카드 세 장이 아니라 덱인가 ────────────────────────────────────────────┐
 * │ 앞 판본은 같은 크기 카드 세 장을 나란히 놓았다. 셋이 동등해 보여서 **어느    │
 * │ 것이 나인지 고를 이유가 없는 화면**이었고, 인물 그림이 들어갈 자리도 없었다. │
 * │ 이제 배역을 하나씩 고른다: 왼쪽 줄을 누르거나 오른쪽 인물을 밀면 바뀐다.     │
 * │ 설명은 셋 다 계속 읽히게 두고(인트로에서 정보를 감추면 손해다) 고른 것만     │
 * │ 색이 켜진다.                                                               │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 색은 **게임 안과 같은 말**을 쓴다. 초록은 이 화면에서 언제나 진짜 AI 고
 *   (intro.module.css 의 .ruleCardLit 주석), 연기자 금색·시민 하늘색은 월드
 *   역할 카드에서 그대로 가져왔다 (app/world/game-hud.tsx 의 ROLE_CARD). 앞 판본은
 *   세 배역 태그가 전부 초록이라 "초록 = AI" 라는 이 화면의 약속을 스스로 깼다.
 *
 * ★ 그림은 public/intro/cast/*.webp 다. 원본 PNG(1024×1536, 각 2.4MB)를 sharp 로
 *   폭 820 · webp q80 으로 구웠다(각 110~190KB). next.config 가 이미지 최적화를
 *   꺼 두었으므로(unoptimized — Workers 에는 최적화 서버가 없다) **여기 놓는 파일이
 *   그대로 브라우저로 간다.** 그림을 갈아 끼울 때도 같은 폭·형식으로 구워서 넣는다:
 *     node -e "require('sharp')('원본.png').resize({width:820}).webp({quality:80}).toFile('public/intro/cast/ai.webp')"
 */

import Image from "next/image";
import { useCallback, useRef, useState } from "react";
import styles from "./intro.module.css";

type Role = {
  tag: string;
  name: string;
  line: string;
  /** 강조색. hex 와 "r,g,b" 를 함께 둔다 — rgba(var(--accent-rgb), .3) 로 쓰려면 후자가 필요하다 */
  accent: string;
  accentRgb: string;
  art: string;
  alt: string;
};

/**
 * 배역 — 한 줄씩. 승리 조건만 적는다.
 * 셋 다 **처형된 한 명이 누구였나** 하나로 갈린다 (worker/src/roundtable.ts 의
 * decideWinner). 아무도 처형하지 못한 판은 AI 승이다.
 *
 * ★ 2026-08-08: 실제로 도는 3D 월드와 대조해 두 줄을 고쳤다.
 *   · 시민 — "질문하고 의심한다" 는 2D 흐름(서면 공통 질문 · 지목 질문)의 말이다.
 *     **월드에는 질문 단계가 없다** — 같은 주제에 다같이 말하고 자유 대화로 넘어간다
 *     (rules.tsx 머리말 「두 무대는 별개다」). 월드 역할 카드와 같은 말로 맞춘다
 *     (app/world/game-hud.tsx 의 ROLE_CARD.citizen).
 *   · 연기자 — **없는 판이 정상이다.** 수는 0~상한 균등 랜덤이고 사람이 3명 이하면
 *     아예 0명이다 (roundtable.ts 의 pickActors · actorCap). 셋이 늘 있는 것처럼
 *     적으면 첫 판에서 "연기자가 어디 갔지"가 된다. **몇인지는 여전히 적지 않는다** —
 *     연기자는 수도 자리도 비밀이다 (AI 만 수가 공개다, §15-3).
 */
const roles: Role[] = [
  {
    tag: "AI",
    name: "AI",
    line: "사람인 척한다. 시민이 처형되거나 아무도 처형되지 않으면 승리.",
    accent: "#00ff66",
    accentRgb: "0,255,102",
    art: "/intro/cast/ai.webp",
    alt: "후드를 쓴 검은 코트 차림의 기계. 가면 눈이 초록으로 빛난다",
  },
  {
    tag: "Actor",
    name: "연기자",
    line: "사람이면서 AI인 척한다. 연기자 중 누구든 처형되면 승리 — 없는 판도 있다.",
    accent: "#d4a373",
    accentRgb: "212,163,115",
    art: "/intro/cast/actor.webp",
    alt: "중절모를 눌러쓴 코트 차림의 사람이 입에 손가락을 대고 조용히 하라는 시늉을 한다",
  },
  {
    tag: "Citizen",
    name: "시민",
    line: "대화로 AI 같은 사람을 찾아 지목한다. 진짜 AI를 처형하면 승리.",
    accent: "#7dd3fc",
    accentRgb: "125,211,252",
    art: "/intro/cast/citizen.webp",
    alt: "검은 재킷을 입고 주머니에 손을 넣은 채 이쪽을 보고 서 있는 사람",
  },
];

/** 밀어서 넘겼다고 볼 거리(px). 이보다 짧으면 제자리로 돌아온다 */
const SWIPE_THRESHOLD = 44;
/** 끌 때 그림이 따라오는 비율과 최대 거리. 손에 붙은 느낌만 주고 판을 흔들지는 않는다 */
const DRAG_FOLLOW = 0.32;
const DRAG_MAX = 56;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export function CastDeck() {
  const [active, setActive] = useState(0);
  const [drag, setDrag] = useState(0);
  /** 끌기 시작한 x. null 이면 끌고 있지 않다 */
  const startX = useRef<number | null>(null);

  /*
   * ★ 양끝에서 감지 않는다(0 ←→ 2 순환 없음). 셋뿐이라 순환시키면 마지막에서 처음으로
   *   갈 때 그림이 **밀던 방향과 반대로** 날아간다 — 자리 감각이 무너진다.
   *   대신 끝에서는 제자리로 돌아오므로 "여기가 끝"이 손으로 읽힌다.
   */
  const go = useCallback((delta: number) => {
    setActive((prev) => clamp(prev + delta, 0, roles.length - 1));
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    startX.current = e.clientX;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (startX.current === null) return;
    const dx = e.clientX - startX.current;
    setDrag(clamp(dx * DRAG_FOLLOW, -DRAG_MAX, DRAG_MAX));
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (startX.current === null) return;
    const dx = e.clientX - startX.current;
    startX.current = null;
    setDrag(0);
    if (Math.abs(dx) >= SWIPE_THRESHOLD) go(dx < 0 ? 1 : -1);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      go(1);
    }
  };

  const current = roles[active];

  return (
    <div
      className="mt-14 grid gap-10 lg:mt-16 lg:grid-cols-[1fr_minmax(0,21rem)] lg:items-center lg:gap-16"
      style={{ "--accent": current.accent, "--accent-rgb": current.accentRgb } as React.CSSProperties}
    >
      {/* ── 왼쪽: 배역 셋 ─────────────────────────────────────────────── */}
      {/*
        탭 목록이다 — 화살표로도 넘어간다. role="tab" 을 쓰는 이상 선택은
        aria-selected 가 말해야 하고, 그래서 켜진 모양도 CSS 가 그 속성으로 잡는다
        (클래스를 따로 붙이면 둘이 갈린다).
      */}
      <div
        className="order-2 flex flex-col gap-3 lg:order-1"
        role="tablist"
        aria-label="배역"
        aria-orientation="vertical"
        onKeyDown={onKeyDown}
      >
        {roles.map((role, i) => (
          <button
            key={role.name}
            type="button"
            role="tab"
            id={`cast-tab-${i}`}
            aria-selected={i === active}
            aria-controls="cast-stage"
            tabIndex={i === active ? 0 : -1}
            onClick={() => setActive(i)}
            className={styles.castRow}
            style={
              { "--accent": role.accent, "--accent-rgb": role.accentRgb } as React.CSSProperties
            }
          >
            {/*
              ★ 영문 라벨(AI · ACTOR · CITIZEN) 알약을 뺐다 (사용자 지정 2026-08-08).
                같은 말을 두 번 적는 자리였고, 알약 너비가 배역마다 달라서 **이름 셋의
                왼쪽 끝이 어긋났다.** 지금은 이름과 설명이 같은 세로선에서 시작한다.
                영문 이름은 오른쪽 액자 이름표(castCaption)에 한 번만 남는다.
            */}
            <span className={styles.castName}>{role.name}</span>
            <span className={styles.castLine}>{role.line}</span>
          </button>
        ))}
      </div>

      {/* ── 오른쪽: 인물 ──────────────────────────────────────────────── */}
      <div className="order-1 lg:order-2">
        <div
          id="cast-stage"
          role="tabpanel"
          aria-labelledby={`cast-tab-${active}`}
          tabIndex={0}
          className={styles.castStage}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
        >
          {roles.map((role, i) => (
            <div
              key={role.name}
              className={styles.castPlate}
              data-active={i === active}
              aria-hidden={i !== active}
              style={
                {
                  // 고른 것만 가운데 서고 나머지는 제 순서 쪽으로 비켜서 있다.
                  // 끌고 있는 동안에는 고른 것만 손을 따라간다.
                  "--off": `${(i - active) * 14}%`,
                  "--drag": i === active ? `${drag}px` : "0px",
                  "--accent-rgb": role.accentRgb,
                } as React.CSSProperties
              }
            >
              <Image
                src={role.art}
                alt={role.alt}
                width={820}
                height={1230}
                sizes="(min-width: 1024px) 21rem, 100vw"
                className={styles.castImg}
                draggable={false}
                priority={i === 0}
              />
              {/* 그림마다 배경이 다르다(회색·연녹색). 가장자리를 페이지 색으로 눌러 셋을 한 화면으로 묶는다 */}
              <div aria-hidden className={styles.castShade} />
              <div aria-hidden className={styles.castTint} />
            </div>
          ))}

          {/* 이름표 — 그림 위에 얹는다. 왼쪽 목록을 안 보고도 지금 누구인지 알 수 있게 */}
          <div className={styles.castCaption}>
            <span className={styles.castCaptionTag}>{current.tag}</span>
            <span className={styles.castCaptionName}>{current.name}</span>
          </div>
        </div>

        {/* 어디쯤인지. 「← 밀어서 넘기기 →」 안내는 뺐다 (사용자 지정 2026-08-08) */}
        <div className="mt-5 flex items-center justify-center gap-1.5">
          {roles.map((role, i) => (
            <button
              key={role.name}
              type="button"
              aria-label={`${role.name} 보기`}
              onClick={() => setActive(i)}
              className={styles.castDot}
              data-on={i === active}
              style={{ "--accent": role.accent } as React.CSSProperties}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
