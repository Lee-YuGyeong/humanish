/**
 * 머리말 띠 — **로비와 방이 같은 띠를 쓴다.** 소유: C
 *
 * ┌─ 껍데기만 공용이다 ────────────────────────────────────────────────────┐
 * │ 이 컴포넌트가 정하는 것은 띠의 **생김새**뿐이다 — 높이 · 배경 · 아래 선  │
 * │ · 좌우 여백 · 안에서 쓰는 색(top-bar.module.css).                       │
 * │ **안에 무엇이 드는가는 부르는 쪽이 정한다.** 화면마다 달라야 하기        │
 * │ 때문이다 — 로비는 제목과 계정, 대기실은 나가기·방 이름·코드·인원.       │
 * │                                                                        │
 * │ 왜 만들었나: 예전에는 두 화면이 각자 <header> 를 들고 있었고 팔레트도    │
 * │ 각자였다. 그래서 방에 들어가는 순간 같은 자리의 띠가 다른 색·다른 두께로 │
 * │ 바뀌어, 같은 앱인데 화면이 갈아끼워진 것처럼 보였다.                    │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * 안쪽은 `justify-between` 이다 — 왼쪽 덩어리와 오른쪽 덩어리, 둘을 넣는다.
 * 덩어리 안의 간격은 화면마다 달라서 여기서 정하지 않는다.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import styles from "./top-bar.module.css";

export function TopBar({ children }: { children: ReactNode }) {
  return (
    <header
      className={`${styles.bar} flex h-12 shrink-0 items-center justify-between gap-4 px-4 sm:px-8`}
    >
      {children}
    </header>
  );
}

/**
 * 머리말의 화면 탭 — 「게임 로비」와 「기록」 (2026-08-07).
 *
 * ┌─ 왜 여기 있나 ─────────────────────────────────────────────────────────┐
 * │ 「기록」은 로비 머리말에 **글자로만** 있었다. 눌러도 아무 데도 안 가는   │
 * │ 탭이라, 화면에는 있는데 없는 기능이었다. 기록 화면 자체는 그동안        │
 * │ /account/history 에 있었고 들어가는 길은 왼쪽 기둥의 작은 링크 하나뿐   │
 * │ 이었다 — 그 둘을 여기서 잇는다.                                        │
 * │                                                                        │
 * │ 목록을 **두 화면이 같이 읽는다.** 각자 적으면 한쪽에만 탭이 늘거나,     │
 * │ 켜진 탭이 두 화면에서 다른 자리를 가리키게 된다.                       │
 * └────────────────────────────────────────────────────────────────────────┘
 */
const MAIN_TABS = [
  { key: "lobby", label: "게임 로비", href: "/main" },
  { key: "history", label: "기록", href: "/account/history" },
] as const;

export type MainTab = (typeof MAIN_TABS)[number]["key"];

export function MainTabs({ active }: { active: MainTab }) {
  return (
    <nav className="hidden gap-8 sm:flex">
      {MAIN_TABS.map((tab) => {
        const on = tab.key === active;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            className={`text-[0.66rem] uppercase tracking-[0.18em] no-underline transition-colors ${
              on ? "border-b pb-0.5" : "hover:opacity-80"
            }`}
            style={
              on
                ? { color: "var(--accent)", borderColor: "var(--accent)" }
                : { color: "var(--dim)" }
            }
            aria-current={on ? "page" : undefined}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * 머리말에 뜨는 **내 이름.** 로비의 계정 메뉴와 대기실이 이걸 같이 쓴다 —
 * 두 벌로 갈리면 방에 들어갈 때 같은 이름이 다른 크기·다른 색으로 다시 그려진다.
 *
 * ★ 여기는 **계정 이름**만 온다. 자리에 붙는 이름('익명N')은 이 자리에 오지 않는다 —
 *   그건 게임 안에서 남들이 나를 부르는 이름이고, 이 자리가 말하는 것은
 *   "지금 로그인한 사람"이다 (SPEC §15-2-결정).
 */
export function AccountName({ name }: { name: string }) {
  return (
    <span className={styles.name}>
      <Avatar name={name} size={26} />
      {name}
    </span>
  );
}

/**
 * 이니셜 아바타. 외부 이미지 호스트에 의존하지 않는다 (시안은 원격 URL을 썼다).
 *
 * ★ 머리말 밖에서도 쓴다 — /main 의 왼쪽 기둥이 같은 것을 큰 크기로 그린다.
 *   그래서 색을 물려받지 않고 직접 적어 두었다 (top-bar.module.css).
 */
export function Avatar({ name, size }: { name: string; size: number }) {
  return (
    <span aria-hidden className={styles.avatar} style={{ width: size, height: size }}>
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}
