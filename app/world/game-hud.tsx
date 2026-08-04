'use client';

/**
 * 판 진행 2D HUD — 단계 표시 · 지목 투표 · 생사 투표 · 결과. 소유: 원상 (/world)
 *
 * 3D 연출(조명·아바타)은 roundtable.tsx / world-scene.tsx 가 하고, **글자와 버튼은
 * 전부 여기 있다.** 이 파일은 캔버스 위에 절대배치로 얹히는 오버레이 묶음이다.
 *
 * ┌─ 읽는 값은 전부 서버가 준 것이다 ──────────────────────────────────────────┐
 * │ 단계·주제·마감시각·지목·진행숫자·결과는 roundtable-store 가 워커에게서 받은  │
 * │ 그대로다. 여기서 만들어 내지 않는다. 좌석 명단만 useWorldStore 에서 온다.    │
 * │                                                                            │
 * │ ★ I2 — 카운트다운은 **표시용일 뿐이다.** 0이 됐다고 이 파일이 화면을 다음     │
 * │   단계로 넘기는 일은 없다. 단계 전환은 오직 서버 round 메시지가 한다.        │
 * │   그래서 클라 시계가 서버와 어긋나면 숫자만 조금 틀리고, 판은 멀쩡하다.       │
 * │                                                                            │
 * │ ★ I1 — 여기 들어오는 어떤 값도 "이 자리가 봇이다"를 말하지 않는다. 유일한     │
 * │   예외가 reveal.identities 이고, 그건 판이 끝난 뒤에만 채워진다.             │
 * │   **정체는 RevealOverlay 밖에서 읽지 마라** — 읽는 곳이 늘면 통로가 는다.    │
 * │                                                                            │
 * │ ★ 좌석 수를 상수로 쓰지 않는다. 그리드는 언제나 실제 명단(useSeats)에서       │
 * │   나온다 — 방마다 자리 수가 다르다.                                         │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 포인터락은 **여기서 다루지 않는다.** 패널이 떠 있는 동안 커서를 살리는 일은
 *   page.tsx 가 한다(그 파일의 「패널이 뜨면 커서를 돌려준다」 상자). 여기서
 *   exitPointerLock 을 부르면 두 곳이 같은 잠금을 두고 싸운다.
 */

import { useEffect, useMemo, useState } from 'react';

import type { RoundPhase, RoundWinner } from '@/lib/mp/protocol';
import { seatColor } from '@/lib/mp/validate';
import { useRoundtableStore } from './roundtable-store';
import { useWorldStore } from './store';

/* ─────────────────────────────── 말 ─────────────────────────────── */

const PHASE_LABEL: Record<RoundPhase, string> = {
  idle: '대기',
  topic: '주제',
  speak: '다같이 말하기',
  freechat: '자유 대화',
  vote: '지목 투표',
  defense: '최후변론',
  verdict: '생사 투표',
  reveal: '결과',
  ended: '판 종료',
};

const PHASE_HINT: Partial<Record<RoundPhase, string>> = {
  topic: '곧 주제가 나온다',
  speak: '주제에 답하라 · Enter 로 말하기',
  freechat: '추궁하고 반박하라',
  vote: 'AI 같은 사람 한 명을 지목하라',
  defense: '지목된 사람의 마지막 말',
  verdict: '처형할 것인가',
};

const WINNER_LABEL: Record<RoundWinner, string> = {
  citizen: '시민 승리',
  ai: 'AI 승리',
  actor: '연기자 승리',
};

/** ①②③… 은 유니코드로 20까지 있다. 좌석·라운드가 그보다 많을 일은 없다 */
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

function circled(n: number): string {
  return CIRCLED[n - 1] ?? String(n);
}

/* ─────────────────────────────── 공통 훅 ─────────────────────────────── */

/**
 * 마감까지 남은 초.
 *
 * ★ **표시용이다 (I2).** 0이 돼도 아무 일도 일어나지 않는다 — 다음 단계는 서버가
 *   보내는 round 메시지로만 온다. 클라 시계가 서버보다 앞서 있으면 0에서 잠깐
 *   머무는데, 그건 버그가 아니라 이 설계의 당연한 모습이다(반대로 클라가 판정에
 *   끼어들면 사람마다 다른 순간에 화면이 넘어간다).
 */
