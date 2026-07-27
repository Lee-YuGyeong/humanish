/**
 * 게임 화면 — 페이즈에 따라 분기. 소유: C (SPEC §2, §6, §12.5)
 *
 * 지켜야 하는 계약 네 가지.
 *   I1  클라이언트는 players가 아니라 public_players를 읽는다
 *   I2  카운트다운은 표시용이다. 판정은 서버가 한다
 *   I9  쓰기는 전부 /api를 거친다. anon 키는 읽기 전용이다
 *   I10 모든 구독·쿼리에 방 필터를 건다. 채널 이름은 room:<room_id>
 */
'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getBrowserClient } from '@/lib/server/supabase';
import { PlayerGrid } from '@/components/player-grid';
import type { Phase, PublicPlayer, Question, Room } from '@/lib/game/types';

interface Me {
  player: PublicPlayer | null;
  is_host: boolean;
  answered: boolean;
  voted: boolean;
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

const PHASE_LABEL: Record<Phase, string> = {
  lobby: '대기실',
  question: '공통 질문',
  target: '지목 질문',
  chat: '자유 채팅',
  vote: '투표',
  reveal: '결과',
  replay: '다시 하기',
};

export function RoomView({ code }: { code: string }) {
  const [room, setRoom] = useState<Room | null>(null);
  const [players, setPlayers] = useState<PublicPlayer[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [answers, setAnswers] = useState<AnswerRow[]>([]);
  const [votes, setVotes] = useState<VoteRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [remainMs, setRemainMs] = useState<number | null>(null);

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
      .select('id, code, phase, phase_seq, phase_ends_at, round, host_id, roster_seq')
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

    const visible = ((as ?? []) as (AnswerRow & { question_id: string })[]).filter(
      (a) => a.question_id === now?.id,
    );
    setAnswers(visible);
  }, [code]);

  /** 서버 시각 오프셋 (SPEC §12.5). 접속할 때 한 번. */
  useEffect(() => {
    void (async () => {
      const before = Date.now();
      const { now } = await fetch('/api/time').then((r) => r.json());
      // 왕복 시간의 절반을 빼서 대략 보정한다
      offsetRef.current = new Date(now).getTime() - (before + Date.now()) / 2;
    })();
    void refresh();
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
        advancedSeqRef.current = room.phase_seq; // 같은 seq로 두 번 부르지 않는다
        void fetch('/api/phase/advance', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ room_id: room.id, expected_seq: room.phase_seq }),
        }).then(() => refresh());
      }
    };

    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [room?.id, room?.phase_seq, room?.phase_ends_at, serverNow, refresh]);

  const post = useCallback(
    async (path: string, body: unknown) => {
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
    },
    [refresh],
  );

  if (error && !room) {
    return (
      <main className="mx-auto max-w-2xl p-8">
        <p className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-700">{error}</p>
        <Link href="/" className="mt-4 inline-block text-sm underline">
          처음으로
        </Link>
      </main>
    );
  }

  if (!room) {
    return <main className="mx-auto max-w-2xl p-8 text-sm text-gray-500">불러오는 중…</main>;
  }

  const seconds = remainMs == null ? null : Math.max(0, Math.ceil(remainMs / 1000));

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <header className="flex items-baseline justify-between">
        <h1 className="font-mono text-xl font-semibold tracking-[0.2em]">{room.code}</h1>
        <div className="flex items-baseline gap-3 text-sm">
          <span className="text-gray-500">{PHASE_LABEL[room.phase]}</span>
          {room.phase === 'question' && <span className="text-gray-400">{room.round}/2</span>}
          {seconds != null && (
            <span className="font-mono tabular-nums" aria-live="polite">
              {seconds}초
            </span>
          )}
        </div>
      </header>

      <PlayerGrid players={players} meId={me?.player?.id} />

      <Panel
        room={room}
        players={players}
        me={me}
        question={question}
        answers={answers}
        votes={votes}
        post={post}
      />

      {error && (
        <p className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30">
          {error}
        </p>
      )}

      <p className="mt-auto text-xs text-gray-400">
        타이머는 표시용이다. 페이즈 전환은 서버가 정한다 (SPEC I2).
      </p>
    </main>
  );
}

