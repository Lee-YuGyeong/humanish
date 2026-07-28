/**
 * 게임 화면 — 페이즈에 따라 분기. 소유: C (SPEC §2, §6, §12.5)
 *
 * 지켜야 하는 계약 네 가지.
 *   I1  클라이언트는 players가 아니라 public_players를 읽는다
 *   I2  카운트다운은 표시용이다. 판정은 서버가 한다
 *   I9  쓰기는 전부 /api를 거친다. anon 키는 읽기 전용이다
 *   I10 모든 구독·쿼리에 방 필터를 건다. 채널 이름은 room:<room_id>
 *
 * 화면은 라이트 전용이다 (app/globals.css의 `html { color-scheme: light }`).
 * dark: 변형을 새로 넣지 않는다.
 */
'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getBrowserClient } from '@/lib/server/supabase';
import { PlayerGrid } from '@/components/player-grid';
import {
  ArrowLeftIcon,
  CheckIcon,
  ChipIcon,
  CrownIcon,
  InfoIcon,
  SendIcon,
  SpyIcon,
  UserPlusIcon,
} from '@/components/ui/icons';
import type { Phase, PublicPlayer, Question, Role, Room } from '@/lib/game/types';

interface Me {
  player: PublicPlayer | null;
  is_host: boolean;
  answered: boolean;
  voted: boolean;
  /**
   * ★ 내 역할 하나뿐이다. 남의 역할은 reveal 전까지 어디에도 오지 않는다 (I1).
   * 배정 전(lobby)에는 null. 스파이가 자기가 스파이인 줄 알아야 게임이 성립한다 (SPEC §0).
   */
  role: Role | null;
}

interface AnswerRow {
  id: string;
  player_id: string;
  text: string;
}

interface VoteRow {
  voter_id: string;
  target_id: string;
  reason: string;
}

/**
 * /api/reveal 응답. 게임에서 정체가 클라이언트로 오는 곳은 여기 하나뿐이고,
 * 그 라우트가 phase와 참가 여부를 확인한 뒤에만 준다 (I1).
 */
interface RevealData {
  players: {
    id: string;
    nickname: string;
    seat: number;
    is_bot: boolean;
    role: Role | null;
    votes_received: number;
    score: number;
  }[];
  votes: { voter_id: string; target_id: string; reason: string; correct: boolean }[];
  rule: string[];
}

const PHASE_LABEL: Record<Phase, string> = {
  lobby: '대기실',
  question: '공통 질문',
  target: '지목 질문',
  chat: '자유 채팅',
  vote: '투표',
  reveal: '결과',
  replay: '다시 하기',
};

/** 남은 시간이 이 값 이하면 카운트다운이 붉어진다. 표시용 임계값이다 (I2). */
const URGENT_SECONDS = 10;

