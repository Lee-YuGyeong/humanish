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

import type { MatchRecord } from "@/lib/game/types";
import { useMatchHistory, useProfileStats } from "@/lib/queries/auth";
import styles from "./lobby.module.css";

/**
 * 역할 이름. 'spy'(옛 2D 판)와 'actor'(월드 판)는 같은 역할의 옛/새 이름이라 같은
 * 문구로 접는다 (§18.2 — 지난 행은 고쳐 쓰지 않는다).
 */
const ROLE_NAME: Record<MatchRecord["role"], string> = {
  citizen: "시민",
  spy: "연기자",
  actor: "연기자",
};

/**
 * 얼마 전인지. 표시용이라 클라이언트 시계를 써도 된다 — I2 는 페이즈 전환 판정의
 * 규칙이다. 미래로 나오면 '방금'으로 접는다. (왼쪽 기둥 timeAgo 와 같은 규칙)
 */
function timeAgo(iso: string, now: number): string {
  const min = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(min) || min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간 전`;
  return `${Math.floor(hour / 24)}일 전`;
}

export function HistoryPanel() {
  const { data: stats } = useProfileStats();
  const history = useMatchHistory();

  // 마운트할 때 한 번만 읽는다 — 왼쪽 기둥과 같은 이유 (렌더마다 부르면 문구가 흔들린다)
  const [now] = useState(() => Date.now());

  const matches = history.data?.pages.flatMap((p) => p.matches) ?? [];

  return (
    <div className="flex flex-1 flex-col">
      {/*
        ── 합계 띠 ─────────────────────────────────────────────────────
        방 목록의 도구 띠와 **같은 자리**다. 화면을 바꾸는 게 아니라 가운데 칸만
        바뀌는 것이라, 위아래 경계가 같은 높이에 있어야 탭이 갈아끼워진 것으로 읽힌다.
      */}
      <div className="shrink-0 border-b px-5 py-4 sm:px-8" style={{ borderColor: "var(--border)" }}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
          <Stat label="판수" value={stats ? String(stats.games) : "–"} />
          <Stat label="승" value={stats ? String(stats.wins) : "–"} />
          {/* 한 판도 없으면 win_rate 가 null 이다. 0% 로 접으면 아직 안 해 본 사람과
              다 진 사람이 같아 보인다 (lib/game/types.ts) */}
          <Stat
            label="승률"
            value={
              stats?.win_rate == null ? "–" : `${Math.round(stats.win_rate * 100)}%`
            }
          />
          <Stat label="레벨" value={stats ? `LV ${stats.level}` : "–"} />

          {/* EXP 막대 — 왼쪽 기둥과 같은 표기(이번 레벨에서 몇/몇)다 */}
          <div className="ml-auto flex min-w-[180px] flex-1 flex-col justify-center gap-1 sm:max-w-[260px]">
            <div className="flex items-baseline justify-between">
              <span className={styles.label}>exp</span>
              <span className={`${styles.mono} text-[0.72rem]`} style={{ color: "var(--muted)" }}>
                {stats ? `${stats.level_into}/${stats.level_need}` : "–"}
              </span>
            </div>
            <div className="h-0.5" style={{ background: "var(--border2)" }}>
              <div
                className="h-full"
                style={{
                  width: `${Math.round((stats?.level_ratio ?? 0) * 100)}%`,
                  background: "var(--accent)",
                  boxShadow: "0 0 6px var(--accent-glow)",
                }}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 px-5 py-5 sm:px-8">
        {/* ── 목록 머리 ── 방 목록과 같은 규약: 머리와 줄이 같은 클래스를 쓴다 */}
        <div
          className={styles.matchRow}
          style={{ background: "transparent", border: "none", padding: "0.5rem 1.2rem" }}
        >
          <span />
          <div className={styles.label}>역할</div>
          <div className={styles.label}>결과</div>
          <div className={styles.label}>사람</div>
          <div className={styles.label} style={{ textAlign: "right" }}>
            exp
          </div>
          <div className={styles.label} style={{ textAlign: "right" }}>
            언제
          </div>
        </div>

        <div className="mt-1 flex flex-col gap-1">
          {history.isLoading ? (
            [0, 1, 2].map((i) => (
              <div key={i} className={styles.matchRow} style={{ opacity: 0.5 }}>
                <span />
                <div className="h-3 w-10 animate-pulse" style={{ background: "var(--surface3)" }} />
                <div className="h-3 w-24 animate-pulse" style={{ background: "var(--surface3)" }} />
                <div className="h-3 w-8 animate-pulse" style={{ background: "var(--surface3)" }} />
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
            matches.map((m) => (
              <div key={m.room_id} className={styles.matchRow}>
                <span
                  aria-hidden
                  className={`${styles.dot} ${m.won ? styles.dotGreen : styles.dotRed}`}
                />
                <span className={`${styles.tag} ${m.role === "citizen" ? "" : styles.tagGreen}`}>
                  {ROLE_NAME[m.role]}
                </span>
                <span
                  className="text-[0.84rem] font-semibold"
                  style={{ color: m.won ? "var(--accent)" : "var(--red)" }}
                >
                  {m.won ? "승리" : "패배"}
                </span>
                <span className={`${styles.mono} text-[0.74rem]`} style={{ color: "var(--muted)" }}>
                  {m.humans}명
                </span>
                {/* 진 판은 -1 이다 (2026-08-07, lib/server/match.ts) — 0 으로 접지 않는다 */}
                <span
                  className={`${styles.mono} text-right text-[0.82rem] font-bold`}
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

/** 합계 한 칸. 왼쪽 기둥의 Stat 과 같은 모양이지만 가로로 눕는다 */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={`${styles.inset} flex min-w-[74px] flex-col items-center gap-0.5 px-3 py-2`}>
      <span className={styles.label}>{label}</span>
      <span className={`${styles.mono} text-[0.86rem] font-bold`}>{value}</span>
    </div>
  );
}
