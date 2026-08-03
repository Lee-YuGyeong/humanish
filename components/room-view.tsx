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
import { RoomBoot, RoomLobby } from '@/components/room-lobby';
import {
  ArrowLeftIcon,
  CheckIcon,
  ChipIcon,
  InfoIcon,
  SendIcon,
  SpyIcon,
  UserPlusIcon,
} from '@/components/ui/icons';
import type { AnswerRow, VoteRow } from '@/lib/api/db';
import type { MeResponse } from '@/lib/api/room';
import { useProfile } from '@/lib/queries/auth';
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
  revote: '재투표', // SPEC §18.3 — 사람 표가 동점일 때 20초
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
  /** isPending 도 봐야 한다 — "아직 안 왔다"와 "참가자가 아니다"는 다른 상태다 */
  const meQuery = useMe(roomId);
  const me = meQuery.data ?? null;
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
      <main className="room-green mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-5 px-6">
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

  /*
   * ┌─ 들어올 때 옛 화면이 번쩍이지 않게 ────────────────────────────────────┐
   * │ 방 정보와 내 자리 정보는 **따로** 온다. 예전에는 room 만 오면 곧장 아래  │
   * │ 레이아웃을 그렸는데, 그 찰나에 me 가 아직 없어서 대기실 조건이 거짓이    │
   * │ 되고 창고 화면이 한 번 지나갔다 — 화면에 남아 있던 직전 방의 결과표가    │
   * │ 새 방에 들어가는 사람에게 그대로 보였다.                                │
   * │ 둘 다 올 때까지 같은 색의 빈 판으로 덮는다. 라우트가 바뀌는 동안은      │
   * │ app/room/[code]/loading.tsx 가 같은 일을 한다.                          │
   * └────────────────────────────────────────────────────────────────────────┘
   * me 가 null 로 **확정된** 경우(참가자가 아니다)는 기다리지 않는다 —
   * 그건 아래 Panel 이 안내해야 하는 상태다.
   */
  if (!room || meQuery.isPending) {
    return <RoomBoot />;
  }

  const seconds = remainMs == null ? null : Math.max(0, Math.ceil(remainMs / 1000));
  const urgent = seconds != null && seconds <= URGENT_SECONDS;

  /*
   * 대기실은 화면 자체가 다르다 — 코드 배너 · 좌석판 · 말하기 판이 한 화면에
   * 같이 있어야 해서 아래의 한 줄짜리 레이아웃으로는 담기지 않는다.
   * 그래서 여기서 통째로 갈아탄다 (components/room-lobby.tsx).
   *
   * ★ 훅은 전부 이 위에서 불렀다. 이 분기 아래에는 훅이 없다 — 페이즈가 바뀔 때
   *   훅 개수가 달라지면 React 가 상태를 잘못 짝짓는다.
   * ★ me.player 가 없으면(참가자가 아니면) 이 화면을 그리지 않는다. 아래 Panel 이
   *   "이 방의 참가자가 아니다"를 안내한다.
   */
  if (room.phase === 'lobby' && me?.player) {
    return (
      <RoomLobby
        code={code}
        room={room}
        players={players}
        me={{ ...me, player: me.player }}
        error={error}
      />
    );
  }

  return (
    <div className="room-green flex min-h-screen flex-col">
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
            {/*
              ★ 방을 가리키는 이름은 **제목 하나다.** 방에 들어온 사람이 확인하는 건
                "여기가 그 방이 맞나"이고 그 답은 코드가 아니라 제목이다.
                코드는 아직 안 들어온 사람을 부를 때 쓰는 값이라 게임이 시작된
                뒤에는 화면에 글자로 남기지 않는다 (대기실 머리말의 복사 버튼이
                맡는다). 제목이 없는 방만 코드가 그 자리에 선다 —
                가리킬 이름이 그것뿐이다.
            */}
            <div className="min-w-0">
              {room.name ? (
                <h1 className="truncate text-base font-bold leading-tight text-linen">
                  {room.name}
                </h1>
              ) : (
                <>
                  <p className="stencil text-[8px] text-ash">room</p>
                  <h1 className="readout truncate text-xl tracking-[0.3em] text-linen">
                    {room.code}
                  </h1>
                </>
              )}
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
          이 방의 AI 수. SPEC §15-3에서 "몇인지는 공개하고 어느 자리인지는 숨긴다"로
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

        {/*
          내가 연기자라는 건 나만 본다. 남의 역할은 reveal까지 아무 데도 오지 않는다 (I1).
          역할 값 'spy'는 아직 코드에 남아 있다 — 화면에 보이는 이름만 '연기자'다 (SPEC §18.2).
        */}
        {me?.role === 'spy' && room.phase !== 'reveal' && room.phase !== 'replay' && (
          <p className="case riveted flex items-center gap-3 border-signal/25 px-5 py-3.5">
            <SpyIcon className="h-4 w-4 shrink-0 text-signal" />
            <span className="text-[13px] leading-relaxed text-bone">
              <span className="stencil mr-2 text-[9px] text-signal">너는 연기자다</span>
              AI인 척해서 표를 끌어와라. 네가 지목되면 네 승리다.
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
      </main>
    </div>
  );
}

/**
 * 대기실 머리말 — 방 코드를 크게 띄우고 복사시킨다.
 *
 * "N / 정원"의 N은 지금 앉아 있는 사람 수다.
 *
 * ★ 봇이 **몇인지**는 이제 공개다 (§15-3). 여기서 조심할 것은 수가 아니라
 *   **자리**다 — 예전에는 `정원 − N`이 곧 봇 수이고 빈 좌석 번호가 곧 봇의
 *   자리였다. §18.1이 그 셈법을 끊었다: 봇 수는 빈자리가 아니라 **모인 사람
 *   수**가 정하고, 시작할 때 자리를 다시 섞는다. 그래도 **문구가 "빈자리 =
 *   AI"라고 가르치지는 않게** 한다 — 틀린 셈법이면서 동시에 자리를 가리킨다.
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
            'radial-gradient(50% 70% at 50% -20%, rgba(0,255,102,.10), transparent 70%)',
        }}
      />
      <div className="relative">
        <p className="readout text-[clamp(2.75rem,13vw,4.5rem)] leading-none tracking-[0.22em] text-linen drop-shadow-[0_0_30px_rgba(0,255,102,0.35)]">
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
            ? 'bg-tung/15 text-flare shadow-[inset_0_0_0_1px_rgba(0,255,102,0.45)]'
            : 'cut text-grime hover:text-tung',
        ].join(' ')}
      >
        {mine?.is_ready && <CheckIcon className="h-3.5 w-3.5" />}
        {mine?.is_ready ? '준비 완료' : '준비'}
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
              여기 적는 것은 **플레이어가 알아야 움직일 수 있는 것**뿐이다. 내부 동작
              (인원표·확률·페이즈 길이)은 적지 않는다.

              ★ 봇이 **어느 자리**인지로 이어지는 값은 절대 쓰지 않는다 (I1). 봇이
                **몇인지**는 공개해도 된다 (§15-3) — 다만 대기실에서는 아직 시작 전이라
                셀 것 자체가 없다. 시작하면 MachineCount 가 알려준다.
            */}
            <RuleRow
              icon={<UserPlusIcon className="h-3.5 w-3.5" />}
              label="정원"
              value={`최대 ${room.capacity}자리. 실제 자리는 시작할 때 정해진다`}
            />
            {/*
              이제 AI 수는 공개다 (§15-3). 다만 대기실 문구가 "빈자리를 채운다"고
              말하면 **빈칸을 세면 AI 수가 나온다**는 잘못된 셈법을 가르치게 된다 —
              AI 수는 빈자리가 아니라 모인 사람 수가 정한다 (§18.1).
            */}
            <RuleRow
              icon={<ChipIcon className="h-3.5 w-3.5" />}
              label="AI"
              value="시작할 때 자리에 섞인다. 몇인지는 그때 알려준다"
            />
            {/*
              연기자 수는 **끝까지 숨긴다** (§18.2). 0명일 수도 있다는 가능성이
              남아 있어야 긴장이 유지되므로, 여기에 수를 적으면 그 순간 규칙이 깨진다.
            */}
            <RuleRow
              icon={<SpyIcon className="h-3.5 w-3.5" />}
              label="연기자"
              value="사람이면서 AI인 척한다. 몇인지는 알려주지 않는다"
              accent
            />
            <RuleRow
              icon={<InfoIcon className="h-3.5 w-3.5" />}
              label="숨는 것"
              value="어느 자리가 AI인지. 시작할 때 모두의 자리가 다시 섞인다"
            />
            <RuleRow
              icon={<CheckIcon className="h-3.5 w-3.5" />}
              label="승리"
              value="지목된 한 명이 AI면 시민 승, 연기자면 연기자 승, 그 밖이면 AI 승"
            />
          </ul>
        </Box>

        <LobbySay code={code} roomId={room.id} players={players} meId={me.player.id} />

        {me.is_host ? (
          <div className="case riveted px-6 py-5">
            <button
              type="button"
              disabled={busy}
              onClick={() => start.run()}
              className="stencil flex w-full items-center justify-center gap-3 bg-signal/12 py-4 text-[11px] text-flare shadow-[inset_0_0_0_1px_rgba(255,51,32,0.45)] transition-all hover:bg-signal/20 hover:shadow-[inset_0_0_0_1px_rgba(255,51,32,0.7),0_0_30px_-8px_rgba(255,51,32,0.9)] disabled:cursor-default disabled:opacity-40"
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
                'radial-gradient(55% 70% at 50% -20%, rgba(0,255,102,.09), transparent 70%)',
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
              placeholder="답"
              className={INPUT}
            />
            <button type="submit" disabled={!canAnswerNow} className={PRIMARY_BUTTON}>
              제출
            </button>
          </form>
        ) : (
          <p className="cut px-5 py-3.5 text-[12px] text-grime">
            {me.answered ? '제출됨' : '지목받은 사람이 답하는 중…'}
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

  if (room.phase === 'vote' || room.phase === 'revote') {
    // ★ 재투표(SPEC §18.3): 사람 표가 동점이라 후보(동점자)만 다시 고른다.
    //   후보 강제는 서버(/api/vote)가 확실히 한다 — 후보 밖을 고르면 400이 배너로 뜬다.
    //   TODO(C): 재투표 화면에서 후보가 아닌 자리는 눌리지 않게(선택 비활성) 표시할 것.
    const isRevote = room.phase === 'revote';
    const candidates = room.revote_candidates ?? [];
    return (
      <Box>
        <Label>{isRevote ? '재투표 — 후보 중에서' : '투표'}</Label>
        <p className="engraved text-2xl font-black">누가 AI인가?</p>
        {isRevote && candidates.length > 0 && (
          <p className="stencil text-[9px] text-signal">
            동점이다. 후보 {candidates.length}명 중에서 다시 고른다
          </p>
        )}
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
          <p className="cut px-5 py-3.5 text-[12px] text-grime">투표함</p>
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
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * 대화창은 평상시 잠들어 있다 — 누르면 깨어난다 (SPEC §5.4 화면 요청).
   * 좁은 화면에서 입력칸이 늘 열려 있으면 좌석판·말풍선이 밀린다. 눌렀을 때만 열어
   * 대화 로그에 시선이 머물게 한다. 로그의 말풍선 자체는 그대로다.
   */
  const [active, setActive] = useState(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // 깨어난 순간 커서를 입력칸에 둔다 — 한 번 눌러 바로 타이핑되게
  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active]);

  return (
    <Box>
      <Label>자유 채팅</Label>

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
                    ? 'bg-tung/15 text-flare shadow-[inset_0_0_0_1px_rgba(0,255,102,0.28)]'
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

      {active ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const t = text.trim();
            if (!t) return;
            // 채팅만 보내는 즉시 비운다 — 연달아 치는 것이라 입력칸이 안 비면 손이 멈춘다
            // (reducer.ts 의 draft/chatSent 주석).
            dispatch(roomActions.chatSent());
            send.run(t);
            // 보낸 뒤에도 열어 둔다 — 대화 흐름이 끊기지 않게 커서를 다시 잡아준다
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
        >
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => dispatch(roomActions.chatChanged(e.target.value))}
            // 빈 채로 바깥을 누르면 다시 잠든다. 쓰던 글이 남아 있으면 열어 둔다
            onBlur={() => {
              if (!text.trim()) setActive(false);
            }}
            maxLength={200}
            placeholder="메시지"
            className={CHAT_INPUT}
          />
          <button type="submit" disabled={!canSend} aria-label="보내기" className={CHAT_SEND}>
            <SendIcon className="h-4 w-4" />
          </button>
        </form>
      ) : (
        <button type="button" onClick={() => setActive(true)} className={CHAT_RESTING}>
          <span className="flex-1">눌러서 말한다…</span>
          <SendIcon className="h-4 w-4 shrink-0 text-grime transition-colors group-hover:text-tung" />
        </button>
      )}
    </Box>
  );
}