function useRemainingSec(endsAt: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (endsAt <= 0) return;
    setNow(Date.now());
    // 250ms — 초 단위 표시가 한 박자 늦게 바뀌지 않을 만큼만 잦게
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [endsAt]);

  if (endsAt <= 0) return 0;
  return Math.max(0, Math.ceil((endsAt - now) / 1000));
}

export interface SeatEntry {
  id: string;
  seat: number;
  nickname: string;
  isSelf: boolean;
}

/**
 * 이 방의 좌석 명단 — **본인 포함**, 좌석 오름차순.
 *
 * ★ `players` 는 참조가 절대 바뀌지 않는 가변 Map 이다(store.ts 머리말). 그래서
 *   멤버십 변화를 보려면 `playersVersion` 을 **같이 구독해야** 한다. 안 그러면
 *   판 중간에 들어온 사람이 투표 후보에서 영영 빠진다.
 * ★ 봇도 이 Map 에 들어 있다(워커가 welcome 에 좌석순으로 섞어 보낸다). 사람과
 *   구분되는 표시는 아무것도 없고, 그래야 한다 (I1).
 */
export function useSeats(): SeatEntry[] {
  const version = useWorldStore((s) => s.playersVersion);
  const players = useWorldStore((s) => s.players);
  const selfId = useWorldStore((s) => s.selfId);
  const self = useWorldStore((s) => s.self);

  return useMemo(() => {
    void version; // 이 값 자체는 안 쓴다. "다시 계산하라"는 신호일 뿐이다
    const list: SeatEntry[] = [];
    for (const p of players.values()) {
      list.push({ id: p.id, seat: p.seat, nickname: p.nickname, isSelf: false });
    }
    if (selfId && self) {
      list.push({ id: selfId, seat: self.seat, nickname: self.nickname, isSelf: true });
    }
    list.sort((a, b) => a.seat - b.seat);
    return list;
  }, [version, players, selfId, self]);
}

/* ─────────────────────────────── 바깥 껍데기 ─────────────────────────────── */

/**
 * 판이 도는 동안 화면에 얹히는 것 전부.
 *
 * 단계마다 무엇이 뜨는지는 각 조각의 주석에 있다. 여기서는 순서(z)만 정한다:
 *   상단 진행 HUD(z-30) < 투표·찬반 패널(z-40) < 결과(z-50)
 */
export default function GameHud({
  onVote,
  onVerdict,
  onLeave,
}: {
  /** 좌석을 골랐다. 실제로 소켓에 나갔을 때만 선택이 확정된다(page.tsx) */
  onVote: (targetId: string) => void;
  /** 찬(처형)/반(생존). 확정 조건은 onVote 와 같다 */
  onVerdict: (guilty: boolean) => void;
  /** 결과를 다 본 뒤 방을 떠난다 — 연결·스토어 정리는 page.tsx 의 몫 */
  onLeave: () => void;
}) {
  const phase = useRoundtableStore((s) => s.phase);
  const reveal = useRoundtableStore((s) => s.reveal);

  return (
    <>
      <PhaseHud />
      {phase === 'defense' ? <DefenseBanner /> : null}
      {phase === 'vote' ? <VotePanel onVote={onVote} /> : null}
      {phase === 'verdict' ? <VerdictPanel onVerdict={onVerdict} /> : null}
      {/*
        ★ `phase === 'reveal'` 이 아니라 **결과가 실제로 도착했는지**로 띄운다.
          단계만 보고 띄우면 정체가 오기 전에 빈 표가 한 번 번쩍인다.
      */}
      {reveal ? <RevealOverlay onLeave={onLeave} /> : null}
    </>
  );
}

/* ─────────────────────────────── 상단 진행 HUD ─────────────────────────────── */

/**
 * 지금 어느 단계이고 몇 초 남았는가. 주제 라운드면 ①/② 도 같이.
 *
 * pointer-events 가 없다 — 잠금이 걸린 채로 걷는 동안에도 떠 있어야 하고,
 * 여기에 클릭할 것이 생기면 그 순간 커서를 돌려줘야 한다(그러면 게임이 멈춘다).
 */
