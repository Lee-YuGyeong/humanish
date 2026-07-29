/**
 * 게임 화면 — 페이즈에 따라 분기. 소유: C (SPEC §2, §6, §12.5)
 *
 * 지켜야 하는 계약 네 가지.
 *   I1  클라이언트는 players가 아니라 public_players를 읽는다
 *   I2  카운트다운은 표시용이다. 판정은 서버가 한다
 *   I9  쓰기는 전부 /api를 거친다. anon 키는 읽기 전용이다
 *   I10 모든 구독·쿼리에 방 필터를 건다. 채널 이름은 room:<room_id>
 *
 * 화면은 창고 시네마의 문법을 따른다 (app/globals.css).
 *   .screen  영사막 — 질문·결과처럼 **모두가 보는 것**
 *   .case    플라이트 케이스 — 좌석·규칙·조작판처럼 방에 놓인 물건
 *   .cut     파인 면 — 입력칸·로그
 *   .rib     골강판 — 머리말 같은 구조물
 * 배경은 app/layout.tsx 의 .room 이 맡으므로 여기서 배경색을 칠하지 않는다.
 * 색을 더할 때는 씬(app/world/warehouse.tsx)에 있는 색인지 먼저 본다.
 */
'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
import type { AnswerRow, VoteRow } from '@/lib/api/db';
import type { MeResponse } from '@/lib/api/room';
import { currentQuestion, nicknameOf, revealedAnswers } from '@/lib/queries/derive';
import {
  REQUEST,
  useAdvancePhase,
  useCastVote,
  useSayLobbyLine,
  useSendMessage,
  useSetLobbyReady,
  useStartRoom,
  useSubmitAnswer,
} from '@/lib/queries/mutations';
import { usePhaseCountdown } from '@/lib/queries/phase-clock';
import { useRoomRealtime } from '@/lib/queries/realtime';
import {
  useAnswers,
  useInvalidateRoom,
  useLobbyLines,
  useMe,
  useMessages,
  useQuestions,
  useReveal,
  useRoomByCode,
  useRoster,
  useServerClock,
  useVotes,
} from '@/lib/queries/room';
import {
  roomActions,
  selectAnswerDraft,
  selectCanCastVote,
  selectCanSendChat,
  selectCanSubmitAnswer,
  selectChatDraft,
  selectError,
  selectIsBusy,
  selectIsPending,
  selectVoteReason,
  selectVoteTarget,
  useRoomDispatch,
  useRoomUi,
} from '@/lib/store/room';
import type { Phase, PublicPlayer, Question, Role, Room } from '@/lib/game/types';

const PHASE_LABEL: Record<Phase, string> = {
  lobby: '대기실',
  question: '공통 질문',
  target: '지목 질문',
  chat: '자유 채팅',
  vote: '투표',
  reveal: '결과',
  replay: '다시 하기',
};

/** 남은 시간이 이 값 이하면 계기판이 붉어진다. 표시용 임계값이다 (I2). */
const URGENT_SECONDS = 10;