function Panel({
  room,
  players,
  me,
  question,
  answers,
  votes,
  post,
}: {
  room: Room;
  players: PublicPlayer[];
  me: Me | null;
  question: Question | null;
  answers: AnswerRow[];
  votes: VoteRow[];
  post: (path: string, body: unknown) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [target, setTarget] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const nameOf = (id: string) => players.find((p) => p.id === id)?.nickname ?? '?';

  if (!me?.player) {
    return (
      <Box>
        <p className="text-sm">이 방의 참가자가 아니다.</p>
        <Link href="/" className="text-sm underline">
          코드로 다시 입장하기
        </Link>
      </Box>
    );
  }

  if (room.phase === 'lobby') {
    return (
      <Box>
        <p className="text-sm text-gray-500">
          친구에게 <strong className="font-mono">{room.code}</strong> 를 알려주면 들어온다.
          <br />
          빈자리는 시작할 때 채워진다.
        </p>
        {me.is_host ? (
          <button
            type="button"
            onClick={() => void post('/api/room/start', { room_id: room.id })}
            className="rounded-lg bg-black px-4 py-3 text-sm font-medium text-white dark:bg-white dark:text-black"
          >
            시작하기
          </button>
        ) : (
          <p className="text-sm text-gray-400">방장이 시작하기를 기다리는 중…</p>
        )}
      </Box>
    );
  }

  if (room.phase === 'question' || room.phase === 'target') {
    const isTargetPhase = room.phase === 'target';
    const iAmTarget = question?.target_id === me.player.id;
    const canAnswer = !me.answered && (!isTargetPhase || iAmTarget);

    return (
      <Box>
        <p className="text-base font-medium">{question?.text ?? '질문을 기다리는 중…'}</p>
        {isTargetPhase && question?.target_id && (
          <p className="text-sm text-gray-500">→ {nameOf(question.target_id)}에게</p>
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
              className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={!text.trim()}
              className="rounded-lg border px-4 py-2 text-sm disabled:opacity-40"
            >
              제출
            </button>
          </form>
        ) : (
          <p className="text-sm text-gray-400">
            {me.answered
              ? '제출했다. 시간이 끝나면 전부 공개된다.'
              : '지목받은 사람이 답하는 중…'}
          </p>
        )}

        {answers.length > 0 && (
          <ul className="space-y-1 border-t pt-3 text-sm">
            {answers.map((a) => (
              <li key={a.id}>
                <span className="text-gray-500">{nameOf(a.player_id)}</span> {a.text}
              </li>
            ))}
          </ul>
        )}
      </Box>
    );
  }

  if (room.phase === 'chat') {
    return (
      <Box>
        <p className="text-sm text-gray-500">
          자유 채팅 구간이다. 아직 안 붙었다 (SPEC §13-6).
          <br />
          시간이 지나면 투표로 넘어간다.
        </p>
      </Box>
    );
  }

  if (room.phase === 'vote') {
    return (
      <Box>
        <p className="text-sm font-medium">누가 AI인가?</p>
        <PlayerGrid
          players={players}
          meId={me.player.id}
          selectable={!me.voted}
          selectedId={target}
          onSelect={setTarget}
        />
        {me.voted ? (
          <p className="text-sm text-gray-400">투표했다. 결과는 전원이 마치면 공개된다.</p>
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
              className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={!target}
              className="rounded-lg border px-4 py-2 text-sm disabled:opacity-40"
            >
              투표
            </button>
          </form>
        )}
      </Box>
    );
  }

  // reveal · replay
  return (
    <Box>
      <p className="text-sm font-medium">투표 결과</p>
      {votes.length === 0 ? (
        <p className="text-sm text-gray-400">아직 집계되지 않았다.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {votes.map((v) => (
            <li key={v.voter_id}>
              <span className="text-gray-500">{nameOf(v.voter_id)}</span> → {nameOf(v.target_id)}
              {v.reason && <span className="text-gray-400"> · {v.reason}</span>}
            </li>
          ))}
        </ul>
      )}
      <p className="border-t pt-3 text-xs text-gray-400">
        정답(누가 AI였는지)과 점수는 아직 안 붙었다 — calcScores가 미구현이다 (SPEC §8, §17.2).
      </p>
      <Link href="/" className="text-sm underline">
        처음으로
      </Link>
    </Box>
  );
}

function Box({ children }: { children: React.ReactNode }) {
  return <section className="flex flex-col gap-3 rounded-lg border p-4">{children}</section>;
}
