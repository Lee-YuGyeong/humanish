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

import { useEffect, useMemo, useRef, useState } from 'react';

import { VERDICT_MAX_REVOTES } from '@/lib/mp/constants';
import type { RevealIdentity, RoundPhase, RoundRole, RoundWinner } from '@/lib/mp/protocol';
import { seatColor } from '@/lib/mp/validate';
import cardStyles from './role-card.module.css';
import { type SeatGuess, roleCardOpen, useRoundtableStore } from './roundtable-store';
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

/** reveal 정체 표기. 남의 role 을 화면에 적는 곳은 여기뿐이다 (내 역할 안내는 ROLE_CARD) */
const ROLE_TAG: Record<RoundRole, { label: string; className: string }> = {
  ai: { label: 'AI', className: 'text-emerald-400' },
  actor: { label: '연기자', className: 'text-[#d4a373]' },
  citizen: { label: '시민', className: 'text-neutral-500' },
};

/**
 * 정체의 진영. **구 워커 호환** — role 이 없던 시절의 reveal 은 isBot 만 실어
 * 보냈으므로, 없으면 isBot 으로 접는다 (그때는 연기자가 없어 사람 = 시민이 맞다).
 */
function identityRole(i: RevealIdentity): RoundRole {
  return i.role ?? (i.isBot ? 'ai' : 'citizen');
}

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
      {/* 카드는 결과(z-50) 아래·투표 패널(z-40) 위 — 확인 전에는 카드가 먼저다 */}
      <RoleCard />
    </>
  );
}

/* ─────────────────────────────── 역할 카드 ─────────────────────────────── */

/**
 * 역할별 화면 문구. **내 화면에만 있는 로컬 값이다** — myRole 은 t:'role' 로 내 것만
 * 왔고(§18.2), 봇 좌석에는 소켓이 없어 카드 자체가 갈 곳이 없다(AI 역할은 서버가
 * 봇 좌석에 무조건 'ai' 로 배정한다 — seatRole). 그래서 시민에게 카드가 떠도 새는 게
 * 없다: "카드 내용"은 각자 자기 것만 본다.
 *
 * · lines 는 **문장마다 한 줄씩** 그린다 (사용자 결정 2026-08-06).
 * · color 는 role-card.module.css 가 --rc 변수로 받아 테두리·광채·버튼을 물들인다.
 *   시민을 emerald 로 두지 않는 이유: reveal 정체 표기(ROLE_TAG)에서 emerald 는
 *   AI 의 색이다 — 같은 색을 시민 카드에 쓰면 결과 화면에서 색이 거짓말을 한다.
 * ★ export 는 page.tsx 의 머리말 역할 줄(확인 뒤 방코드 밑에 남는 한 줄)이 같은
 *   이름·색을 쓰기 위해서다 — 문구를 두 군데 적으면 반드시 갈린다.
 */
export const ROLE_CARD: Record<
  'citizen' | 'actor',
  { name: string; tagline: string; lines: string[]; accent: string; color: string }
> = {
  citizen: {
    name: '일반 시민',
    tagline: '사람들 틈에 AI 가 숨어 있다',
    lines: [
      '대화를 나누며 AI 같은 사람을 찾아내 지목하라.',
      '진짜 AI 를 처형하면 시민 진영이 이긴다.',
    ],
    accent: 'text-sky-300',
    color: '#7dd3fc',
  },
  actor: {
    name: '연기자',
    tagline: 'AI 인 척하는 스파이',
    lines: [
      'AI 인 척 연기해서 지목을 받아내라.',
      '당신이 지목되면 연기자 진영이 이긴다.',
      '다른 연기자가 누구인지는 당신도 모른다.',
    ],
    accent: 'text-[#d4a373]',
    color: '#d4a373',
  },
};

/**
 * 내 역할 카드 — 게이트가 열리는 순간(전원 집결, 카운트다운 시작) 딜되어 들어온다
 * (역할이 그때 t:'role' 로 온다 — room-do 의 dealEarlyRoles). 「확인」을 누르면
 * 사라지고, 그 뒤로는 왼쪽 상단 머리말(방코드·이름 줄) 밑에 역할 한 줄이 남는다.
 *
 * · 뜨는 조건은 roleCardOpen **하나**다 — page.tsx 가 같은 셀렉터로 커서를 돌려준다.
 * · z-[45]: 확인을 미뤄 투표 단계(z-40)까지 끌고 와도 카드가 먼저 보인다. 결과(z-50)가
 *   오면 roleCardOpen 이 false 라 알아서 걷힌다.
 * · 연출(딜·광택·부유)은 role-card.module.css 에 있다. 카드를 읽는 동안 내 아바타가
 *   서 있는 건 채팅 입력·ESC 멈춤과 같은 "가만히 서 있는 사람"이다 (I1).
 */