export function RoomView({ code }: { code: string }) {
  /**
   * ┌─ 서버 값은 전부 쿼리다 (lib/queries) ──────────────────────────────────────┐
   * │ 예전에는 refresh() 하나가 이 여섯 개를 **매번 전부** 다시 읽고 setState 를  │
   * │ 여섯 번 했다. 답변만 바뀌어도 좌석·질문·투표가 같이 새로 그려졌고, 요청이   │
   * │ 겹치면 늦게 온 응답이 먼저 온 응답을 덮어썼다. 이제 캐시가 쿼리마다 따로다. │
   * └────────────────────────────────────────────────────────────────────────────┘
   */
  const roomQuery = useRoomByCode(code);
  const room = roomQuery.data ?? null;
  const roomId = room?.id;

  const { data: players = [] } = useRoster(roomId);
  const { data: me = null } = useMe(roomId);
  const { data: questions = [] } = useQuestions(roomId);
  const { data: answerRows = [] } = useAnswers(roomId);
  const { data: votes = [] } = useVotes(roomId);

  /** 방이 바뀌었다는 신호가 오면 그 방 쿼리를 통째로 무효화한다 (SPEC §17.3, I10) */
  const invalidate = useInvalidateRoom(code, roomId);
  useRoomRealtime(roomId, invalidate);

  /** 카운트다운은 표시용이다. 전환은 서버가 정한다 (I2) */
  const { serverNow } = useServerClock();
  const advance = useAdvancePhase(code, roomId);
  const requestAdvance = useCallback(
    (expectedSeq: number) => advance.mutateAsync({ expectedSeq }),
    [advance],
  );
  const remainMs = usePhaseCountdown(room, serverNow, requestAdvance);

  /** 쓰기 실패 배너. 성공하면 스스로 사라진다 (lib/store/room/reducer.ts) */
  const error = useRoomUi(selectError);
  const dispatch = useRoomDispatch();

  /** 방을 떠날 때 초안·잠금을 지운다. 안 지우면 다음 방에 새어 나간다 */
  useEffect(() => () => dispatch(roomActions.roomLeft()), [dispatch]);

  /** 표시 규칙은 순수 함수로 뺐다 (lib/queries/derive.ts — 단위 테스트 대상) */
  const question = useMemo(
    () => (room ? currentQuestion(questions, room.phase, room.round) : null),
    [questions, room],
  );
  const revealed = useMemo(() => revealedAnswers(questions, answerRows), [questions, answerRows]);

  /**
   * 방 자체를 못 읽은 경우만 전체 화면 오류다.
   * 쓰기 실패(위 error)는 화면을 유지한 채 배너로 알린다.
   */
  const loadError = roomQuery.isError
    ? roomQuery.error.message
    : roomQuery.isSuccess && roomQuery.data === null
      ? `그런 방이 없다: ${code.toUpperCase()}`
      : null;

  if (loadError) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-5 px-6">
        <p className="case border-signal/30 px-6 py-5 text-sm text-signal">{loadError}</p>
        <Link
          href="/main"
          className="stencil inline-flex items-center gap-2 text-[10px] text-grime transition-colors hover:text-tung"
        >
          <ArrowLeftIcon className="h-3.5 w-3.5" />
          로비로
        </Link>
      </main>
    );
  }

  if (!room) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="stencil text-[10px] text-grime">loading…</p>
      </main>
    );
  }

  const seconds = remainMs == null ? null : Math.max(0, Math.ceil(remainMs / 1000));
  const urgent = seconds != null && seconds <= URGENT_SECONDS;

  return (
    <div className="flex min-h-screen flex-col">
      {/* 골강판 머리말 — 방 번호판과 계기판이 붙어 있다 */}
      <header className="rib sticky top-0 z-10 border-b border-black/70 shadow-[0_1px_0_rgba(214,207,194,0.05)]">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-6 py-3">
          <div className="flex min-w-0 items-center gap-4">
            <Link
              href="/main"
              aria-label="로비로"
              className="shrink-0 text-ash transition-colors hover:text-tung"
            >
              <ArrowLeftIcon className="h-4 w-4" />
            </Link>
            <div className="min-w-0">
              <p className="stencil text-[8px] text-ash">room</p>
              <h1 className="readout truncate text-xl tracking-[0.3em] text-linen">{room.code}</h1>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <span className="stencil text-[9px] text-tung/70">
              {PHASE_LABEL[room.phase]}
              {room.phase === 'question' && (
                <span className="readout ml-2 text-ash">{room.round}/2</span>
              )}
            </span>
            {seconds != null && (
              // 장비에 박힌 LED 계기판. 마지막 10초는 벽 비상등처럼 붉게 탄다
              <output
                className={[
                  'cut readout min-w-16 px-3 py-1.5 text-center text-lg',
                  urgent ? 'lit-signal' : 'lit-tung',
                ].join(' ')}
                aria-live="polite"
              >
                {seconds}
              </output>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-6 py-6">
        {room.phase === 'lobby' && (
          <LobbyHero code={room.code} capacity={room.capacity} seated={players.length} />
        )}

        {/*
          이 방의 기계 수. SPEC §15-3에서 "몇인지는 공개하고 어느 자리인지는 숨긴다"로
          정했다. lobby 에는 아직 봇이 없어서 띄우지 않는다 — 0이 뜨면 거짓말이 된다.
          시작 순간 전원의 자리가 다시 섞이므로(§15-3-결정) 이 수는 제약이지 답이 아니다.
        */}
        {room.phase !== 'lobby' && me != null && <MachineCount n={me.bot_count} />}

        <PlayerGrid
          players={players}
          capacity={room.capacity}
          meId={me?.player?.id}
          lobby={room.phase === 'lobby'}
        />

        {/* 내가 스파이라는 건 나만 본다. 남의 역할은 reveal까지 아무 데도 오지 않는다 (I1) */}
        {me?.role === 'spy' && room.phase !== 'reveal' && room.phase !== 'replay' && (
          <p className="case riveted flex items-center gap-3 border-signal/25 px-5 py-3.5">
            <SpyIcon className="h-4 w-4 shrink-0 text-signal" />
            <span className="text-[13px] leading-relaxed text-bone">
              <span className="stencil mr-2 text-[9px] text-signal">너는 스파이다</span>
              기계인 척해서 표를 끌어와라. 이건 너에게만 보인다.
            </span>
          </p>
        )}

        <Panel
          code={code}
          room={room}
          players={players}
          me={me}
          question={question}
          answers={revealed.answers}
          answerOf={revealed.question}
          votes={votes}
        />

        {error && (
          <p className="case border-signal/30 px-5 py-4 text-[13px] text-signal">{error}</p>
        )}

        <p className="mt-auto flex items-center gap-2 pt-3 text-[10px] text-ash">
          <InfoIcon className="h-3 w-3 shrink-0" />
          계기판은 표시용이다. 페이즈 전환은 서버가 정한다 (SPEC I2).
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
    // 영사막에 방 코드가 떠 있다 — 들어올 사람이 봐야 하는 정보라 가장 밝은 면에 건다
    <section className="screen overflow-hidden px-8 py-10 text-center">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(50% 70% at 50% -20%, rgba(255,227,189,.11), transparent 70%)',
        }}
      />
      <div className="relative">
        <p className="stencil text-[9px] text-ash">이 코드로 들어온다</p>
        <p className="readout mt-3 text-[clamp(2.75rem,13vw,4.5rem)] leading-none tracking-[0.22em] text-linen drop-shadow-[0_0_30px_rgba(255,217,172,0.35)]">
          {code}
        </p>

        <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => void copy()}
            className="case case-live stencil inline-flex items-center gap-2 px-5 py-2.5 text-[9px] text-dust"
          >
            {copied ? <CheckIcon className="h-3 w-3 text-tung" /> : null}
            {copied ? '복사됨' : '코드 복사'}
          </button>
          <span className="cut inline-flex items-center gap-2 px-4 py-2.5">
            <UserPlusIcon className="h-3 w-3 text-ash" />
            <span className="readout text-[13px] text-bone">
              {seated}
              <span className="text-ash">/{capacity}</span>
            </span>
          </span>
        </div>
      </div>
    </section>
  );
}