export function RoomView({ code }: { code: string }) {
  const [room, setRoom] = useState<Room | null>(null);
  const [players, setPlayers] = useState<PublicPlayer[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [answers, setAnswers] = useState<AnswerRow[]>([]);
  /** answers가 어느 질문의 답인지. 직전 라운드의 답일 수 있어서 함께 보여준다. */
  const [answerOf, setAnswerOf] = useState<Question | null>(null);
  const [votes, setVotes] = useState<VoteRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [remainMs, setRemainMs] = useState<number | null>(null);
  /** 쓰기 요청이 나가 있는 동안 버튼을 잠근다 */
  const [busy, setBusy] = useState(false);

  /** SPEC §12.5 — 서버 시각 - 내 시각. 카운트다운을 여기에 맞춘다. */
  const offsetRef = useRef(0);
  /** 같은 phase_seq로 전환을 두 번 부르지 않게 하는 표시 (I6) */
  const advancedSeqRef = useRef<number | null>(null);

  const serverNow = useCallback(() => Date.now() + offsetRef.current, []);

  /** 방 상태 · 참가자 · 질문 · 답변을 한꺼번에 다시 읽는다. 전부 방으로 스코프한다 (I10). */
  const refresh = useCallback(async () => {
    const db = getBrowserClient();

    const { data: r, error: roomErr } = await db
      .from('rooms')
      // ★ capacity를 빠뜨리면 room.capacity가 undefined가 되어 좌석 그리드가 0칸이 된다 (§17.6)
      .select('id, code, capacity, phase, phase_seq, phase_ends_at, round, host_id, roster_seq')
      .eq('code', code.toUpperCase())
      .maybeSingle();

    if (roomErr) return setError(roomErr.message);
    if (!r) return setError(`그런 방이 없다: ${code.toUpperCase()}`);

    const current = r as Room;
    setRoom(current);

    const [{ data: ps }, { data: qs }, { data: as }, { data: vs }, meRes] = await Promise.all([
      db.from('public_players').select('*').eq('room_id', current.id).order('seat'),
      db.from('questions').select('*').eq('room_id', current.id).order('round'),
      // RLS가 visible_at <= now()인 것만 준다. 아직 안 열린 답은 애초에 안 온다 (SPEC §7.2)
      db.from('answers').select('id, player_id, text, question_id').eq('room_id', current.id),
      // reveal 이후에만 보인다 (SPEC §7.2)
      db.from('votes').select('voter_id, target_id, reason').eq('room_id', current.id),
      fetch(`/api/me?room_id=${current.id}`).then((res) => res.json()),
    ]);

    setPlayers((ps ?? []) as PublicPlayer[]);
    setVotes((vs ?? []) as VoteRow[]);
    setMe(meRes as Me);

    const all = (qs ?? []) as Question[];
    const now =
      current.phase === 'target'
        ? all.filter((q) => q.kind === 'target').at(-1)
        : all.find((q) => q.kind === 'common' && q.round === current.round);
    setQuestion(now ?? null);

    /**
     * ★ 지금 질문의 답이 아니라 **가장 최근에 공개된 질문의 답**을 보여준다.
     *
     * 답은 그 페이즈가 끝나야 열린다 (answers.visible_at = phase_ends_at).
     * 그런데 열리는 순간이 곧 화면이 다음 질문으로 넘어가는 순간이라,
     * "지금 질문의 답"만 그리면 한 판 내내 아무것도 뜨지 않는다.
     * 라운드2를 푸는 동안 라운드1의 답이 남아 있어야 서로를 뜯어볼 수 있다.
     *
     * RLS가 visible_at이 지난 행만 주므로(SPEC §7.2) 여기 온 답은 전부 공개된 것이다.
     * 아직 안 열린 답은 애초에 이 목록에 없다 — 클라이언트가 거를 일이 아니다.
     */
    const rows = (as ?? []) as (AnswerRow & { question_id: string })[];
    const byQuestion = new Map<string, AnswerRow[]>();
    for (const a of rows) {
      const bucket = byQuestion.get(a.question_id);
      if (bucket) bucket.push(a);
      else byQuestion.set(a.question_id, [a]);
    }

    // 진행 순서: 공통1 → 공통2 → 지목. target은 항상 마지막이다 (SPEC §5.1).
    const orderOf = (q: Question) => (q.kind === 'target' ? 3 : q.round);
    const revealed = all
      .filter((q) => byQuestion.has(q.id))
      .sort((a, b) => orderOf(a) - orderOf(b))
      .at(-1);

    setAnswerOf(revealed ?? null);
    setAnswers(revealed ? (byQuestion.get(revealed.id) ?? []) : []);
  }, [code]);

  /**
   * 서버 시각 오프셋 (SPEC §12.5). 접속할 때 한 번.
   *
   * ★ 응답을 검사한 뒤에만 쓴다. /api/time은 실패하면 { error } + 500을 주는데,
   *   그걸 그대로 구조분해하면 now가 undefined → NaN이 되고, offset이 NaN으로 굳는다.
   *   그러면 serverNow()도 NaN이고 `left <= 0`이 영영 false라서 **그 탭은 페이즈
   *   만료를 한 번도 감지하지 못한다.** 화면에는 'NaN초'만 뜨고 타이머가 죽은 건
   *   안 보인다. 실패하면 오프셋 0(= 로컬 시계)으로 두는 편이 낫다 —
   *   어차피 판정은 서버가 한다 (I2).
   */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const before = Date.now();
        const res = await fetch('/api/time');
        if (!res.ok) return;
        const { now } = await res.json();
        const t = new Date(now).getTime();
        if (!alive || !Number.isFinite(t)) return;
        // 왕복 시간의 절반을 빼서 대략 보정한다
        offsetRef.current = t - (before + Date.now()) / 2;
      } catch {
        // 오프셋 없이 로컬 시계로 간다. 몇 초 어긋나도 서버가 다시 판정한다.
      }
    })();
    void refresh();
    return () => {
      alive = false;
    };
  }, [refresh]);

  /** rooms 구독. ★ 반드시 id로 필터를 건다 — 없으면 다른 방 전환이 내 화면에 들어온다 (I10) */
  useEffect(() => {
    if (!room) return;
    const db = getBrowserClient();

    const channel = db
      .channel(`room:${room.id}`) // 채널 이름에 code가 아니라 room_id (SPEC §6.3)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${room.id}` },
        () => {
          // phase_seq든 roster_seq든 바뀌었으면 다시 읽는다 (SPEC §17.3)
          void refresh();
        },
      )
      .subscribe();

    return () => {
      void db.removeChannel(channel);
    };
  }, [room?.id, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 백그라운드 탭에서 돌아오면 즉시 재동기화 (SPEC §12.1 2번) */
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  /** 카운트다운 + 만료 감지 (SPEC §5.2 1번 호출자) */
  useEffect(() => {
    if (!room?.phase_ends_at) {
      setRemainMs(null);
      return;
    }
    const endsAt = new Date(room.phase_ends_at).getTime();

    const tick = () => {
      const left = endsAt - serverNow();
      setRemainMs(left);

      if (left <= 0 && advancedSeqRef.current !== room.phase_seq) {
        // 요청이 나가 있는 동안 다시 부르지 않게 먼저 찍는다 (I6)
        advancedSeqRef.current = room.phase_seq;

        void fetch('/api/phase/advance', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ room_id: room.id, expected_seq: room.phase_seq }),
        })
          .then((res) => res.json())
          .then((data) => {
            // ★ 실패했으면 무장을 푼다. 내 시계가 조금 빨라서 만료 전에 부르면
            //   서버가 advanced:false를 준다 (advance_phase 3단계). 그때 이 표시를
            //   그대로 두면 **그 페이즈에서는 다시는 전환을 시도하지 않는다.**
            //   방에 사람이 나뿐이면 워치독이 훑을 때까지 화면이 0초에 멈춘다.
            //   I6이 막아야 하는 건 중복 전환이지 재시도가 아니다.
            if (data?.advanced === false) advancedSeqRef.current = null;
          })
          .catch(() => {
            advancedSeqRef.current = null; // 네트워크 실패도 재시도 대상이다
          })
          .finally(() => void refresh());
      }
    };

    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [room?.id, room?.phase_seq, room?.phase_ends_at, serverNow, refresh]);

  /**
   * 모든 쓰기가 지나는 통로. 클라이언트는 anon 키로 쓰지 않는다 (I9).
   *
   * ★ 한 번에 하나만 나간다. 시작 버튼을 연타하면 POST /api/room/start가 둘 다
   *   나가고, 둘 다 lobby·phase_seq를 읽은 뒤 각자의 시드로 역할을 upsert한다.
   *   먼저 도착한 쪽이 전환하면 두 번째는 409를 받아 **정상 시작된 판에 빨간
   *   에러 배너가 남고**, 그 upsert가 전환 뒤에 착지하면 이미 시작된 판의
   *   스파이가 다른 사람으로 바뀐다.
   */
  const inFlightRef = useRef(false);
  const post = useCallback(
    async (path: string, body: unknown) => {
      if (inFlightRef.current) return false;
      inFlightRef.current = true;
      setBusy(true);
      try {
        setError(null);
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) setError(data.error ?? '알 수 없는 오류');
        await refresh();
        return res.ok;
      } finally {
        inFlightRef.current = false;
        setBusy(false);
      }
    },
    [refresh],
  );

  if (error && !room) {
    return (
      <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6">
        <p className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm font-medium text-red-600">
          {error}
        </p>
        <Link
          href="/main"
          className="inline-flex items-center gap-2 text-sm font-bold text-neutral-400 transition-colors hover:text-neutral-900"
        >
          <ArrowLeftIcon className="h-4 w-4" />
          로비로
        </Link>
      </main>
    );
  }

  if (!room) {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-neutral-400">
        불러오는 중…
      </main>
    );
  }

  const seconds = remainMs == null ? null : Math.max(0, Math.ceil(remainMs / 1000));
  const urgent = seconds != null && seconds <= URGENT_SECONDS;

  return (
    <div className="flex min-h-screen flex-col bg-neutral-50/50 text-neutral-900">
      <header className="sticky top-0 z-10 border-b border-neutral-200 bg-white/85 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              href="/main"
              aria-label="로비로"
              className="shrink-0 text-neutral-400 transition-colors hover:text-neutral-900"
            >
              <ArrowLeftIcon className="h-4 w-4" />
            </Link>
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-neutral-400">
                Room
              </p>
              <h1 className="truncate font-mono text-lg font-black tracking-[0.25em] text-neutral-900">
                {room.code}
              </h1>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <span className="rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-xs font-bold text-neutral-900">
              {PHASE_LABEL[room.phase]}
              {room.phase === 'question' && (
                <span className="ml-1.5 font-mono text-neutral-400 tabular-nums">
                  {room.round}/2
                </span>
              )}
            </span>
            {seconds != null && (
              <span
                className={[
                  'min-w-14 rounded-full px-3 py-1.5 text-center font-mono text-sm font-black tabular-nums transition-colors',
                  urgent ? 'bg-red-50 text-red-600' : 'bg-neutral-900 text-white',
                ].join(' ')}
                aria-live="polite"
              >
                {seconds}초
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 px-6 py-6">
        {room.phase === 'lobby' && (
          <LobbyHero code={room.code} capacity={room.capacity} seated={players.length} />
        )}

        <PlayerGrid players={players} capacity={room.capacity} meId={me?.player?.id} />

        {/* 내가 스파이라는 건 나만 본다. 남의 역할은 reveal까지 아무 데도 오지 않는다 (I1) */}
        {me?.role === 'spy' && room.phase !== 'reveal' && room.phase !== 'replay' && (
          <p className="flex items-center gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800">
            <SpyIcon className="h-4 w-4 shrink-0" />
            너는 스파이다 — 기계인 척해서 표를 끌어와라. 이건 너에게만 보인다.
          </p>
        )}

        <Panel
          room={room}
          players={players}
          me={me}
          question={question}
          answers={answers}
          answerOf={answerOf}
          votes={votes}
          post={post}
          busy={busy}
        />

        {error && (
          <p className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-600">
            {error}
          </p>
        )}

        <p className="mt-auto flex items-center gap-2 pt-2 text-[11px] text-neutral-400">
          <InfoIcon className="h-3.5 w-3.5 shrink-0" />
          타이머는 표시용이다. 페이즈 전환은 서버가 정한다 (SPEC I2).
        </p>
      </main>
    </div>
  );
}

/**
 * 대기실 머리말 — 방 코드를 크게 띄우고 복사시킨다.
 *
 * "N / 정원"의 N은 지금 앉아 있는 사람 수다.
 *
 * ★ 이 표시는 **현재 봇 수는 못 알려주지만 미래 봇 수는 알려준다.** lobby에는
 *   아직 봇이 없지만(SPEC §17.4 — 시작 버튼에서 채운다), 시작한 순간의
 *   `정원 − N`이 곧 봇 수이고 빈 좌석 번호가 곧 봇의 자리다. 이건 이 화면의
 *   버그가 아니라 **§15-3(봇을 채우는 시점)이 미결정이라 생긴 구멍**이며,
 *   lib/server/room.ts의 fillWithBots 주석에도 같은 내용이 적혀 있다.
 *   §15-3이 정해지기 전까지 화면에서 완전히 막을 방법은 없다 —
 *   인원을 감춰도 좌석 그리드의 빈칸이 같은 정보를 준다.
 *   그래서 최소한 **인트로·규칙 문구가 "빈자리 = 기계"를 알려주지는 않게** 한다.
 */
function LobbyHero({
  code,
  capacity,
  seated,
}: {
  code: string;
  capacity: number;
  seated: number;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // https가 아닌 곳에는 clipboard API가 없다. 코드가 화면에 크게 떠 있으니
      // 눈으로 옮겨 적으면 된다 — 실패를 오류로 띄우지 않는다.
    }
  };

  return (
    <section className="rounded-2xl border border-neutral-200 bg-white p-6 text-center shadow-sm">
      <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-neutral-400">
        방 코드
      </p>
      <p className="mt-2 font-mono text-5xl font-black tracking-[0.3em] text-neutral-900">
        {code}
      </p>
      <p className="mt-3 text-sm text-neutral-400">
        친구에게 이 코드를 알려주면 들어온다.
      </p>

      <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex items-center gap-2 rounded-xl border border-neutral-200 bg-white px-4 py-2.5 text-xs font-bold text-neutral-900 transition-colors hover:border-indigo-400 hover:text-indigo-600"
        >
          {copied ? <CheckIcon className="h-3.5 w-3.5 text-emerald-600" /> : null}
          {copied ? '복사됨' : '코드 복사'}
        </button>
        <span className="inline-flex items-center gap-2 rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-2.5 text-xs font-bold text-neutral-500">
          <UserPlusIcon className="h-3.5 w-3.5 text-indigo-500" />
          <span className="font-mono tabular-nums text-neutral-900">
            {seated} / {capacity}
          </span>
        </span>
      </div>
    </section>
  );
}