/**
 * 이 방의 AI 수 (SPEC §15-3-결정).
 *
 * ★ 0을 특별 취급한다. "0"은 **사람만 있는 방**이라는 뜻이고, 그 가능성이 살아
 *   있어야 긴장이 유지된다. 숫자만 띄우고 넘어가면 0이 오류처럼 보인다.
 */
function MachineCount({ n }: { n: number }) {
  return (
    <div className="case flex items-center gap-4 px-5 py-3">
      <ChipIcon className="h-4 w-4 shrink-0 text-bounce" />
      <p className="stencil text-[9px] text-ash">이 방의 AI</p>
      <p className="readout text-xl text-bounce">{n}</p>
      {n === 0 && <p className="ml-auto text-[11px] text-grime">전부 사람이다</p>}
    </div>
  );
}

/** 역할 배지 모양. role이 null이면 시민으로 본다 (원래 표시 규칙 그대로다). */
const ROLE_BADGE = {
  ai: { label: 'AI', tone: 'text-bounce', Icon: ChipIcon },
  spy: { label: '연기자', tone: 'text-signal', Icon: SpyIcon },   // 역할 값은 아직 'spy' (SPEC §18.2)
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
        ? { text: '맞혔다', sub: 'AI를 골랐다', tone: 'lit-tung' }
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
              'radial-gradient(55% 75% at 50% -20%, rgba(0,255,102,.11), transparent 70%)',
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
                  isMe ? 'bg-tung/8 shadow-[inset_0_0_0_1px_rgba(0,255,102,0.25)]' : 'cut',
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

        {/*
          채점 규칙은 SPEC에 없다. 정하면 app/api/reveal/route.ts와 lib/game/rules.ts를 고친다.
          — 화면에는 규칙만 띄우고, 이 메모는 코드에 둔다.
        */}
        <p className="border-t border-bone/5 pt-4 text-[11px] leading-relaxed text-ash">
          채점: {data.rule.join(' · ')}
        </p>

        <Link
          href="/main"
          className="stencil inline-flex items-center gap-2 text-[10px] text-tung transition-colors hover:text-flare"
        >
          <ArrowLeftIcon className="h-3.5 w-3.5" />
          로비로
        </Link>
      </Box>

      <SaveRecordBox roomCode={room.code} />
    </>
  );
}