/**
 * 대기실에서 말하기 — 정해진 문구만 누른다 (SPEC §15-3-결정).
 *
 * ┌─ 왜 자유 채팅이 아닌가 ────────────────────────────────────────────────────┐
 * │ 대기실에서 미리 짜면 게임이 죽는다. 다만 담합의 두 축은 이미 구조가 끊어놨다 │
 * │ — 봇은 시작할 때 앉고, 자리·닉네임은 시작 순간 다시 섞이며(shuffle_seats),  │
 * │ 역할도 그때 배정된다. 그래서 "나 3번이야"도 "내가 스파이야"도 여기서는       │
 * │ 성립하지 않는다.                                                           │
 * │                                                                            │
 * │ 남는 건 "우리 다 짧게만 답하자" 같은 메타 합의뿐이고, 문구 목록이 그걸       │
 * │ 막는다. 목록의 원본은 lib/server/lobby-lines.ts 하나다 —                    │
 * │ **여기에 문구를 적어두지 않는다.** 두 군데로 갈리면 화면에는 있는데 서버가   │
 * │ 모르는 버튼이 생기고, 눌러도 400 만 뜬다.                                   │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 진짜 막아야 하는 건 목록이 아니라 조합이다. 여덟 개여도 마음대로 연타하면
 *   3비트짜리 통신 채널이 된다. 쿨다운·연속 금지·총량은 서버가 보고(I9),
 *   여기서는 같은 조건으로 버튼을 미리 잠글 뿐이다 — 정상적인 조급함이 빨간
 *   오류 배너로 보이지 않게 하려는 것이다.
 */