function Panel({
  room,
  players,
  me,
  question,
  answers,
  answerOf,
  votes,
  post,
  busy,
}: {
  room: Room;
  players: PublicPlayer[];
  me: Me | null;
  question: Question | null;
  answers: AnswerRow[];
  /** answers가 어느 질문의 답인지. 직전 라운드 것일 수 있다. */
  answerOf: Question | null;
  votes: VoteRow[];
  post: (path: string, body: unknown) => Promise<boolean>;
  busy: boolean;
}) {
  const [text, setText] = useState('');
  const [target, setTarget] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const nameOf = (id: string) => players.find((p) => p.id === id)?.nickname ?? '?';

  if (!me?.player) {
    return (
      <Box>
        <p className="text-sm font-bold text-neutral-900">이 방의 참가자가 아니다.</p>
        <Link
          href="/main"
          className="inline-flex items-center gap-2 text-sm font-bold text-indigo-600 transition-colors hover:text-indigo-500"
        >
          <ArrowLeftIcon className="h-4 w-4" />
          코드로 다시 입장하기
        </Link>
      </Box>
    );
  }

  if (room.phase === 'lobby') {
    return (
      <>
        <Box>
          <Label>방 규칙</Label>
          <ul className="flex flex-col gap-2">
            {/*
              ★ 봇이 몇 명인지 절대 쓰지 않는다 (I1). 정원과 사람 수의 차이를 화면이
                계산해 주면 그게 곧 봇 수다. "몇 자리인지는 공개되지 않는다"가 정답이다.
            */}
            <RuleRow
              icon={<UserPlusIcon className="h-4 w-4" />}
              label="정원"
              value={`${room.capacity}명`}
            />
            <RuleRow
              icon={<SpyIcon className="h-4 w-4" />}
              label="스파이"
              value="사람 중 1명. 사람이 2명 이상일 때만 생긴다"
              accent
            />
            <RuleRow
              icon={<CheckIcon className="h-4 w-4" />}
              label="시민"
              value="스파이가 아닌 나머지 사람 전원"
            />
            {/*
              아이콘도 문구다. 여기에 ChipIcon(진짜 AI)을 쓰면 "빈자리 = AI"라고
              그림으로 말해버린다. SPEC §0은 빈자리를 봇이 채운다는 사실 자체를
              공개하지 않는다고 못박았으므로 중립적인 InfoIcon을 쓴다.
            */}
            <RuleRow
              icon={<InfoIcon className="h-4 w-4" />}
              label="빈자리"
              value="시작할 때 채워진다. 몇 자리인지는 공개되지 않는다"
            />
          </ul>
        </Box>

        <Box>
          {me.is_host ? (
            <>
              <p className="flex items-center gap-2 text-xs font-bold text-neutral-400">
                <CrownIcon className="h-4 w-4 text-indigo-500" />
                방장이다. 사람이 다 모이지 않아도 시작할 수 있다.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void post('/api/room/start', { room_id: room.id })}
                className="w-full rounded-xl bg-indigo-600 px-6 py-3.5 text-sm font-black uppercase tracking-[0.2em] text-white transition-colors hover:bg-indigo-500 disabled:cursor-default disabled:opacity-50"
              >
                {busy ? '시작하는 중…' : '게임 시작'}
              </button>
            </>
          ) : (
            <p className="flex items-center justify-center gap-2 py-2 text-sm text-neutral-400">
              <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-500" />
              방장이 시작하기를 기다리는 중…
            </p>
          )}
        </Box>
      </>
    );
  }

  if (room.phase === 'question' || room.phase === 'target') {
    const isTargetPhase = room.phase === 'target';
    const iAmTarget = question?.target_id === me.player.id;
    const canAnswer = !me.answered && (!isTargetPhase || iAmTarget);

    return (
      <Box>
        <Label>{isTargetPhase ? '지목 질문' : '공통 질문'}</Label>
        <p className="text-lg font-bold leading-snug tracking-tight text-neutral-900">
          {question?.text ?? '질문을 기다리는 중…'}
        </p>
        {isTargetPhase && question?.target_id && (
          <p className="text-sm font-bold text-indigo-600">
            → {nameOf(question.target_id)}에게
          </p>
        )}

        {canAnswer ? (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void post('/api/answer', { room_id: room.id, text }).then((ok) => ok && setText(''));
            }}
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={300}
              placeholder="답을 쓴다"
              className={INPUT}
            />
            <button type="submit" disabled={!text.trim()} className={PRIMARY_BUTTON}>
              제출
            </button>
          </form>
        ) : (
          <p className="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-400">
            {me.answered
              ? '제출했다. 시간이 끝나면 전부 공개된다.'
              : '지목받은 사람이 답하는 중…'}
          </p>
        )}

        {answers.length > 0 && (
          <ul className="flex flex-col gap-2 border-t border-neutral-100 pt-4">
            {/*
              지금 질문의 답이 아니라 직전 질문의 답일 수 있다 — 답은 페이즈가
              끝나야 열리기 때문이다. 어느 질문의 답인지 밝히지 않으면 화면이
              엉뚱한 대화를 하는 것처럼 보인다.
            */}
            {answerOf != null && answerOf.id !== question?.id && (
              <li className="text-[11px] text-neutral-400">
                <span className="font-bold uppercase tracking-[0.2em]">지난 질문</span>{' '}
                {answerOf.text}
              </li>
            )}
            {answers.map((a) => (
              <li
                key={a.id}
                className="rounded-xl border border-neutral-200 bg-neutral-50/70 px-4 py-3"
              >
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-neutral-400">
                  {nameOf(a.player_id)}
                </p>
                <p className="mt-1 text-sm leading-relaxed text-neutral-900">{a.text}</p>
              </li>
            ))}
          </ul>
        )}
      </Box>
    );
  }

  if (room.phase === 'chat') {
    return (
      <>
        {/*
          ★ chat 페이즈에 답변을 같이 띄운다. SPEC §5.3이 target을 60초에서 30초로
            줄이면서 "답을 뜯어보는 시간은 바로 뒤 chat 120초가 맡는다"고 정했다.
            그 답이 화면에 없으면 120초 동안 뜯어볼 것이 없다.
        */}
        {answers.length > 0 && (
          <Box>
            <Label>지난 답변</Label>
            {answerOf && (
              <p className="text-sm font-bold text-neutral-900">{answerOf.text}</p>
            )}
            <ul className="flex flex-col gap-2">
              {answers.map((a) => (
                <li
                  key={a.id}
                  className="rounded-xl border border-neutral-200 bg-neutral-50/70 px-4 py-3"
                >
                  <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-neutral-400">
                    {nameOf(a.player_id)}
                  </p>
                  <p className="mt-1 text-sm leading-relaxed text-neutral-900">{a.text}</p>
                </li>
              ))}
            </ul>
          </Box>
        )}
        <ChatPanel room={room} nameOf={nameOf} meId={me.player.id} post={post} />
      </>
    );
  }

  if (room.phase === 'vote') {
    return (
      <Box>
        <Label>투표</Label>
        <p className="text-lg font-bold tracking-tight text-neutral-900">누가 AI인가?</p>
        <PlayerGrid
          players={players}
          capacity={room.capacity}
          meId={me.player.id}
          selectable={!me.voted}
          selectedId={target}
          onSelect={setTarget}
        />
        {me.voted ? (
          <p className="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-400">
            투표했다. 결과는 전원이 마치면 공개된다.
          </p>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void post('/api/vote', { room_id: room.id, target_id: target, reason });
            }}
          >
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={200}
              placeholder="이유 (선택)"
              className={INPUT}
            />
            <button type="submit" disabled={!target} className={PRIMARY_BUTTON}>
              투표
            </button>
          </form>
        )}
      </Box>
    );
  }

  // reveal · replay
  return <RevealPanel room={room} me={me} votes={votes} nameOf={nameOf} />;
}

