/**
 * 방 · 페이즈 점검. 소유: A (SPEC §2, §5, §12.1, §12.5)
 *
 * 게임 화면이 아니다. 상태머신이 어디서 멈췄는지 눈으로 보려고 두는 내부 화면이다.
 * 데이터는 /api/admin/rooms 하나에서만 온다. 이 폴더(app/admin) 밖은 건드리지 않는다.
 *
 * ★ is_bot은 이 화면에도 내리지 않는다 (I1). 답변 수·투표 수도 마찬가지다 —
 *   봇은 페이즈 진입 순간 한꺼번에 답하고 투표하므로 그 개수가 곧 봇 수다.
 *   이유는 app/api/admin/rooms/route.ts 주석에 적어뒀다.
 *
 * ★ 여기 카운트다운은 표시용이다 (I2). 만료 판정은 서버가 DB now()로 한다.
 *   화면의 "만료 n초 지남"은 워치독이 아직 안 잡았다는 신호일 뿐 판정이 아니다.
 */
"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminRoom } from "@/app/api/admin/rooms/route";

interface Snapshot {
  now: string;
  app_now: string;
  drift_ms: number;
  rooms: AdminRoom[];
}

/** 폴링 주기. 워치독이 15초마다 도니 그보다 촘촘하면 전환을 놓치지 않는다. */
const POLL_MS = 3_000;

/**
 * 이만큼 지나도 안 넘어간 방은 워치독이 안 도는 것으로 본다.
 * pg_cron이 15초 주기라 그 두 배를 준다 (SPEC §12.1, §13-3).
 */
const WATCHDOG_GRACE_MS = 30_000;

const PHASE_LABEL: Record<AdminRoom["phase"], string> = {
  lobby: "대기",
  question: "공통 질문",
  target: "지목 질문",
  chat: "자유 채팅",
  vote: "투표",
  reveal: "공개",
  replay: "재시작",
};

/**
 * 페이즈 색. 창고 팔레트에서만 고른다 (app/globals.css).
 * 진행 중인 페이즈일수록 조명이 세지고, 투표에서 비상등이 켜진다.
 */
const PHASE_STYLE: Record<AdminRoom["phase"], string> = {
  lobby: "text-ash",
  question: "text-bounce",
  target: "text-bounce",
  chat: "text-tung",
  vote: "lit-signal",
  reveal: "lit-tung",
  replay: "text-grime",
};

