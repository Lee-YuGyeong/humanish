'use client';

/**
 * 게임 기록 — 내 전판을 최신순으로. 소유: A (SPEC §15-2-결정)
 *
 * 위에는 로비 왼쪽 기둥과 같은 합계(판수 · 승 · 승률 · 레벨), 아래에는 한 판에
 * 한 줄씩. 로비는 최근 다섯 줄만 그리고, 끝까지 읽는 화면은 여기 하나다
 * (GET /api/profile/matches — 쪽 단위, 「더 보기」로 이어 받는다).
 *
 * ★ **내 행만 그린다** (lib/game/types.ts 의 RecentMatch 상자 — I1).
 *   같은 판의 남들 행은 애초에 라우트가 주지 않는다.
 * ★ 색·짜임은 로비(lobby.module.css)와 같은 계열로 맞춘다 — 로비에서 들어와서
 *   로비로 돌아가는 화면이라, 팔레트가 바뀌면 다른 앱처럼 보인다.
 */

import { useState } from 'react';

import { AccountName, MainTabs, TopBar } from '@/components/top-bar';
import type { MatchRecord } from '@/lib/game/types';
import { useMatchHistory, useProfile, useProfileStats } from '@/lib/queries/auth';

/**
 * 역할·결과 문구. 로비의 MATCH_LABEL 과 같은 판정을 말하지만 다르게 적는다 —
 * 여기는 역할 칸과 결과 칸이 따로 있어서 "시민 — AI 적중"처럼 합친 문구가 아니라
 * 역할 이름 하나가 필요하다. 'spy'(옛 2D 판)와 'actor'(월드 판)는 같은 역할의
 * 옛/새 이름이라 같은 문구로 접는다 (§18.2 — 지난 행은 고쳐 쓰지 않는다).
 */
const ROLE_NAME: Record<MatchRecord['role'], string> = {
  citizen: '시민',
  spy: '연기자',
  actor: '연기자',
};

/**
 * 얼마 전인지 (로비 timeAgo 와 같은 규칙 — 표시용이라 클라이언트 시계를 써도 된다.
 * I2 는 페이즈 전환 판정의 규칙이다). 미래로 나오면 '방금'으로 접는다.
 */