function PhaseHud() {
  const phase = useRoundtableStore((s) => s.phase);
  const endsAt = useRoundtableStore((s) => s.endsAt);
  const round = useRoundtableStore((s) => s.round);
  const totalRounds = useRoundtableStore((s) => s.totalRounds);
  const left = useRemainingSec(endsAt);

  if (phase === 'idle') return null;

  const hint = PHASE_HINT[phase];

  return (
    <div className="pointer-events-none absolute left-1/2 top-5 z-30 flex -translate-x-1/2 flex-col items-center gap-1.5">
      <div className="flex items-center gap-3 rounded-full border border-white/10 bg-black/70 px-5 py-2 backdrop-blur">
        <span className="text-[12px] font-bold tracking-wide text-[#d4a373]">
          {PHASE_LABEL[phase]}
        </span>

        {totalRounds > 0 ? (
          <span className="flex items-center gap-0.5 text-[12px]">
            {Array.from({ length: totalRounds }, (_, i) => i + 1).map((n) => (
              <span key={n} className={n === round ? 'text-neutral-100' : 'text-neutral-600'}>
                {circled(n)}
              </span>
            ))}
          </span>
        ) : null}

        {/* ★ 표시용 숫자다. 0이 돼도 화면은 서버 신호를 기다린다 (I2) */}
        {endsAt > 0 && phase !== 'ended' ? (
          <span
            className={`w-7 text-right font-mono text-[13px] tabular-nums ${
              left <= 5 ? 'text-red-400' : 'text-neutral-300'
            }`}
          >
            {left}
          </span>
        ) : null}
      </div>

      {hint ? (
        <p className="text-[11px] text-neutral-400 drop-shadow-[0_1px_6px_rgba(0,0,0,0.9)]">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/* ─────────────────────────────── 최후변론 ─────────────────────────────── */

/**
 * defense 단계의 이름표. 조명은 3D 쪽(PlayerSpotlight)이 켜고, 여기서는
 * **누구의 변론인지**만 글자로 알려 준다 — 지목된 사람이 접속을 끊으면 조명이
 * 사라져서 화면만 보고는 알 수 없기 때문이다.
 */
function DefenseBanner() {
  const nomineeId = useRoundtableStore((s) => s.nomineeId);
  const seats = useSeats();
  const nominee = seats.find((s) => s.id === nomineeId);

  return (
    <div className="pointer-events-none absolute left-1/2 top-20 z-30 -translate-x-1/2">
      <div className="rounded-full border border-[#d4a373]/40 bg-black/70 px-5 py-2 backdrop-blur">
        <span className="text-[12px] text-neutral-300">
          <span className="font-bold text-[#d4a373]">{nominee?.nickname ?? '지목된 사람'}</span>
          {nominee?.isSelf ? ' — 당신의 최후변론이다' : ' 의 최후변론'}
        </span>
      </div>
    </div>
  );
}

/* ─────────────────────────────── 지목 투표 ─────────────────────────────── */

/**
 * vote 단계. 좌석 카드를 눌러 한 명을 지목한다.
 *
 * · 마감까지 몇 번이든 바꿀 수 있다(마지막 것이 유효). 사람이 마음을 바꾸는 걸
 *   막으면 오히려 봇처럼 군다.
 * · **자기 자신은 못 고른다** (SPEC §18.3 — 연기자 자폭 지목 차단).
 * · 진행 숫자는 **서버가 준 것만** 쓴다. 내가 눌렀다고 +1 하면 서버 집계와
 *   어긋나고, 그 어긋남 자체가 관측 가능한 신호가 된다.
 * · **누가 냈는지는 오지 않는다.** 카드에 "투표함" 체크를 그리지 마라 —
 *   조기 종료와 겹치는 순간 "안 낸 자리 = 봇"이 된다 (I1).
 */
function VotePanel({ onVote }: { onVote: (targetId: string) => void }) {
  const seats = useSeats();
  const myVote = useRoundtableStore((s) => s.myVote);
  const voted = useRoundtableStore((s) => s.voted);
  const total = useRoundtableStore((s) => s.total);

  return (
    <PanelShell>
      <h2 className="text-sm font-bold text-neutral-100">AI 같은 사람을 한 명 지목하라</h2>
      <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
        마감 전까지 몇 번이든 바꿀 수 있다. 자기 자신은 지목할 수 없다.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {seats.map((s) => {
          const picked = myVote === s.id;
          return (
            <button
              key={s.id}
              type="button"
              disabled={s.isSelf}
              title={s.isSelf ? '자기 자신은 지목할 수 없다' : undefined}
              onClick={() => onVote(s.id)}
              className={`flex items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                picked
                  ? 'bg-[#d4a373]/20 ring-2 ring-[#d4a373]'
                  : 'bg-white/5 ring-1 ring-white/10 hover:bg-white/10'
              }`}
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: seatColor(s.seat) }}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-100">
                {s.nickname}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-neutral-500">
                {s.isSelf ? '나' : `#${s.seat}`}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-[11px] text-neutral-500">
          {total > 0 ? (
            <>
              <span className="font-mono text-neutral-300 tabular-nums">
                {voted}/{total}
              </span>{' '}
              명이 냈다
            </>
          ) : (
            '집계를 기다리는 중'
          )}
        </p>
        <p className="text-[11px] text-neutral-400">
          {myVote ? (
            <>
              지목:{' '}
              <span className="font-bold text-[#d4a373]">
                {seats.find((s) => s.id === myVote)?.nickname ?? '자리를 떠났다'}
              </span>
            </>
          ) : (
            <span className="text-neutral-600">아직 고르지 않았다</span>
          )}
        </p>
      </div>
    </PanelShell>
  );
}

/* ─────────────────────────────── 생사 투표 ─────────────────────────────── */

/**
 * verdict 단계. 찬(처형) / 반(생존).
 *
 * · **지목된 본인은 기권한다** — 버튼을 주지 않는다. 서버도 그 표를 무시한다.
 * · 동수는 생존이다(찬이 과반일 때만 처형). 확신 없이 사람을 죽이지 못하게 하는 게
 *   변론을 넣은 이유다 — 그 규칙을 화면에도 적어 둔다.
 * · 조기 종료가 없다. 20초를 꽉 채운다 — 임계가 지목자의 정체에 따라 갈리면
 *   종료 시점 하나로 그 자리가 사람인지 봇인지 읽힌다 (I1, SPEC §5.3).
 */
function VerdictPanel({ onVerdict }: { onVerdict: (guilty: boolean) => void }) {
  const nomineeId = useRoundtableStore((s) => s.nomineeId);
  const myVerdict = useRoundtableStore((s) => s.myVerdict);
  const seats = useSeats();
  const nominee = seats.find((s) => s.id === nomineeId);
  const isNominee = nominee?.isSelf === true;

  return (
    <PanelShell>
      <h2 className="text-sm font-bold text-neutral-100">
        <span className="text-[#d4a373]">{nominee?.nickname ?? '지목된 사람'}</span> 을(를)
        처형할 것인가
      </h2>
      <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
        찬성이 과반일 때만 처형된다. 동수면 살아남는다.
      </p>

      {isNominee ? (
        <p className="mt-4 rounded-xl bg-white/5 px-4 py-3 text-[12px] leading-relaxed text-neutral-400 ring-1 ring-white/10">
          당신이 지목됐다. <span className="text-neutral-200">당신은 투표할 수 없다.</span>{' '}
          결과를 기다려라.
        </p>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => onVerdict(true)}
            className={`rounded-xl px-4 py-3 text-sm font-bold transition-colors ${
              myVerdict === true
                ? 'bg-red-500/90 text-black'
                : 'bg-white/5 text-neutral-200 ring-1 ring-white/10 hover:bg-red-500/20'
            }`}
          >
            찬성 — 처형
          </button>
          <button
            type="button"
            onClick={() => onVerdict(false)}
            className={`rounded-xl px-4 py-3 text-sm font-bold transition-colors ${
              myVerdict === false
                ? 'bg-amber-500/90 text-black'
                : 'bg-white/5 text-neutral-200 ring-1 ring-white/10 hover:bg-amber-500/20'
            }`}
          >
            반대 — 생존
          </button>
        </div>
      )}

      {!isNominee && myVerdict === null ? (
        <p className="mt-3 text-[11px] text-neutral-600">아직 고르지 않았다</p>
      ) : null}
    </PanelShell>
  );
}

/* ─────────────────────────────── 결과 ─────────────────────────────── */

/** 결과를 한 겹씩 여는 간격. 한 번에 다 쏟으면 어디를 봐야 할지 모른다 */
const REVEAL_STEP_MS = 900;
const REVEAL_STEPS = 3;

/**
 * reveal — 판의 클라이맥스. 읽는 순서대로 한 겹씩 열린다.
 *
 *   ① 처형됐는가            ② 그는 AI 였는가        ③ 어느 편이 이겼는가
 *   ④ 표는 어떻게 갈렸는가 (찬반 · 전원 정체 · 누가 누구를 찍었나)
 *
 * ★ **이 파일에서 정체(identities)를 읽는 곳은 여기 하나뿐이다.** 다른 단계의
 *   화면이 이 값을 읽기 시작하면 그 순간 I1이 무너진다 — 판이 끝나기 전에
 *   "정체를 아는 코드 경로"가 생기고, 그 경로는 언젠가 화면에 닿는다.
 */
function RevealOverlay({ onLeave }: { onLeave: () => void }) {
  const reveal = useRoundtableStore((s) => s.reveal);
  const seats = useSeats();
  const [stage, setStage] = useState(0);

  useEffect(() => {
    setStage(0);
    const id = window.setInterval(
      () => setStage((s) => (s >= REVEAL_STEPS ? s : s + 1)),
      REVEAL_STEP_MS,
    );
    return () => window.clearInterval(id);
  }, [reveal]);

  const nameOf = useMemo(() => {
    const map = new Map(seats.map((s) => [s.id, s]));
    return (id: string) => map.get(id)?.nickname ?? '떠난 자리';
  }, [seats]);

  const seatOf = useMemo(() => {
    const map = new Map(seats.map((s) => [s.id, s.seat]));
    return (id: string) => map.get(id) ?? 0;
  }, [seats]);

  if (!reveal) return null;

  const nomineeName = reveal.nomineeId ? nameOf(reveal.nomineeId) : null;
  const nomineeIsBot =
    reveal.nomineeId === null
      ? null
      : (reveal.identities.find((i) => i.id === reveal.nomineeId)?.isBot ?? null);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 p-6 backdrop-blur">
      <div className="max-h-full w-full max-w-lg overflow-y-auto rounded-2xl bg-black/70 p-6 ring-1 ring-white/10">
        {/* ① 처형됐는가 */}
        <p className="text-center text-xl font-black tracking-tight text-neutral-100">
          {reveal.executed ? (
            <>
              <span className="text-[#d4a373]">{nomineeName}</span> 처형됐다
            </>
          ) : reveal.nomineeId === null ? (
            '아무도 지목되지 않았다'
          ) : (
            <>
              <span className="text-[#d4a373]">{nomineeName}</span> 살아남았다
            </>
          )}
        </p>

        {/* ② 그는 AI 였는가 */}
        <Layer show={stage >= 1}>
          <p className="mt-4 text-center text-[15px] font-bold">
            {nomineeIsBot === null ? (
              <span className="text-neutral-500">지목이 없어 정체를 열지 못했다</span>
            ) : nomineeIsBot ? (
              <span className="text-emerald-400">그는 AI 였다</span>
            ) : (
              <span className="text-red-400">그는 사람이었다</span>
            )}
          </p>
        </Layer>

        {/* ③ 어느 편이 이겼는가 */}
        <Layer show={stage >= 2}>
          <p className="mt-5 text-center">
            <span className="rounded-full border border-[#d4a373]/40 bg-[#d4a373]/10 px-5 py-2 text-[13px] font-black tracking-wide text-[#d4a373]">
              {WINNER_LABEL[reveal.winner]}
            </span>
          </p>
        </Layer>

        {/* ④ 표는 어떻게 갈렸는가 */}
        <Layer show={stage >= 3}>
          <div className="mt-6 border-t border-white/10 pt-4">
            <p className="text-[11px] text-neutral-500">
              생사 투표{' '}
              <span className="font-mono text-neutral-300 tabular-nums">
                찬 {reveal.verdict.guilty} · 반 {reveal.verdict.innocent}
              </span>
            </p>

            <h3 className="mt-4 text-[11px] font-bold tracking-wide text-neutral-400">정체</h3>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              {[...reveal.identities]
                .sort((a, b) => seatOf(a.id) - seatOf(b.id))
                .map((i) => (
                  <div
                    key={i.id}
                    className="flex items-center gap-2 rounded-lg bg-white/5 px-2.5 py-1.5"
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: seatColor(seatOf(i.id)) }}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-200">
                      {nameOf(i.id)}
                    </span>
                    <span
                      className={`shrink-0 font-mono text-[10px] ${
                        i.isBot ? 'text-emerald-400' : 'text-neutral-500'
                      }`}
                    >
                      {i.isBot ? 'AI' : '사람'}
                    </span>
                  </div>
                ))}
            </div>

            <h3 className="mt-4 text-[11px] font-bold tracking-wide text-neutral-400">지목</h3>
            <ul className="mt-2 space-y-1">
              {[...reveal.votes]
                .sort((a, b) => seatOf(a.voterId) - seatOf(b.voterId))
                .map((v) => (
                  <li key={`${v.voterId}-${v.targetId}`} className="text-[12px] text-neutral-400">
                    <span className="text-neutral-200">{nameOf(v.voterId)}</span>
                    <span className="mx-1.5 text-neutral-600">→</span>
                    <span className="text-neutral-200">{nameOf(v.targetId)}</span>
                  </li>
                ))}
              {reveal.votes.length === 0 ? (
                <li className="text-[12px] text-neutral-600">표가 하나도 없었다</li>
              ) : null}
            </ul>

            {/*
              판이 끝난 방에서 나가는 유일한 문. 마지막 겹과 같이 나타난다 —
              결과가 다 열리기 전에 문부터 보이면 읽다 만 채로 나가게 된다.
              연결·스토어 정리는 page.tsx 의 leave 가 한다(여기는 신호만 올린다).
            */}
            <button
              type="button"
              onClick={onLeave}
              className="mt-6 w-full rounded-xl bg-[#d4a373]/90 px-4 py-3 text-sm font-bold text-black transition-colors hover:bg-[#d4a373]"
            >
              새로운 게임 시작하기
            </button>
          </div>
        </Layer>
      </div>
    </div>
  );
}

/**
 * 한 겹. 자리를 미리 잡지 않고 **없는 상태에서 나타난다** — 열리는 게 보여야 한다.
 *
 * ★ 페이드 클래스(animate-in 류)를 쓰지 않는다. 이 저장소에는 그 플러그인이 없고,
 *   없는 클래스를 적으면 조용히 아무 일도 안 일어나 "왜 안 뜨지"로 시간을 버린다.
 *   한 겹씩 **나타나는 것 자체**가 연출이라 페이드는 없어도 된다.
 */
function Layer({ show, children }: { show: boolean; children: React.ReactNode }) {
  if (!show) return null;
  return <>{children}</>;
}

/* ─────────────────────────────── 껍데기 ─────────────────────────────── */

/**
 * 투표·찬반이 공유하는 판. 화면 가운데에 뜬다.
 *
 * ★ 바깥은 `pointer-events-none` 이고 **안쪽 카드만** 클릭을 받는다. 그래야
 *   판 바깥을 누른 클릭이 캔버스로 흘러가고, page.tsx 의 "캔버스를 직접 누른
 *   것만 잠금" 규칙이 그대로 산다(그 규칙은 지금 uiOpen 동안 꺼져 있지만,
 *   경계를 흐려 놓으면 다음에 되살릴 때 또 같은 사고가 난다).
 */
function PanelShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center p-6">
      <div className="pointer-events-auto w-full max-w-md rounded-2xl bg-black/80 p-6 ring-1 ring-white/10 backdrop-blur">
        {children}
      </div>
    </div>
  );
}