/**
 * 이 판의 기록이 누구에게 남는가 (SPEC §15-2-결정).
 *
 * ★ 예전에는 여기에 "기록 저장하기"(구글 연결) 버튼이 있었다. 익명으로 놀다가
 *   게임이 끝난 뒤에 계정을 권하는 흐름이었기 때문이다. 그 결정이 뒤집혀서
 *   이제는 들어올 때 이미 로그인한다 — 물을 것이 없고, 알려주기만 한다.
 *
 * ★ 여기 뜨는 이름은 계정 이름이다. **위 순위표의 '익명N' 과 같은 사람이라는
 *   표시를 절대 하지 않는다** (I1). 두 이름이 이어지면 익명성이 끝난다.
 */
function SaveRecordBox({ roomCode }: { roomCode: string }) {
  const { data: profileData } = useProfile();
  const mine = profileData?.profile;

  // 아직 안 왔거나(로딩) 이름을 안 지었다. 후자는 이름 화면에서 나가버린 경우다.
  if (!profileData) return null;
  if (!mine) {
    return (
      <Box>
        <Label>기록</Label>
        <p className="text-[13px] text-grime">이름을 정해야 기록이 남는다.</p>
        <Link
          href={`/account/nickname?next=${encodeURIComponent(`/room/${roomCode}`)}`}
          className={PRIMARY_BUTTON}
        >
          이름 정하기
        </Link>
      </Box>
    );
  }

  return (
    <Box>
      <Label>기록</Label>
      <p className="text-[13px] text-bone">
        <span className="text-tung">{mine.display_name}</span> 으로 저장된다
      </p>
    </Box>
  );
}