/**
 * 자유 채팅. 소유: C (SPEC §5.4, §13-6)
 *
 * ★ Broadcast를 쓰지 않고 public_messages를 짧게 폴링한다.
 *   봇 메시지는 타이핑 지연 때문에 미래 visible_at을 갖는데, Broadcast는 insert 순간에
 *   나가므로 도착 시각과 표시 시각의 간격이 봇만 유독 길어진다. devtools를 열면
 *   그것만으로 봇이 갈린다 (I1). 뷰가 visible_at이 지난 행만 내보내므로 이쪽은 샐 게 없다.
 *
 *   대가는 최대 1.5초의 지연이다. 봇이 일부러 2~8초를 끄는 판에서 문제가 되지 않는다.
 */
function ChatPanel({
  room,
  meId,
  nameOf,
  post,
}: {
  room: Room;
  meId: string;
  nameOf: (id: string) => string;
  post: (path: string, body: unknown) => Promise<boolean>;
}) {
  const [messages, setMessages] = useState<{ id: string; player_id: string; text: string }[]>([]);
  const [text, setText] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const db = getBrowserClient();
    let alive = true;

    const pull = async () => {
      const { data } = await db
        .from('public_messages')
        .select('id, player_id, text, visible_at')
        .eq('room_id', room.id) // 방 필터 (I10)
        .order('visible_at');
      if (alive && data) setMessages(data);
    };

    void pull();
    const id = setInterval(pull, 1500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [room.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  return (
    <Box>
      <Label>자유 채팅</Label>
      <p className="text-sm text-neutral-400">
        누가 AI 같은지 얘기해본다. 시간이 지나면 투표로 넘어간다.
      </p>

      <ul className="flex max-h-72 flex-col gap-3 overflow-y-auto rounded-xl border border-neutral-200 bg-neutral-50/60 p-4">
        {messages.length === 0 && (
          <li className="py-6 text-center text-sm text-neutral-400">
            아직 아무도 말하지 않았다.
          </li>
        )}
        {messages.map((m) => {
          const mine = m.player_id === meId;
          return (
            <li key={m.id} className={mine ? 'flex flex-col items-end' : 'flex flex-col items-start'}>
              <span className="mb-1 px-1 text-[10px] font-bold uppercase tracking-[0.15em] text-neutral-400">
                {nameOf(m.player_id)}
              </span>
              <span
                className={[
                  'max-w-[80%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed',
                  mine
                    ? 'rounded-br-sm bg-indigo-600 text-white'
                    : 'rounded-bl-sm border border-neutral-200 bg-white text-neutral-900',
                ].join(' ')}
              >
                {m.text}
              </span>
            </li>
          );
        })}
        <div ref={bottomRef} />
      </ul>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const t = text.trim();
          if (!t) return;
          setText('');
          void post('/api/message', { room_id: room.id, text: t });
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={200}
          placeholder="말한다"
          className={INPUT}
        />
        <button
          type="submit"
          disabled={!text.trim()}
          aria-label="보내기"
          className={PRIMARY_BUTTON}
        >
          <SendIcon className="h-4 w-4" />
        </button>
      </form>
    </Box>
  );
}

/** 역할 배지 모양. role이 null이면 시민으로 본다 (원래 표시 규칙 그대로다). */
const ROLE_BADGE = {
  ai: { label: 'AI', tone: 'border-indigo-200 bg-indigo-50 text-indigo-700', Icon: ChipIcon },
  spy: { label: '스파이', tone: 'border-amber-200 bg-amber-50 text-amber-700', Icon: SpyIcon },
  citizen: { label: '시민', tone: 'border-neutral-200 bg-neutral-50 text-neutral-500', Icon: CheckIcon },
} as const;

function RoleBadge({ role }: { role: Role | null }) {
  const badge = role === 'ai' ? ROLE_BADGE.ai : role === 'spy' ? ROLE_BADGE.spy : ROLE_BADGE.citizen;
  const Icon = badge.Icon;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-bold ${badge.tone}`}
    >
      <Icon className="h-3.5 w-3.5" />
      {badge.label}
    </span>
  );
}

/** 정답 공개. 정체는 /api/reveal에서만 온다 — 그 라우트가 페이즈와 참가 여부를 확인한다. */
function RevealPanel({
  room,
  me,
  votes,
  nameOf,
}: {
  room: Room;
  me: Me;
  votes: VoteRow[];
  nameOf: (id: string) => string;
}) {
  const [data, setData] = useState<RevealData | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    void fetch(`/api/reveal?room_id=${room.id}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setFailed(d.error) : setData(d as RevealData)));
  }, [room.id]);

  if (failed) {
    return (
      <Box>
        <p className="text-sm font-medium text-red-600">{failed}</p>
      </Box>
    );
  }
  if (!data) {
    return (
      <Box>
        <p className="py-6 text-center text-sm text-neutral-400">집계하는 중…</p>
      </Box>
    );
  }

  const ranked = [...data.players].sort((a, b) => b.score - a.score);
  const myVote = votes.find((v) => v.voter_id === me.player?.id);
  const iWasRight = myVote != null && data.players.find((p) => p.id === myVote.target_id)?.is_bot;

  const verdict =
    myVote == null
      ? { text: '투표하지 않았다', sub: '다음 판에는 한 명을 골라보자', tone: 'border-neutral-200 bg-neutral-50 text-neutral-500' }
      : iWasRight
        ? { text: '맞혔다', sub: 'AI를 골랐다', tone: 'border-emerald-200 bg-emerald-50 text-emerald-700' }
        : { text: '틀렸다', sub: '사람을 골랐다', tone: 'border-red-200 bg-red-50 text-red-600' };

  return (
    <>
      <section className={`rounded-2xl border p-6 text-center shadow-sm ${verdict.tone}`}>
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] opacity-60">결과</p>
        <p className="mt-2 text-4xl font-black tracking-tight">{verdict.text}</p>
        <p className="mt-1 text-sm opacity-80">{verdict.sub}</p>
      </section>

      <Box>
        <Label>순위</Label>
        <ol className="flex flex-col gap-2">
          {ranked.map((p, i) => {
            const isMe = p.id === me.player?.id;
            return (
              <li
                key={p.id}
                className={[
                  'flex items-center gap-3 rounded-xl border p-3',
                  isMe ? 'border-indigo-300 bg-indigo-50/60' : 'border-neutral-200 bg-white',
                ].join(' ')}
              >
                <span className="w-5 shrink-0 text-center font-mono text-sm font-black tabular-nums text-neutral-300">
                  {i + 1}
                </span>
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-900 font-mono text-xs font-bold tabular-nums text-white"
                  aria-hidden
                >
                  {p.seat}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold text-neutral-900">
                    {p.nickname}
                    {isMe && <span className="ml-1.5 text-[11px] text-indigo-600">나</span>}
                  </span>
                  <span className="block text-[10px] font-bold uppercase tracking-[0.15em] text-neutral-400">
                    받은 표 {p.votes_received}
                  </span>
                </span>
                <RoleBadge role={p.role} />
                <span className="w-14 shrink-0 text-right font-mono text-lg font-black tabular-nums text-neutral-900">
                  {p.score}
                </span>
              </li>
            );
          })}
        </ol>
      </Box>

      <Box>
        <Label>누가 누구를 찍었나</Label>
        {data.votes.length === 0 ? (
          <p className="text-sm text-neutral-400">투표가 없다.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.votes.map((v) => (
              <li
                key={v.voter_id}
                className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-xl border border-neutral-200 bg-neutral-50/70 px-4 py-2.5 text-sm"
              >
                <span className="font-bold text-neutral-900">{nameOf(v.voter_id)}</span>
                <span className="text-neutral-300">→</span>
                <span className="font-bold text-neutral-900">{nameOf(v.target_id)}</span>
                <span
                  className={
                    v.correct ? 'font-bold text-emerald-600' : 'font-bold text-neutral-300'
                  }
                >
                  {v.correct ? '○' : '✕'}
                </span>
                {v.reason && <span className="text-neutral-400">· {v.reason}</span>}
              </li>
            ))}
          </ul>
        )}

        <p className="border-t border-neutral-100 pt-4 text-[11px] leading-relaxed text-neutral-400">
          채점: {data.rule.join(' · ')}
          <br />이 규칙은 SPEC에 없다. 정하면 app/api/reveal/route.ts와 lib/game/rules.ts를
          고친다.
        </p>

        <Link
          href="/main"
          className="inline-flex items-center gap-2 text-sm font-bold text-indigo-600 transition-colors hover:text-indigo-500"
        >
          <ArrowLeftIcon className="h-4 w-4" />
          로비로
        </Link>
      </Box>
    </>
  );
}

/* ─────────────────────────────── 공통 조각 ─────────────────────────────── */

const INPUT =
  'min-w-0 flex-1 rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-900 transition-colors placeholder:text-neutral-400 focus:border-indigo-500 focus:outline-none';

const PRIMARY_BUTTON =
  'shrink-0 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-bold text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400';

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-neutral-400">{children}</p>
  );
}

function RuleRow({
  icon,
  label,
  value,
  accent = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <li className="flex items-center gap-3 rounded-xl border border-neutral-200 bg-neutral-50/70 px-3 py-2.5">
      <span
        className={[
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
          accent ? 'bg-indigo-50 text-indigo-600' : 'bg-white text-neutral-400',
        ].join(' ')}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] font-bold uppercase tracking-[0.2em] text-neutral-400">
          {label}
        </span>
        <span className="block text-sm font-medium text-neutral-900">{value}</span>
      </span>
    </li>
  );
}

function Box({ children }: { children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
      {children}
    </section>
  );
}
