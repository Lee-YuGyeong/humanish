"use client";

/**
 * 「기록」 탭의 속 — 내 전판을 최신순으로. 소유: A (SPEC §15-2-결정)
 *
 * ┌─ 화면을 떠나지 않는다 (2026-08-07 결정) ──────────────────────────────────┐
 * │ 예전에는 /account/history 라는 **다른 화면**이었다. 머리말도 팔레트도      │
 * │ 따로여서, 탭을 누르면 로비가 통째로 사라지고 다른 앱처럼 생긴 페이지가     │
 * │ 떴다가 「← 로비로」로 되돌아와야 했다.                                     │
 * │ 이제 이건 **로비 가운데 칸의 다른 내용**일 뿐이다 — 머리말도 왼쪽 기둥도   │
 * │ 그대로 있고, 방 목록이 있던 자리만 이걸로 바뀐다 (lobby.tsx 의 tab).       │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 색·짜임은 **로비 것 그대로**다 (lobby.module.css). 같은 화면 안이라 여기서
 *   따로 팔레트를 잡으면 가운데 칸만 다른 앱이 된다.
 * ★ **내 행만 그린다** (lib/game/types.ts 의 RecentMatch 상자 — I1). 같은 판의
 *   남들 행은 애초에 라우트가 주지 않는다.
 * ★ 왼쪽 기둥의 「최근 게임」과 같은 값을 읽는다 (/api/profile/stats). 거기는
 *   다섯 줄이고 여기가 끝까지다 — 합계를 두 군데서 따로 세지 않는다.
 */

import { useState } from "react";

import { useMatchHistory, useProfileStats } from "@/lib/queries/auth";
import styles from "./lobby.module.css";
// 판 문구·역할 이름·경과 시간은 왼쪽 기둥과 **같은 것을 읽는다** (./match-label.ts)
import { MATCH_LABEL, ROLE_NAME, timeAgo } from "./match-label";