function LobbySay({
  code,
  roomId,
  players,
  meId,
}: {
  code: string;
  roomId: string;
  players: PublicPlayer[];
  meId: string;
}) {
  const { data: cfg } = useLobbyLines(true);
  const say = useSayLobbyLine(code, roomId);
  const ready = useSetLobbyReady(code, roomId);
  const busy = useRoomUi(selectIsBusy);
  const { serverNow } = useServerClock();

  /**
   * 쿨다운이 끝나면 버튼이 스스로 풀려야 한다. 그런데 그때 바뀌는 건 서버 값이
   * 아니라 **시간**뿐이라 다시 그릴 계기가 없다 — 여기서만 초를 센다.
   * 표시용이다. 진짜 판정은 서버가 한다 (I2).
   */
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);

  const mine = players.find((p) => p.id === meId) ?? null;
  const cooldownMs = (cfg?.cooldown_sec ?? 3) * 1000;
  const lastAt = mine?.lobby_line_at ? new Date(mine.lobby_line_at).getTime() : 0;
  const waitMs = Number.isFinite(lastAt) ? Math.max(0, lastAt + cooldownMs - serverNow()) : 0;
  const cooling = waitMs > 0;

  return (
    <Box>
      <Label>말하기</Label>
      <p className="text-[11px] leading-relaxed text-grime">
        대기실에서는 정해진 말만 할 수 있다. 시작 전에 미리 짜지 못하게 하려는 것이다.
      </p>

      <div className="flex flex-wrap gap-1.5">
        {(cfg?.lines ?? []).map((l) => (
          <button
            key={l.id}
            type="button"
            // 같은 말을 연달아 보내는 건 서버도 막는다. 눌리기 전에 잠가서
            // "왜 안 되지"가 아니라 "지금은 못 누르는구나"로 보이게 한다.
            disabled={busy || cooling || l.text === mine?.lobby_line}
            onClick={() => say.run(l.id)}
            className="cut px-3 py-2 text-[11px] text-bone transition-colors hover:text-flare disabled:cursor-not-allowed disabled:opacity-25"
          >
            {l.text}
          </button>
        ))}
      </div>

      {cooling && (
        <p className="stencil text-[8px] text-ash" aria-live="polite">
          {Math.ceil(waitMs / 1000)}초 뒤에 다시 말할 수 있다
        </p>
      )}

      {/*
        준비 완료는 발화가 아니라 상태다. 말풍선으로 흐르지 않고 좌석 카드에 붙는다 —
        켜고 끄는 순서가 그대로 신호가 되기 때문이다.
        시작을 막지도 않는다. 한 명이 자리를 비우면 방이 영영 시작되지 않는다.
      */}
      <button
        type="button"
        disabled={busy}
        onClick={() => ready.run(!mine?.is_ready)}
        className={[
          'stencil mt-1 flex w-full items-center justify-center gap-2.5 py-3 text-[10px] transition-all disabled:cursor-not-allowed disabled:opacity-30',
          mine?.is_ready
            ? 'bg-tung/15 text-flare shadow-[inset_0_0_0_1px_rgba(255,217,172,0.45)]'
            : 'cut text-grime hover:text-tung',
        ].join(' ')}
      >
        {mine?.is_ready && <CheckIcon className="h-3.5 w-3.5" />}
        {mine?.is_ready ? '준비 완료' : '준비되면 누른다'}
      </button>
    </Box>
  );
}

/**
 * 페이즈별 조작판.
 *
 * ★ 훅은 전부 여기 맨 위에서 부른다. 아래 분기 안에서 부르면 페이즈가 바뀔 때마다
 *   훅 개수가 달라져 React 가 상태를 잘못 짝짓는다. 뮤테이션은 만들어 두기만 하고
 *   실제 요청은 run() 을 부를 때 나가므로 미리 만들어도 비용이 없다.
 */