function RoleCard() {
  const open = useRoundtableStore(roleCardOpen);
  const myRole = useRoundtableStore((s) => s.myRole);
  const ackRole = useRoundtableStore((s) => s.ackRole);

  if (!open || myRole === null) return null;
  const card = ROLE_CARD[myRole];

  return (
    <div
      className={`pointer-events-none absolute inset-0 z-[45] flex items-center justify-center p-6 ${cardStyles.backdrop}`}
    >
      <div className={cardStyles.deal}>
        <div
          className={`${cardStyles.card} relative w-[19rem] overflow-hidden rounded-2xl px-6 pb-6 pt-5 text-center`}
          style={{ '--rc': card.color } as React.CSSProperties}
        >
          <div aria-hidden className={cardStyles.frame} />
          <div aria-hidden className={cardStyles.shine} />

          <p className={cardStyles.kicker}>Secret Role — 당신의 역할</p>
          <div className={cardStyles.emblem} aria-hidden>
            {myRole === 'actor' ? <MaskIcon /> : <EyeIcon />}
          </div>
          <p className={cardStyles.name}>{card.name}</p>
          <p className={cardStyles.tagline}>{card.tagline}</p>
          <div className={cardStyles.rule} aria-hidden>
            ◆
          </div>
          <div className={cardStyles.lines}>
            {card.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
          <button type="button" onClick={ackRole} className={cardStyles.confirm}>
            확인
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── 곁에 두는 판 (메모 · 기록) ─────────────────────────── */

/**
 * 화면 가장자리에 **조용히 서는** 판의 껍데기 (2026-08-07 요청).
 *
 * ★ 역할 카드·투표 패널이 쓰는 cardStyles.panel 을 여기 쓰지 않는다. 그건 화면
 *   한가운데에서 **읽어 달라고** 서는 물건이라 금색 테두리와 광채가 있다.
 *   가장자리에 같은 껍데기를 두르면 3D 장면보다 판이 먼저 눈에 들어온다 —
 *   이 게임은 사람이 움직이는 걸 보는 게임이다.
 * ★ 그래서 여기는 **어두운 유리 한 겹**뿐이다: 살짝 흐린 검정 + 머리카락 굵기의
 *   흰 테. 글자는 배경 위에서 읽히기만 하면 된다.
 */
const GLASS =
  'rounded-xl bg-black/25 ring-1 ring-white/[0.06] backdrop-blur-[2px] ' +
  'transition-opacity duration-200 opacity-80 hover:opacity-100';

/* ─────────────────────────────── 좌석 메모 ─────────────────────────────── */

/**
 * 메모 한 칸의 생김새. '?' 는 아직 안 찍은 것이고 값이 아니다 (roundtable-store).
 *
 * 색은 이 화면이 이미 쓰는 말과 맞춘다 — 연기자는 월드 금색(#d4a373), AI 는
 * emerald(ROLE_TAG.ai), 사람은 시민 카드의 하늘색(ROLE_CARD.citizen). 여기서
 * 새 색을 지어내면 결과 화면과 메모가 서로 다른 색으로 같은 말을 하게 된다.
 *
 * ★ 라벨 칸은 **고정 너비**다 (아래 chip). '?' 와 '연기자' 는 글자 수가 달라서,
 *   폭을 글자에 맡기면 한 칸 누를 때마다 명단 전체가 좌우로 출렁인다.
 */
const GUESS_LOOK: Record<'none' | SeatGuess, { label: string; color: string }> = {
  none: { label: '?', color: '#6b6b6b' },
  human: { label: '사람', color: '#7dd3fc' },
  actor: { label: '연기자', color: '#d4a373' },
  ai: { label: 'AI', color: '#34d399' },
};

/**
 * 왼쪽 판 하나 — **맨 위가 내 역할(고정), 그 밑이 좌석 메모**다 (2026-08-07 요청).
 * 남의 자리를 누를 때마다 ? → 사람 → 연기자 → AI → ? 로 돈다.
 *
 * ┌─ 왜 역할과 메모가 한 판인가 ───────────────────────────────────────────────┐
 * │ 처음에는 역할 뱃지가 따로 떠 있고 그 밑에 메모가 붙어서, 같은 화면에        │
 * │ 「연기자」가 4px 떨어져 두 번 적혔다. 하나로 합치면 내 자리가 명단의 맨 위   │
 * │ 라는 것도 같이 말해진다 — 이 판은 **한 방의 자리 전부**이고, 그중 첫 줄만   │
 * │ 짐작이 아니라 아는 값이다.                                                 │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 메모는 화면 밖으로 나가지 않는다 ─────────────────────────────────────────┐
 * │ 값은 roundtable-store 의 guesses 하나뿐이고 소켓·서버와 아무 관계가 없다.   │
 * │ 그래서 무엇을 찍든 I1 과 무관하다. **거꾸로가 위험하다** — 여기에 서버가    │
 * │ 준 정체(reveal.identities)를 채워 넣지 마라. 그 순간 이 판은 남의 역할을    │
 * │ 그리는 자리가 된다. 첫 줄에 오는 myRole 은 t:'role' 로 **내 것만** 온       │
 * │ 값이라 예외다 (§18.2).                                                     │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 이름·색의 원본은 ROLE_CARD 하나다 (역할 카드와 같은 것을 읽는다). 여기서 다시
 *   적으면 카드와 이 판이 같은 역할을 다른 이름·다른 색으로 부른다.
 * ★ 명단은 투표 패널과 **같은 useSeats()** 다. 여기서 따로 모으면 판 중간에 들어온
 *   사람이 한쪽에만 뜬다. 이름은 '익명N', 점 색은 좌석 색으로 좌석표와 맞춘다.
 * ★ 카드를 확인하기 전(roleAck=false)에는 역할 이름을 쓰지 않는다. 그때는 화면
 *   한가운데의 카드가 같은 것을 더 크게 들고 있다 — 뒤에서 먼저 흘리면 딜 연출이
 *   죽는다. 새 판이 열리면 myRole·roleAck·guesses 가 한자리에서 같이 걷힌다.
 * ★ **걸어 다니는 동안에는 못 누른다.** 그때는 포인터가 잠겨 커서가 없기 때문이다
 *   (world-scene 의 포인터락). ESC 로 커서를 되찾거나, 투표처럼 이동이 잠긴 단계
 *   에서는 그냥 눌린다 — 어차피 찍어 두고 싶은 순간이 거기다.
 * ★ 좌석이 2개 미만이면 그리지 않는다. 나 혼자인 라운지에서 적어 둘 것이 없다.
 */
export function SeatNotes() {
  const seats = useSeats();
  const guesses = useRoundtableStore((s) => s.guesses);
  const cycleGuess = useRoundtableStore((s) => s.cycleGuess);
  const myRole = useRoundtableStore((s) => s.myRole);
  const roleAck = useRoundtableStore((s) => s.roleAck);

  if (seats.length < 2) return null;

  const me = seats.find((s) => s.isSelf) ?? null;
  const others = seats.filter((s) => !s.isSelf);
  // 아직 카드를 안 봤으면 이름을 쓰지 않는다 (위 머리말). 색도 그때는 월드 금색이다.
  const mine = myRole && roleAck ? ROLE_CARD[myRole] : null;
  const accent = mine?.color ?? '#d4a373';

  return (
    <div className={`${GLASS} pointer-events-auto mt-3 w-[10.5rem] overflow-hidden`}>
      {/* ── 맨 위: 내 역할. 짐작이 아니라 아는 값이라 못 누른다 ── */}
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-2.5 py-2">
        <span aria-hidden className="shrink-0 opacity-80" style={{ color: accent }}>
          {/* 확인 전에는 가면을 미리 보여주지 않는다 — 그림도 역할을 말한다 */}
          {mine && myRole === 'actor' ? <MaskIcon size={15} /> : <EyeIcon size={15} />}
        </span>
        <span className="min-w-0 leading-tight">
          {/* 판에서 제일 크고 유일하게 색이 있는 글자 — 조용한 판에서는 이걸로 충분하다 */}
          <span className="block truncate text-[13px] font-bold" style={{ color: accent }}>
            {/* 역할이 아직 안 온 것과 카드를 안 누른 것은 다른 상태다 */}
            {mine ? mine.name : myRole ? '카드 확인' : '대기 중'}
          </span>
          {me ? (
            <span className="block truncate font-mono text-[9px] text-neutral-500">
              {me.nickname} · 나
            </span>
          ) : null}
        </span>
      </div>

      {/* ── 그 밑: 남의 자리. 눌러서 찍는다 ── */}
      <ul className="flex flex-col p-1">
        {others.map((s) => {
          const look = GUESS_LOOK[guesses[s.id] ?? 'none'];
          // '?' 는 값이 아니라 **키가 없는 것**이다 (roundtable-store) — 그래서
          // 라벨과 비교하지 않고 키를 직접 본다.
          const marked = s.id in guesses;
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => cycleGuess(s.id)}
                aria-label={`${s.nickname} — 지금 ${look.label}`}
                className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-white/[0.05]"
              >
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: seatColor(s.seat), opacity: 0.75 }}
                />
                <span className="min-w-0 flex-1 truncate text-[10px] text-neutral-400">
                  {s.nickname}
                </span>
                {/*
                  칩이 아니라 글자다. 테두리·바탕을 두르면 좌석 수만큼 작은 상자가
                  화면에 서고, 그게 3D 위에서 제일 먼저 눈에 띈다.
                  안 찍은 칸은 색까지 죽여서 **찍은 것만 읽히게** 한다.
                */}
                <span
                  className="w-[2.4rem] shrink-0 text-right text-[10px] font-bold leading-normal"
                  style={{ color: look.color, opacity: marked ? 0.95 : 0.5 }}
                >
                  {look.label}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {/* 처음 한 번만. 한 칸이라도 찍었으면 조작법을 설명할 이유가 없다 */}
      {Object.keys(guesses).length === 0 ? (
        <p className="px-2.5 pb-1.5 text-[8px] leading-relaxed text-neutral-600">
          눌러서 표시 — ? → 사람 → 연기자 → AI
        </p>
      ) : null}
    </div>
  );
}

/* ─────────────────────────────── 대화 기록 ─────────────────────────────── */

/**
 * 이 판의 **대화 전문** — 오른쪽에 서고, 굴려서 처음까지 읽는다 (2026-08-07 요청).
 *
 * 화면 아래로 흐르는 줄(page.tsx)은 방금 것만 보여준다. 여덟이 한 바퀴 도는 동안
 * 앞사람 말이 밀려 나가서 "누가 뭐라고 했더라"를 확인할 데가 없었다.
 *
 * ★ **뜨는 조건은 page.tsx 가 정한다** (커서가 이미 자유로운 순간). 여기서 스스로
 *   포인터락을 풀지 않는다 — 그러면 게임이 멈춘다 (page.tsx 의 「판은 없다」 상자).
 * ★ 보관 개수는 store.ts 의 CHAT_LOG_MAX 하나다. 그보다 오래된 말은 스토어에
 *   애초에 없다 — 여기서 더 길게 보여줄 방법은 없고, 늘리려면 그 상수를 고친다.
 * ★ 이름은 '익명N' 이고 좌석 색 점을 앞에 단다. 좌석표·투표 패널·메모와 같은
 *   사람이 같은 색이어야 대화를 자리에 붙여 읽을 수 있다.
 * ★ **누가 봇인지 말하는 값이 여기 없다** (I1). 발화는 사람이든 봇이든 같은
 *   모양으로 온다 — 실제로 그게 이 게임의 전부다.
 * ★ 좁은 화면(lg 미만)에서는 접는다. 가운데 패널(max-w-md)과 겹치면 투표를
 *   가린다 — 그때는 아래로 흐르는 줄이 대신한다.
 */
export function ChatTranscript() {
  const messages = useWorldStore((s) => s.messages);
  const seats = useSeats();
  /*
   * 말한 사람의 좌석 번호 — 색을 뽑으려고만 쓴다. 이미 나간 사람의 말은 명단에
   * 없어서 색이 안 나오는데, 그때는 회색 점으로 둔다 (말은 남아야 한다).
   */
  const seatOf = useMemo(() => new Map(seats.map((s) => [s.id, s.seat])), [seats]);
  const boxRef = useRef<HTMLDivElement>(null);
  /** 열자마자 한 번은 무조건 맨 아래로. 판이 걷히면 다시 true 가 된다(언마운트) */
  const firstRef = useRef(true);

  /*
   * 새 줄이 오면 따라 내려간다 — 단, **위로 올려 읽는 중이면 건드리지 않는다.**
   * 여기서 무조건 내리면 처음부터 읽는 도중에 누가 말할 때마다 화면이 튄다.
   */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (firstRef.current || near) {
      el.scrollTop = el.scrollHeight;
      firstRef.current = false;
    }
  }, [messages.length]);

  if (messages.length === 0) return null;

  return (
    <div className="absolute bottom-24 right-6 top-28 z-[35] hidden w-[17.5rem] lg:flex">
      <div className={`${GLASS} flex min-h-0 w-full flex-col overflow-hidden`}>
        {/* 이름만 적는다. 개수를 옆에 세우면 읽을 것이 하나 더 는다 */}
        <p className="shrink-0 border-b border-white/[0.06] px-3 py-2 text-[9px] tracking-[0.14em] text-neutral-500">
          전체 대화 기록
        </p>

        {/* 굴려서 읽는 자리. 여기만 스크롤이 붙는다 */}
        <div ref={boxRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          <ul className="flex flex-col gap-1.5">
            {messages.map((m) => {
              const seat = seatOf.get(m.id);
              return (
                <li key={m.key} className="text-[11px] leading-relaxed">
                  <span className="mb-0.5 flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{
                        backgroundColor: seat === undefined ? '#525252' : seatColor(seat),
                        opacity: 0.75,
                      }}
                    />
                    <span className="truncate font-semibold text-[#b99168]">{m.nickname}</span>
                  </span>
                  <span className="block break-words pl-3 text-neutral-400">{m.text}</span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

/** 연기자 — 가면. 카드 문장(AI 인 척)의 그림 버전이다 */
function MaskIcon({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 6.5C6 5.3 9 4.8 12 4.8s6 .5 9 1.7c0 5.5-2.6 10.7-6.7 10.7-1.5 0-2.3-.9-2.3-.9s-.8.9-2.3.9C5.6 17.2 3 12 3 6.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <ellipse cx="8.6" cy="10" rx="1.5" ry="1.1" fill="currentColor" />
      <ellipse cx="15.4" cy="10" rx="1.5" ry="1.1" fill="currentColor" />
    </svg>
  );
}

/** 시민 — 감시하는 눈. 찾아내는 쪽의 그림이다 */
function EyeIcon({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M2.5 12S6 6.2 12 6.2 21.5 12 21.5 12 18 17.8 12 17.8 2.5 12 2.5 12Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="0.9" fill="currentColor" />
    </svg>
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
  /**
   * 부결로 되돌아온 바퀴인가 (0이면 첫 지목).
   *
   * ★ 이 한 줄이 없으면 방금 「반대 — 생존」을 고른 사람에게는 화면이 그냥 뒤로
   *   튄 것으로 보인다. 실제로 그게 "재투표가 모달에서 멈췄다"로 보고됐다.
   */
  const revote = useRoundtableStore((s) => s.revote);

  return (
    <PanelShell kicker="Nomination — 지목 투표">
      {revote > 0 ? (
        <p className="mt-3 text-center text-[11px] font-bold text-[#d4a373]">
          부결됐다 — 다시 지목한다 ({revote}/{VERDICT_MAX_REVOTES})
        </p>
      ) : null}
      <h2 className="mt-3 text-center text-base font-black tracking-tight text-neutral-100">
        AI 같은 사람을 한 명 지목하라
      </h2>
      <p className="mt-1 text-center text-[11px] leading-relaxed text-neutral-500">
        {revote > 0
          ? '앞서 지목한 사람은 처형되지 않았다. 다른 사람을 골라도 된다.'
          : '마감 전까지 몇 번이든 바꿀 수 있다. 자기 자신은 지목할 수 없다.'}
      </p>
      <div className={cardStyles.rule} aria-hidden>
        ◆
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {seats.map((s) => {
          const picked = myVote === s.id;
          return (
            <button
              key={s.id}
              type="button"
              disabled={s.isSelf}
              title={s.isSelf ? '자기 자신은 지목할 수 없다' : undefined}
              onClick={() => onVote(s.id)}
              className={`flex items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
                picked
                  ? 'bg-[#d4a373]/20 ring-2 ring-[#d4a373] shadow-[0_0_16px_rgba(212,163,115,0.3)]'
                  : 'bg-white/[0.04] ring-1 ring-[#d4a373]/15 hover:bg-[#d4a373]/10 hover:ring-[#d4a373]/40'
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
    <PanelShell kicker="Judgment — 생사 투표">
      <h2 className="mt-3 text-center text-base font-black tracking-tight text-neutral-100">
        <span className="text-[#d4a373]">{nominee?.nickname ?? '지목된 사람'}</span> 을(를)
        처형할 것인가
      </h2>
      <p className="mt-1 text-center text-[11px] leading-relaxed text-neutral-500">
        찬성이 과반일 때만 처형된다. 동수면 살아남는다.
      </p>
      <div className={cardStyles.rule} aria-hidden>
        ◆
      </div>

      {isNominee ? (
        <p className="mt-3 rounded-xl bg-white/5 px-4 py-3 text-center text-[12px] leading-relaxed text-neutral-400 ring-1 ring-white/10">
          당신이 지목됐다. <span className="text-neutral-200">당신은 투표할 수 없다.</span>{' '}
          결과를 기다려라.
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => onVerdict(true)}
            className={`rounded-xl px-4 py-3.5 text-sm font-black transition-all ${
              myVerdict === true
                ? 'bg-red-500/90 text-black shadow-[0_0_20px_rgba(239,68,68,0.4)]'
                : 'bg-white/[0.04] text-neutral-200 ring-1 ring-red-500/25 hover:bg-red-500/15 hover:ring-red-500/60'
            }`}
          >
            찬성 — 처형
          </button>
          <button
            type="button"
            onClick={() => onVerdict(false)}
            className={`rounded-xl px-4 py-3.5 text-sm font-black transition-all ${
              myVerdict === false
                ? 'bg-amber-400/90 text-black shadow-[0_0_20px_rgba(251,191,36,0.4)]'
                : 'bg-white/[0.04] text-neutral-200 ring-1 ring-amber-400/25 hover:bg-amber-400/15 hover:ring-amber-400/60'
            }`}
          >
            반대 — 생존
          </button>
        </div>
      )}

      {!isNominee && myVerdict === null ? (
        <p className="mt-3 text-center text-[11px] text-neutral-600">아직 고르지 않았다</p>
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
  const selfId = useWorldStore((s) => s.selfId);
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
  const nominee =
    reveal.nomineeId === null
      ? null
      : (reveal.identities.find((i) => i.id === reveal.nomineeId) ?? null);
  const nomineeRole = nominee ? identityRole(nominee) : null;

  /**
   * 내가 이겼는가 — 내 진영이 이긴 진영과 같으면 승리다 (§18.4). 전적의 won 과
   * **같은 판정**이다 (lib/server/match.ts 의 buildWorldMatchRows: role === winner) —
   * 여기서 다르게 판정하면 결과 화면과 기록이 서로 다른 말을 한다.
   * 내 좌석이 identities 에 없으면(판 밖에서 구경) 아무것도 띄우지 않는다.
   */
  const mine = selfId ? (reveal.identities.find((i) => i.id === selfId) ?? null) : null;
  const iWon = mine === null ? null : identityRole(mine) === reveal.winner;

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 p-6 backdrop-blur">
      {/*
        같은 카드 언어(panel)를 입는다. 광택(shine)은 뺐다 — 결과는 한 겹씩 열리는
        것 자체가 연출이라, 위로 번쩍이는 게 하나 더 있으면 시선이 갈린다.
        스크롤은 안쪽 div 가 맡는다 — panel 에 직접 걸면 액자선(frame)이 내용을
        따라 흘러내린다.
      */}
      <div className={`${cardStyles.deal} max-h-full w-full max-w-lg`}>
        <div
          className={`${cardStyles.panel} relative flex max-h-full flex-col overflow-hidden rounded-2xl`}
          style={{ '--rc': '#d4a373' } as React.CSSProperties}
        >
          <div aria-hidden className={cardStyles.frame} />
          <div className="overflow-y-auto p-6">
            <p className={`${cardStyles.kicker} mb-4 text-center`}>Result — 판의 결말</p>
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

        {/* ② 그는 누구였는가 — AI / 연기자 / 시민 (§18.4) */}
        <Layer show={stage >= 1}>
          <p className="mt-4 text-center text-[15px] font-bold">
            {nomineeRole === null ? (
              <span className="text-neutral-500">지목이 없어 정체를 열지 못했다</span>
            ) : nomineeRole === 'ai' ? (
              <span className="text-emerald-400">그는 AI 였다</span>
            ) : nomineeRole === 'actor' ? (
              <span className="text-[#d4a373]">그는 연기자였다 — AI 인 척한 사람</span>
            ) : (
              <span className="text-red-400">그는 시민이었다</span>
            )}
          </p>
        </Layer>

        {/* ③ 어느 편이 이겼는가 — 그리고 그게 **나의** 승패인가 */}
        <Layer show={stage >= 2}>
          <p className="mt-5 text-center">
            <span className="rounded-full border border-[#d4a373]/40 bg-[#d4a373]/10 px-5 py-2 text-[13px] font-black tracking-wide text-[#d4a373]">
              {WINNER_LABEL[reveal.winner]}
            </span>
          </p>
          {iWon !== null ? (
            <p
              className={`mt-4 text-center text-2xl font-black tracking-tight ${
                iWon
                  ? 'text-[#d4a373] drop-shadow-[0_0_18px_rgba(212,163,115,0.5)]'
                  : 'text-red-400'
              }`}
            >
              {iWon ? '당신의 승리' : '당신의 패배'}
            </p>
          ) : null}
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
                      className={`shrink-0 font-mono text-[10px] ${ROLE_TAG[identityRole(i)].className}`}
                    >
                      {ROLE_TAG[identityRole(i)].label}
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
              판이 끝난 방의 문 하나. 마지막 겹과 같이 나타난다 —
              결과가 다 열리기 전에 문부터 보이면 읽다 만 채로 나가게 된다.
              · 새로운 게임 시작하기 — 방을 떠나 입장 패널로. 연결·스토어 정리는
                page.tsx 의 leave 가 한다(여기는 신호만 올린다).
              ★ 「한 판 더」는 2026-08-07 사용자 결정으로 뺐다 — 방의 아무나 한 명이
                누르면 전원이 동의 없이 새 판에 끌려 들어가는 구조였다. 프로토콜의
                t:'rematch' 와 워커 핸들러는 남겨 뒀다(전방 호환) — 되살리려면
                이 자리에 버튼 하나와 page.tsx 의 sendRematch 배선만 다시 단다.
            */}
            <div className="mt-6">
              <button
                type="button"
                onClick={onLeave}
                className="w-full rounded-xl bg-[#d4a373]/90 px-4 py-3 text-sm font-bold text-black transition-colors hover:bg-[#d4a373]"
              >
                새로운 게임 시작하기
              </button>
            </div>
          </div>
        </Layer>
          </div>
        </div>
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
 * 투표·찬반이 공유하는 판. 화면 가운데에 역할 카드와 같은 카드 언어로 뜬다
 * (role-card.module.css 의 panel — 딜 입장 · 액자선 · 광택. --rc 는 월드 금색).
 *
 * ★ 바깥은 `pointer-events-none` 이고 **안쪽 카드만** 클릭을 받는다. 그래야
 *   판 바깥을 누른 클릭이 캔버스로 흘러가고, page.tsx 의 "캔버스를 직접 누른
 *   것만 잠금" 규칙이 그대로 산다(그 규칙은 지금 uiOpen 동안 꺼져 있지만,
 *   경계를 흐려 놓으면 다음에 되살릴 때 또 같은 사고가 난다).
 */
function PanelShell({ kicker, children }: { kicker: string; children: React.ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center p-6">
      <div className={`${cardStyles.deal} w-full max-w-md`}>
        <div
          className={`${cardStyles.panel} relative w-full overflow-hidden rounded-2xl p-6`}
          style={{ '--rc': '#d4a373' } as React.CSSProperties}
        >
          <div aria-hidden className={cardStyles.frame} />
          <div aria-hidden className={cardStyles.shine} />
          <p className={`${cardStyles.kicker} text-center`}>{kicker}</p>
          {children}
        </div>
      </div>
    </div>
  );
}