export function HistoryPanel() {
  const { data: stats } = useProfileStats();
  const history = useMatchHistory();

  // 마운트할 때 한 번만 읽는다 — 왼쪽 기둥과 같은 이유 (렌더마다 부르면 문구가 흔들린다)
  const [now] = useState(() => Date.now());

  const matches = history.data?.pages.flatMap((p) => p.matches) ?? [];

  return (
    <div className="flex flex-1 flex-col">
      {/*
        ── 합계 한 줄 ───────────────────────────────────────────────────
        방 목록의 도구 띠와 **같은 자리·같은 높이**다. 화면을 바꾸는 게 아니라
        가운데 칸만 바뀌는 것이라, 위아래 경계가 어긋나면 화면이 갈린 것처럼 보인다.

        ★ 네모 칸 네 개를 세우지 않는다. 숫자 넷을 각각 상자에 넣으면 **읽을 것이
          늘 뿐 뜻은 그대로**다 — 이 화면은 표 하나를 보러 오는 자리다.
          레벨과 EXP 는 붙여 놓는다. 서로를 설명하는 값이라 떨어뜨릴 이유가 없다.
      */}
      <div className="shrink-0 border-b px-5 py-4 sm:px-8" style={{ borderColor: "var(--border)" }}>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <span
            className={`${styles.mono} text-[0.86rem] font-bold`}
            style={{ color: "var(--accent)" }}
          >
            LV {stats?.level ?? "–"}
          </span>

          {/* EXP 막대 — 왼쪽 기둥과 같은 표기(이번 레벨에서 몇/몇)다 */}
          <div className="flex min-w-[120px] max-w-[200px] flex-1 items-center gap-2">
            <div className="h-0.5 flex-1" style={{ background: "var(--border2)" }}>
              <div
                className="h-full"
                style={{
                  width: `${Math.round((stats?.level_ratio ?? 0) * 100)}%`,
                  background: "var(--accent)",
                  boxShadow: "0 0 6px var(--accent-glow)",
                }}
              />
            </div>
            <span className={`${styles.mono} text-[0.7rem]`} style={{ color: "var(--muted)" }}>
              {stats ? `${stats.level_into}/${stats.level_need}` : "–"}
            </span>
          </div>

          {/*
            판수 · 승 · 승률 한 줄. 한 판도 없으면 승률이 null 이다 — 0% 로 접으면
            아직 안 해 본 사람과 다 진 사람이 같아 보인다 (lib/game/types.ts).
          */}
          <span className={`${styles.mono} ml-auto text-[0.76rem]`} style={{ color: "var(--muted)" }}>
            {stats ? (
              <>
                {stats.games}판 · {stats.wins}승 ·{" "}
                <span style={{ color: "var(--text)" }}>
                  {stats.win_rate == null ? "–" : `${Math.round(stats.win_rate * 100)}%`}
                </span>
              </>
            ) : (
              "…"
            )}
          </span>
        </div>
      </div>

      <div className="flex-1 px-5 py-5 sm:px-8">
        {/* ── 목록 머리 ── 방 목록과 같은 규약: 머리와 줄이 같은 클래스를 쓴다 */}
        <div
          className={styles.matchRow}
          style={{ background: "transparent", border: "none", padding: "0.5rem 1.2rem" }}
        >
          {/* 번호는 방 목록과 같다 — 세어 보여줄 뿐이라 누를 것이 없다 */}
          <div className={styles.label}>번호</div>
          <div className={styles.label}>역할</div>
          <div className={styles.label}>결과</div>
          <div className={styles.label} style={{ textAlign: "right" }}>
            인원
          </div>
          <div className={styles.label} style={{ textAlign: "right" }}>
            exp
          </div>
          <div className={styles.label} style={{ textAlign: "right" }}>
            시간
          </div>
        </div>

        <div className="mt-1 flex flex-col gap-1">
          {history.isLoading ? (
            [0, 1, 2].map((i) => (
              <div key={i} className={styles.matchRow} style={{ opacity: 0.5 }}>
                <div className="h-3 w-4 animate-pulse" style={{ background: "var(--surface3)" }} />
                <div className="h-3 w-10 animate-pulse" style={{ background: "var(--surface3)" }} />
                <div className="h-3 w-24 animate-pulse" style={{ background: "var(--surface3)" }} />
                <div className="h-3 w-8 animate-pulse justify-self-end" style={{ background: "var(--surface3)" }} />
                <div className="h-3 w-6 animate-pulse justify-self-end" style={{ background: "var(--surface3)" }} />
                <div className="h-3 w-12 animate-pulse justify-self-end" style={{ background: "var(--surface3)" }} />
              </div>
            ))
          ) : history.isError ? (
            <div
              role="alert"
              className="px-4 py-3 text-[0.81rem]"
              style={{
                border: "1px solid rgba(255,59,48,0.3)",
                background: "var(--red-dim)",
                color: "var(--red)",
              }}
            >
              기록을 읽지 못했다 —{" "}
              {history.error instanceof Error ? history.error.message : "알 수 없는 오류"}
            </div>
          ) : matches.length === 0 ? (
            <div
              className="flex flex-col items-center gap-3 border border-dashed px-6 py-14 text-center"
              style={{ borderColor: "var(--border2)" }}
            >
              <p className="text-[0.88rem]" style={{ color: "var(--muted)" }}>
                아직 끝낸 판이 없다
              </p>
              {/* 왜 비어 있는지를 같이 적는다 — 혼자 만든 방은 세지 않는다 (SPEC §15-2-결정) */}
              <p className="text-[0.74rem]" style={{ color: "var(--dim)" }}>
                사람이 둘 이상인 방부터 기록에 남는다
              </p>
            </div>
          ) : (
            matches.map((m, i) => (
              <div key={m.room_id} className={styles.matchRow}>
                {/* 최신이 1번이다. 목록 순서를 세는 수지 판 번호가 아니다 */}
                <span className={`${styles.mono} text-[0.72rem]`} style={{ color: "var(--dim)" }}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className={styles.tag}>{ROLE_NAME[m.role]}</span>
                {/*
                  ★ 「승리/패배」라고 적지 않는다. 그건 결과를 한 번 더 번역한 말이고,
                    왼쪽 기둥은 이미 "AI 적중 · 연기 성공" 처럼 **그 판에서 무슨 일이
                    있었는지**로 부른다 (match-label.ts). 같은 판을 두 자리에서 다른
                    말로 부르지 않는다. 이긴 판인지는 색이 말한다.
                */}
                <span
                  className="truncate text-[0.84rem]"
                  style={{ color: m.won ? "var(--accent)" : "var(--red)" }}
                >
                  {MATCH_LABEL[m.role][m.won ? "won" : "lost"]}
                </span>
                <span
                  className={`${styles.mono} text-right text-[0.74rem]`}
                  style={{ color: "var(--muted)" }}
                >
                  {m.humans}
                </span>
                {/* 진 판은 -1 이다 (2026-08-07, lib/server/match.ts) — 0 으로 접지 않는다 */}
                <span
                  className={`${styles.mono} text-right text-[0.8rem] font-bold`}
                  style={{ color: m.won ? "var(--accent)" : "var(--red)" }}
                >
                  {m.score > 0 ? `+${m.score}` : String(m.score)}
                </span>
                <span
                  className="text-right text-[0.72rem]"
                  style={{ color: "var(--dim)" }}
                  title={m.created_at}
                >
                  {timeAgo(m.created_at, now)}
                </span>
              </div>
            ))
          )}
        </div>

        {/* 더 보기 — next 커서가 남아 있을 때만 (lib/server/match.ts 의 readMatchHistory) */}
        {history.hasNextPage ? (
          <button
            type="button"
            className={styles.btnGhost}
            style={{ width: "100%", marginTop: "0.75rem", padding: "0.7rem" }}
            disabled={history.isFetchingNextPage}
            onClick={() => void history.fetchNextPage()}
          >
            {history.isFetchingNextPage ? "읽는 중…" : "더 보기"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