function Panel({
  code,
  room,
  players,
  me,
  question,
  answers,
  answerOf,
  votes,
}: {
  code: string;
  room: Room;
  players: PublicPlayer[];
  me: MeResponse | null;
  question: Question | null;
  answers: AnswerRow[];
  /** answers가 어느 질문의 답인지. 직전 라운드 것일 수 있다. */
  answerOf: Question | null;
  votes: VoteRow[];
}) {
  const dispatch = useRoomDispatch();

  const start = useStartRoom(code, room.id);
  const answer = useSubmitAnswer(code, room.id);
  const vote = useCastVote(code, room.id);

  const text = useRoomUi(selectAnswerDraft);
  const target = useRoomUi(selectVoteTarget);
  const reason = useRoomUi(selectVoteReason);
  const canAnswerNow = useRoomUi(selectCanSubmitAnswer);
  const canVoteNow = useRoomUi(selectCanCastVote);
  const busy = useRoomUi(selectIsBusy);
  const starting = useRoomUi(selectIsPending(REQUEST.start));

  const nameOf = (id: string) => nicknameOf(players, id);

  if (!me?.player) {
    return (
      <Box>
        <p className="text-sm text-bone">이 방의 참가자가 아니다.</p>
        <Link
          href="/main"
          className="stencil inline-flex items-center gap-2 text-[10px] text-tung transition-colors hover:text-flare"
        >
          <ArrowLeftIcon className="h-3.5 w-3.5" />
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
          <ul className="flex flex-col gap-px">
            {/*
              ★ 봇이 몇 명인지 절대 쓰지 않는다 (I1). 정원과 사람 수의 차이를 화면이
                계산해 주면 그게 곧 봇 수다. "몇 자리인지는 공개되지 않는다"가 정답이다.
            */}
            <RuleRow
              icon={<UserPlusIcon className="h-3.5 w-3.5" />}
              label="정원"
              value={`${room.capacity}자리`}
            />
            <RuleRow
              icon={<SpyIcon className="h-3.5 w-3.5" />}
              label="스파이"
              value="사람 중 1명. 사람이 2명 이상일 때만 생긴다"
              accent
            />
            <RuleRow
              icon={<CheckIcon className="h-3.5 w-3.5" />}
              label="시민"
              value="스파이가 아닌 나머지 사람 전원"
            />
            {/*
              아이콘도 문구다. 여기에 ChipIcon(진짜 AI)을 쓰면 "빈자리 = AI"라고
              그림으로 말해버린다. SPEC §0은 빈자리를 봇이 채운다는 사실 자체를
              공개하지 않는다고 못박았으므로 중립적인 InfoIcon을 쓴다.
            */}
            {/*
              §15-3 이전에는 "몇 자리인지는 공개되지 않는다"였다. 이제 수는 공개한다.
              숨기는 것은 **어느 자리인가** 하나뿐이고, 그건 시작 때 전원을 다시
              섞어서 지킨다. 문구가 실제 동작과 어긋나면 그게 제일 나쁘다.
            */}
            <RuleRow
              icon={<InfoIcon className="h-3.5 w-3.5" />}
              label="빈자리"
              value="시작할 때 기계가 채운다. 몇 대인지는 시작하면 알려준다"
            />
            <RuleRow
              icon={<ChipIcon className="h-3.5 w-3.5" />}
              label="숨는 것"
              value="어느 자리가 기계인지. 시작할 때 모두의 자리가 다시 섞인다"
            />
          </ul>
        </Box>

        <LobbySay code={code} roomId={room.id} players={players} meId={me.player.id} />

        {me.is_host ? (
          <div className="case riveted px-6 py-5">
            <p className="flex items-center gap-2 text-[11px] text-grime">
              <CrownIcon className="h-3.5 w-3.5 text-tung" />
              방장이다. 사람이 다 모이지 않아도 시작할 수 있다.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => start.run()}
              className="stencil mt-4 flex w-full items-center justify-center gap-3 bg-signal/12 py-4 text-[11px] text-flare shadow-[inset_0_0_0_1px_rgba(255,51,32,0.45)] transition-all hover:bg-signal/20 hover:shadow-[inset_0_0_0_1px_rgba(255,51,32,0.7),0_0_30px_-8px_rgba(255,51,32,0.9)] disabled:cursor-default disabled:opacity-40"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-signal shadow-[0_0_9px_2px] shadow-signal/70" />
              {starting ? '시작하는 중…' : '게임 시작'}
            </button>
          </div>
        ) : (
          <p className="case flex items-center justify-center gap-2.5 py-5 text-[12px] text-grime">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-tung shadow-[0_0_9px_2px] shadow-tung/60" />
            방장이 시작하기를 기다리는 중…
          </p>
        )}
      </>
    );
  }

  if (room.phase === 'question' || room.phase === 'target') {
    const isTargetPhase = room.phase === 'target';
    const iAmTarget = question?.target_id === me.player.id;
    const canAnswer = !me.answered && (!isTargetPhase || iAmTarget);

    return (
      <>
        {/* 질문은 영사막에 뜬다 — 모두가 같은 것을 본다 */}
        <section className="screen overflow-hidden px-7 py-8">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                'radial-gradient(55% 70% at 50% -20%, rgba(255,227,189,.10), transparent 70%)',
            }}
          />
          <div className="relative">
            <p className="stencil text-[9px] text-ash">
              {isTargetPhase ? '지목 질문' : '공통 질문'}
            </p>
            <p className="mt-4 text-[22px] font-bold leading-snug tracking-tight text-linen">
              {question?.text ?? '질문을 기다리는 중…'}
            </p>
            {isTargetPhase && question?.target_id && (
              <p className="stencil mt-4 text-[10px] text-signal">
                → {nameOf(question.target_id)}에게
              </p>
            )}
          </div>
        </section>

        {canAnswer ? (
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              // 입력칸은 **접수된 뒤에** 비운다 (useSubmitAnswer 의 onSuccess).
              // 실패했는데 비우면 사람이 쓴 걸 잃는다.
              answer.run(text);
            }}
          >
            <input
              value={text}
              onChange={(e) => dispatch(roomActions.answerChanged(e.target.value))}
              maxLength={300}
              placeholder="답을 쓴다"
              className={INPUT}
            />
            <button type="submit" disabled={!canAnswerNow} className={PRIMARY_BUTTON}>
              제출
            </button>
          </form>
        ) : (
          <p className="cut px-5 py-3.5 text-[12px] text-grime">
            {me.answered
              ? '제출했다. 시간이 끝나면 전부 공개된다.'
              : '지목받은 사람이 답하는 중…'}
          </p>
        )}

        {answers.length > 0 && (
          <Box>
            {/*
              지금 질문의 답이 아니라 직전 질문의 답일 수 있다 — 답은 페이즈가
              끝나야 열리기 때문이다. 어느 질문의 답인지 밝히지 않으면 화면이
              엉뚱한 대화를 하는 것처럼 보인다.
            */}
            {answerOf != null && answerOf.id !== question?.id ? (
              <Label>지난 질문 · {answerOf.text}</Label>
            ) : (
              <Label>공개된 답</Label>
            )}
            <ul className="flex flex-col gap-px">
              {answers.map((a) => (
                <AnswerRowItem key={a.id} who={nameOf(a.player_id)} text={a.text} />
              ))}
            </ul>
          </Box>
        )}
      </>
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
            <Label>지난 답변{answerOf ? ` · ${answerOf.text}` : ''}</Label>
            <ul className="flex flex-col gap-px">
              {answers.map((a) => (
                <AnswerRowItem key={a.id} who={nameOf(a.player_id)} text={a.text} />
              ))}
            </ul>
          </Box>
        )}
        <ChatPanel code={code} room={room} nameOf={nameOf} meId={me.player.id} />
      </>
    );
  }

  if (room.phase === 'vote') {
    return (
      <Box>
        <Label>투표</Label>
        <p className="engraved text-2xl font-black">누가 기계인가?</p>
        <div className="mt-2">
          <PlayerGrid
            players={players}
            capacity={room.capacity}
            meId={me.player.id}
            selectable={!me.voted}
            selectedId={target}
            onSelect={(id) => dispatch(roomActions.voteTargetSelected(id))}
          />
        </div>
        {me.voted ? (
          <p className="cut px-5 py-3.5 text-[12px] text-grime">
            투표했다. 결과는 전원이 마치면 공개된다.
          </p>
        ) : (
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!target) return; // 셀렉터가 이미 막지만, 타입도 여기서 좁힌다
              vote.run({ targetId: target, reason });
            }}
          >
            <input
              value={reason}
              onChange={(e) => dispatch(roomActions.voteReasonChanged(e.target.value))}
              maxLength={200}
              placeholder="이유 (선택)"
              className={INPUT}
            />
            <button type="submit" disabled={!canVoteNow} className={DANGER_BUTTON}>
              지목
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
  code,
  room,
  meId,
  nameOf,
}: {
  code: string;
  room: Room;
  meId: string;
  nameOf: (id: string) => string;
}) {
  const dispatch = useRoomDispatch();
  const send = useSendMessage(code, room.id);

  // 폴링 주기와 쿼리 키는 lib/queries 가 갖는다. 이 컴포넌트는 주기를 모른다.
  const { data: messages = [] } = useMessages(room.id, true);
  const text = useRoomUi(selectChatDraft);
  const canSend = useRoomUi(selectCanSendChat);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  return (
    <Box>
      <Label>자유 채팅</Label>
      <p className="text-[12px] text-grime">
        누가 기계 같은지 얘기해본다. 시간이 지나면 투표로 넘어간다.
      </p>

      <ul className="cut flex max-h-72 flex-col gap-2.5 overflow-y-auto p-4">
        {messages.length === 0 && (
          <li className="py-6 text-center text-[12px] text-ash">아직 아무도 말하지 않았다.</li>
        )}
        {messages.map((m) => {
          const mine = m.player_id === meId;
          return (
            <li key={m.id} className={mine ? 'flex flex-col items-end' : 'flex flex-col items-start'}>
              <span className="stencil mb-1 px-0.5 text-[8px] text-ash">{nameOf(m.player_id)}</span>
              <span
                className={[
                  'max-w-[80%] px-3.5 py-2 text-[13px] leading-relaxed',
                  mine
                    ? 'bg-tung/15 text-flare shadow-[inset_0_0_0_1px_rgba(255,217,172,0.28)]'
                    : 'bg-steel text-bone shadow-[inset_0_1px_0_rgba(214,207,194,0.07)]',
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
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          const t = text.trim();
          if (!t) return;
          // 채팅만 보내는 즉시 비운다 — 연달아 치는 것이라 입력칸이 안 비면 손이 멈춘다
          // (reducer.ts 의 draft/chatSent 주석).
          dispatch(roomActions.chatSent());
          send.run(t);
        }}
      >
        <input
          value={text}
          onChange={(e) => dispatch(roomActions.chatChanged(e.target.value))}
          maxLength={200}
          placeholder="말한다"
          className={INPUT}
        />
        <button type="submit" disabled={!canSend} aria-label="보내기" className={PRIMARY_BUTTON}>
          <SendIcon className="h-3.5 w-3.5" />
        </button>
      </form>
    </Box>
  );
}

/**
 * 이 방의 기계 수 (SPEC §15-3-결정).
 *
 * ★ 0을 특별 취급한다. "0대"는 **사람만 있는 방**이라는 뜻이고, 그 가능성이 살아
 *   있어야 긴장이 유지된다. 숫자만 띄우고 넘어가면 0이 오류처럼 보인다.
 */
function MachineCount({ n }: { n: number }) {
  return (
    <div className="case flex items-center gap-4 px-5 py-3">
      <ChipIcon className="h-4 w-4 shrink-0 text-bounce" />
      <p className="stencil text-[9px] text-ash">이 방의 기계</p>
      <p className="readout text-xl text-bounce">{n}</p>
      <p className="ml-auto text-[11px] text-grime">
        {n === 0 ? '전부 사람이다' : '어느 자리인지는 끝까지 알려주지 않는다'}
      </p>
    </div>
  );
}

/** 역할 배지 모양. role이 null이면 시민으로 본다 (원래 표시 규칙 그대로다). */
const ROLE_BADGE = {
  ai: { label: 'AI', tone: 'text-bounce', Icon: ChipIcon },
  spy: { label: '스파이', tone: 'text-signal', Icon: SpyIcon },
  citizen: { label: '시민', tone: 'text-grime', Icon: CheckIcon },
} as const;

function RoleBadge({ role }: { role: Role | null }) {
  const badge = role === 'ai' ? ROLE_BADGE.ai : role === 'spy' ? ROLE_BADGE.spy : ROLE_BADGE.citizen;
  const Icon = badge.Icon;
  return (
    <span className={`stencil inline-flex shrink-0 items-center gap-1.5 text-[9px] ${badge.tone}`}>
      <Icon className="h-3 w-3" />
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
  me: MeResponse;
  votes: VoteRow[];
  nameOf: (id: string) => string;
}) {
  // reveal·replay 에서만 이 컴포넌트가 그려지므로 enabled 는 true 다.
  // 라우트가 페이즈와 참가 여부를 다시 확인한다 (I1) — 화면 조건에 기대지 않는다.
  const { data, isError, error } = useReveal(room.id, true);

  if (isError) {
    return (
      <Box>
        <p className="text-[13px] text-signal">{error.message}</p>
      </Box>
    );
  }
  if (!data) {
    return (
      <Box>
        <p className="stencil py-6 text-center text-[10px] text-grime">집계하는 중…</p>
      </Box>
    );
  }

  const ranked = [...data.players].sort((a, b) => b.score - a.score);
  const myVote = votes.find((v) => v.voter_id === me.player?.id);
  const iWasRight = myVote != null && data.players.find((p) => p.id === myVote.target_id)?.is_bot;

  const verdict =
    myVote == null
      ? { text: '기권', sub: '다음 판에는 한 명을 골라보자', tone: 'text-dust' }
      : iWasRight
        ? { text: '맞혔다', sub: '기계를 골랐다', tone: 'lit-tung' }
        : { text: '틀렸다', sub: '사람을 골랐다', tone: 'lit-signal' };

  return (
    <>
      {/* 판정은 영사막에 뜬다 */}
      <section className="screen overflow-hidden px-8 py-10 text-center">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              'radial-gradient(55% 75% at 50% -20%, rgba(255,227,189,.12), transparent 70%)',
          }}
        />
        <div className="relative">
          <p className="stencil text-[9px] text-ash">결과</p>
          <p className={`engraved mt-3 text-6xl font-black ${verdict.tone}`}>{verdict.text}</p>
          <p className="mt-2 text-[13px] text-grime">{verdict.sub}</p>
        </div>
      </section>

      <Box>
        <Label>순위</Label>
        <ol className="flex flex-col gap-px">
          {ranked.map((p, i) => {
            const isMe = p.id === me.player?.id;
            return (
              <li
                key={p.id}
                className={[
                  'flex items-center gap-3.5 px-4 py-3',
                  isMe ? 'bg-tung/8 shadow-[inset_0_0_0_1px_rgba(255,217,172,0.25)]' : 'cut',
                ].join(' ')}
              >
                <span className="readout w-4 shrink-0 text-center text-[11px] text-ash">
                  {i + 1}
                </span>
                <span
                  className="readout flex h-8 w-8 shrink-0 items-center justify-center rounded-[2px] bg-black/45 text-[12px] text-dust"
                  aria-hidden
                >
                  {p.seat}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-bone">
                    {p.nickname}
                    {isMe && <span className="stencil ml-2 text-[8px] text-tung">나</span>}
                  </span>
                  <span className="readout block text-[10px] text-ash">
                    받은 표 {p.votes_received}
                  </span>
                </span>
                <RoleBadge role={p.role} />
                <span className="readout w-12 shrink-0 text-right text-lg text-linen">
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
          <p className="text-[12px] text-grime">투표가 없다.</p>
        ) : (
          <ul className="flex flex-col gap-px">
            {data.votes.map((v) => (
              <li
                key={v.voter_id}
                className="cut flex flex-wrap items-baseline gap-x-2 gap-y-1 px-4 py-2.5 text-[13px]"
              >
                <span className="font-semibold text-bone">{nameOf(v.voter_id)}</span>
                <span className="text-ash">→</span>
                <span className="font-semibold text-bone">{nameOf(v.target_id)}</span>
                <span className={v.correct ? 'text-tung' : 'text-ash'}>
                  {v.correct ? '○' : '✕'}
                </span>
                {v.reason && <span className="text-grime">· {v.reason}</span>}
              </li>
            ))}
          </ul>
        )}

        <p className="border-t border-bone/5 pt-4 text-[11px] leading-relaxed text-ash">
          채점: {data.rule.join(' · ')}
          <br />이 규칙은 SPEC에 없다. 정하면 app/api/reveal/route.ts와 lib/game/rules.ts를
          고친다.
        </p>

        <Link
          href="/main"
          className="stencil inline-flex items-center gap-2 text-[10px] text-tung transition-colors hover:text-flare"
        >
          <ArrowLeftIcon className="h-3.5 w-3.5" />
          로비로
        </Link>
      </Box>
    </>
  );
}

/* ─────────────────────────────── 공통 조각 ─────────────────────────────── */

const INPUT =
  'cut min-w-0 flex-1 px-4 py-3 text-[13px] text-bone transition-colors placeholder:text-ash focus:border-tung/40 focus:outline-none';

/** 평상시 조작 — 텅스텐 조명이 든 금속 버튼 */
const PRIMARY_BUTTON =
  'case case-live stencil shrink-0 px-6 py-3 text-[10px] text-flare disabled:cursor-not-allowed disabled:text-ash disabled:opacity-40';

/** 되돌릴 수 없는 조작(지목) — 비상등 색 */
const DANGER_BUTTON =
  'stencil shrink-0 bg-signal/12 px-7 py-3 text-[10px] text-flare shadow-[inset_0_0_0_1px_rgba(255,51,32,0.5)] transition-all hover:bg-signal/20 hover:shadow-[inset_0_0_0_1px_rgba(255,51,32,0.8),0_0_26px_-8px_rgba(255,51,32,0.9)] disabled:cursor-not-allowed disabled:opacity-30 disabled:shadow-[inset_0_0_0_1px_rgba(255,51,32,0.2)]';

function Label({ children }: { children: React.ReactNode }) {
  return <p className="stencil text-[9px] text-grime">{children}</p>;
}

/** 공개된 답 한 줄. 케이스에 붙은 라벨처럼 이름과 내용이 층으로 나뉜다 */
function AnswerRowItem({ who, text }: { who: string; text: string }) {
  return (
    <li className="cut px-4 py-3">
      <p className="stencil text-[8px] text-tung/60">{who}</p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-bone">{text}</p>
    </li>
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
    <li className="cut flex items-center gap-3.5 px-4 py-3">
      <span className={`shrink-0 ${accent ? 'text-signal' : 'text-ash'}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="stencil block text-[8px] text-ash">{label}</span>
        <span className="mt-0.5 block text-[13px] text-bone">{value}</span>
      </span>
    </li>
  );
}

function Box({ children }: { children: React.ReactNode }) {
  return <section className="case flex flex-col gap-3 px-6 py-5">{children}</section>;
}