function timeAgo(iso: string, now: number): string {
  const min = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(min) || min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간 전`;
  return `${Math.floor(hour / 24)}일 전`;
}

export function HistoryView() {
  const { data: profileData } = useProfile();
  const { data: stats } = useProfileStats();
  const history = useMatchHistory();

  // 마운트할 때 한 번만 읽는다 — 로비 PlayerSidebar 와 같은 이유 (문구 흔들림 방지)
  const [now] = useState(() => Date.now());

  const matches = history.data?.pages.flatMap((p) => p.matches) ?? [];
  const myName = profileData?.profile?.display_name ?? null;

  return (
    <>
      {/*
        ── 머리말 ───────────────────────────────────────────────────
        로비와 **같은 띠**다 (components/top-bar.tsx). 「기록」 탭이 여기를
        가리키므로, 눌러서 들어온 사람이 같은 자리에 켜진 탭을 그대로 본다 —
        예전에는 이 화면만 팔레트도 머리말도 따로였고 돌아가는 길이 왼쪽 위
        작은 「← 로비로」 하나였다 (2026-08-07).
        ★ 계정 메뉴(로그아웃)는 로비 것 하나다. 여기는 이름만 보여준다 —
          나가는 문을 두 군데 두면 어느 쪽이 진짜인지 흐려진다.
      */}
      <TopBar>
        <div className="flex items-center gap-6 sm:gap-10">
          <span className="text-[0.9rem] font-bold uppercase tracking-[0.15em]">Who is AI?</span>
          <MainTabs active="history" />
        </div>
        {myName ? <AccountName name={myName} /> : <span className="h-[26px]" />}
      </TopBar>

      <main className="min-h-screen bg-[#0a0a0a] text-neutral-200">
        <div className="mx-auto max-w-2xl px-6 py-10">
          <h1 className="text-2xl font-bold tracking-tight">게임 기록</h1>

          {/* ── 합계 — 로비 왼쪽 기둥과 같은 값이다 (/api/profile/stats) ── */}
          <div className="mt-6 grid grid-cols-4 gap-2">
            {[
              { label: '판수', value: stats ? String(stats.games) : '–' },
              { label: '승', value: stats ? String(stats.wins) : '–' },
              {
                // 한 판도 없으면 null 이다. 0% 로 접으면 아직 안 해 본 사람과
                // 다 진 사람이 같아 보인다 (lib/game/types.ts)
                label: '승률',
                value:
                  stats?.win_rate === null || stats === undefined
                    ? '–'
                    : `${Math.round(stats.win_rate * 100)}%`,
              },
              { label: '레벨', value: stats ? `LV ${stats.level}` : '–' },
            ].map((s) => (
              <div
                key={s.label}
                className="rounded-xl bg-[#121212] px-3 py-3 text-center ring-1 ring-white/[0.06]"
              >
                <p className="text-[0.6rem] uppercase tracking-[0.2em] text-neutral-500">
                  {s.label}
                </p>
                <p className="mt-1 font-mono text-sm font-bold text-neutral-100">{s.value}</p>
              </div>
            ))}
          </div>

          {/* ── 목록 ── */}
          <div className="mt-8">
            {history.isLoading ? (
              <p className="text-xs text-neutral-500">기록을 읽는 중…</p>
            ) : history.isError ? (
              <p className="text-xs leading-relaxed text-red-400">
                기록을 읽지 못했다 —{' '}
                {history.error instanceof Error ? history.error.message : '알 수 없는 오류'}
              </p>
            ) : matches.length === 0 ? (
              <p className="text-xs leading-relaxed text-neutral-500">
                아직 끝낸 판이 없다.
                <br />
                {/* 왜 비어 있는지를 같이 적는다 — 혼자 만든 방은 세지 않는다 (SPEC §15-2-결정) */}
                사람이 둘 이상인 방부터 기록에 남는다.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {matches.map((m) => (
                  <li
                    key={m.room_id}
                    className="flex items-center gap-3 rounded-xl bg-[#121212] px-4 py-3 ring-1 ring-white/[0.06]"
                  >
                    {/* 승패 — 점 하나. 로비 최근 게임과 같은 문법이다 */}
                    <span
                      aria-hidden
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{
                        background: m.won ? '#35d07f' : '#e5484d',
                        boxShadow: m.won ? '0 0 8px rgba(53,208,127,0.6)' : undefined,
                      }}
                    />

                    <div className="min-w-0 flex-1">
                      <p className="text-[0.82rem]">
                        <span className="font-semibold text-neutral-100">{ROLE_NAME[m.role]}</span>
                        <span className={m.won ? 'text-[#35d07f]' : 'text-[#e5484d]'}>
                          {' '}
                          · {m.won ? '승리' : '패배'}
                        </span>
                      </p>
                      <p className="mt-0.5 text-[0.62rem] text-neutral-500">
                        사람 {m.humans}명 판 · {timeAgo(m.created_at, now)}
                      </p>
                    </div>

                    {/*
                      그 판의 EXP. 로비와 같은 표기다 — 0 은 0 그대로, 음수는 음수 그대로.
                      월드 판은 진 판이 -1 이다 (2026-08-07, lib/server/match.ts).
                    */}
                    <span
                      className="shrink-0 font-mono text-[0.82rem] font-bold"
                      style={{ color: m.won ? '#35d07f' : '#e5484d' }}
                    >
                      {m.score > 0 ? `+${m.score}` : String(m.score)}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {/* 더 보기 — next 커서가 남아 있을 때만 */}
            {history.hasNextPage ? (
              <button
                type="button"
                disabled={history.isFetchingNextPage}
                onClick={() => void history.fetchNextPage()}
                className="mt-4 w-full rounded-xl bg-white/[0.06] px-4 py-3 text-sm font-bold text-neutral-300 transition-colors hover:bg-white/[0.1] disabled:opacity-40"
              >
                {history.isFetchingNextPage ? '읽는 중…' : '더 보기'}
              </button>
            ) : null}
          </div>
        </div>
      </main>
    </>
  );
}