/* ─────────────────────────────── 공통 조각 ─────────────────────────────── */

const INPUT =
  'cut min-w-0 flex-1 px-4 py-3 text-[13px] text-bone transition-colors placeholder:text-ash focus:border-tung/40 focus:outline-none';

/*
 * 자유 채팅 대화창 — 산업용 .cut 대신 둥근 대화 바로 자연스럽게 짓는다.
 * 평상시엔 CHAT_RESTING(잠든 바)만 보이고, 누르면 CHAT_INPUT(깨어난 입력칸)으로 바뀐다.
 * 강조색은 room-green 스코프가 초록으로 옮긴다 (app/globals.css).
 */
const CHAT_RESTING =
  'group flex w-full items-center gap-3 rounded-2xl border border-bone/10 bg-black/25 px-5 py-3.5 text-left text-[13px] text-ash transition-colors hover:border-tung/40 hover:text-bone';
const CHAT_INPUT =
  'min-w-0 flex-1 rounded-2xl border border-tung/40 bg-black/40 px-5 py-3.5 text-[13px] text-bone placeholder:text-ash transition-shadow focus:border-tung/60 focus:outline-none focus:shadow-[0_0_0_3px_rgba(0,255,102,0.12)]';
const CHAT_SEND =
  'flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-2xl bg-tung/15 text-flare transition-colors hover:bg-tung/25 disabled:cursor-not-allowed disabled:bg-black/25 disabled:text-ash';

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