function formatRemaining(ms: number): string {
  const sec = Math.round(Math.abs(ms) / 1000);
  const body = sec >= 60 ? `${Math.floor(sec / 60)}분 ${sec % 60}초` : `${sec}초`;
  return ms >= 0 ? body : `만료 ${body} 지남`;
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export default function AdminPage() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);

  /**
   * 폴링 사이를 메우는 로컬 경과 시간(ms). 서버가 준 remaining_ms에서 이만큼 뺀다.
   * 표시용이라 클라이언트 시계를 써도 된다 (I2). 다음 폴링이 오면 0으로 돌아간다.
   */
  const [elapsed, setElapsed] = useState(0);
  const fetchedAt = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/admin/rooms", { cache: "no-store" });
      const body = (await res.json()) as Snapshot & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);

      fetchedAt.current = Date.now();
      setElapsed(0);
      setSnap(body);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    if (!live) return;

    const poll = setInterval(() => void load(), POLL_MS);
    const tick = setInterval(() => {
      if (fetchedAt.current) setElapsed(Date.now() - fetchedAt.current);
    }, 1_000);

    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load, live]);

  const rooms = snap?.rooms ?? [];
  const remainingOf = (r: AdminRoom): number | null =>
    r.remaining_ms === null ? null : r.remaining_ms - elapsed;

  // 만료했는데 아직 안 넘어간 방. 하나라도 있으면 워치독을 의심한다.
  const stuck = rooms.filter((r) => {
    const left = remainingOf(r);
    return left !== null && left < -WATCHDOG_GRACE_MS;
  });

  return (
    <main className="min-h-screen text-bone">
      <div className="mx-auto max-w-5xl px-6 py-16">
        <Link
          href="/"
          className="stencil text-[10px] text-grime transition-colors hover:text-tung"
        >
          ← manifest
        </Link>

        <header className="mt-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="stencil text-[10px] text-signal/70">admin</p>
            <h1 className="engraved mt-2 text-3xl font-black">방 · 페이즈 점검</h1>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setLive((v) => !v)}
              className="case case-live stencil px-3.5 py-2 text-[9px] text-dust"
            >
              {live ? `자동 새로고침 켜짐 (${POLL_MS / 1000}초)` : "자동 새로고침 꺼짐"}
            </button>
            <button
              type="button"
              onClick={() => void load()}
              className="case case-live stencil px-3.5 py-2 text-[9px] text-dust"
            >
              지금 새로고침
            </button>
          </div>
        </header>

        {/* 시계 — 기준은 DB 하나다 (SPEC §12.5) */}
        {snap && (
          <dl className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="DB 시각" value={formatClock(snap.now)} mono />
            <Stat label="앱 서버 시각" value={formatClock(snap.app_now)} mono />
            <Stat
              label="시계 어긋남"
              value={`${snap.drift_ms >= 0 ? "+" : ""}${(snap.drift_ms / 1000).toFixed(2)}초`}
              mono
              tone={Math.abs(snap.drift_ms) > 1_000 ? "warn" : "plain"}
            />
            <Stat label="방" value={`${rooms.length}개`} />
          </dl>
        )}

        {error && (
          <p className="mt-6 rounded-lg border border-signal/30 bg-signal/10 p-4 text-sm text-signal">
            불러오지 못했다 — {error}
          </p>
        )}

        {stuck.length > 0 && (
          <p className="mt-6 rounded-lg border border-signal/40 bg-signal/10 p-4 text-sm text-signal shadow-[0_0_30px_-12px_rgba(255,51,32,0.9)]">
            <span className="font-semibold">
              만료했는데 안 넘어간 방이 {stuck.length}개 있다
            </span>{" "}
            ({stuck.map((r) => r.code).join(", ")}). pg_cron 워치독이 안 도는 것일 수 있다 —
            Supabase 대시보드에서 pg_cron 확장을 켜고{" "}
            <code className="font-mono text-xs">supabase/functions/advance_phase.sql</code>을 다시
            적용한다 (SPEC §12.1).
          </p>
        )}

        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-bone/10 text-left">
                <th className="stencil py-2 pr-3 text-[8px] text-ash">코드</th>
                <th className="stencil py-2 pr-3 text-[8px] text-ash">페이즈</th>
                <th className="stencil py-2 pr-3 text-[8px] text-ash">라운드</th>
                <th className="stencil py-2 pr-3 text-[8px] text-ash">남은 시간</th>
                <th className="stencil py-2 pr-3 text-[8px] text-ash">좌석</th>
                <th className="stencil py-2 pr-3 text-[8px] text-ash">역할</th>
                <th className="stencil py-2 pr-3 text-[8px] text-ash">phase_seq</th>
                <th className="stencil py-2 pr-3 text-[8px] text-ash">roster_seq</th>
                <th className="stencil py-2 text-[8px] text-ash">만든 시각</th>
              </tr>
            </thead>
            <tbody>
              {rooms.map((r) => {
                const left = remainingOf(r);
                const overdue = left !== null && left < 0;

                return (
                  <tr key={r.id} className="border-b border-bone/5 align-middle">
                    <td className="readout py-2.5 pr-3 text-sm tracking-[0.2em] text-linen">{r.code}</td>
                    <td className="py-2.5 pr-3">
                      <span className={`stencil text-[9px] ${PHASE_STYLE[r.phase]}`}>
                        {PHASE_LABEL[r.phase]}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 text-dust">
                      {r.round === 0 ? "—" : r.round}
                    </td>
                    <td
                      className={`readout py-2.5 pr-3 ${
                        overdue ? "font-semibold text-signal" : "text-dust"
                      }`}
                    >
                      {left === null ? "조작 대기" : formatRemaining(left)}
                    </td>
                    <td className="readout py-2.5 pr-3 text-dust">
                      {r.seated} / {r.capacity}
                    </td>
                    <td className="py-2.5 pr-3">
                      {r.roles_assigned ? (
                        <span className="stencil text-[9px] text-tung">배정됨</span>
                      ) : (
                        <span className="text-ash">—</span>
                      )}
                    </td>
                    <td className="readout py-2.5 pr-3 text-grime">{r.phase_seq}</td>
                    <td className="readout py-2.5 pr-3 text-grime">{r.roster_seq}</td>
                    <td className="readout py-2.5 text-[11px] text-ash">
                      {formatClock(r.created_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {snap && rooms.length === 0 && (
            <p className="rounded-lg border border-dashed border-bone/15 p-6 text-center text-sm text-grime">
              방이 없다.{" "}
              <Link href="/main" className="text-tung underline">
                메인 로비
              </Link>
              에서 하나 만든다.
            </p>
          )}
          {!snap && !error && (
            <p className="p-6 text-center text-sm text-grime">불러오는 중…</p>
          )}
        </div>

        <div className="mt-10 space-y-2 text-xs text-grime">
          <p>
            <span className="text-dust">읽기 전용이다.</span> 여기서 페이즈를 넘기지 않는다 —
            전환은 /api/phase/advance 하나뿐이고 쿠키로 되찾은 player_id를 요구한다 (I9).
          </p>
          <p>
            <span className="text-dust">봇은 이 화면에도 안 나온다 (I1).</span> is_bot도,
            답변·투표 개수도 내려받지 않는다. 봇은 페이즈에 들어가는 순간 한꺼번에 답하고
            투표하므로 그 개수가 곧 봇 수다.
          </p>
          <p>카운트다운은 표시용이다 (I2). 만료 판정은 서버가 DB now()로 한다.</p>
        </div>
      </div>
    </main>
  );
}

function Stat({
  label,
  value,
  mono,
  tone = "plain",
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: "plain" | "warn";
}) {
  return (
    <div
      className={`rounded-lg p-3 ${
        tone === "warn" ? "border border-tung/40 bg-tung/10" : "case"
      }`}
    >
      <dt className="stencil text-[8px] text-ash">{label}</dt>
      <dd
        className={`mt-1.5 text-base ${mono ? "readout" : ""} ${
          tone === "warn" ? "text-tung" : "text-bone"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
