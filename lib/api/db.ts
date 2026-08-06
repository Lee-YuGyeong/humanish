/**
 * 브라우저에서 하는 **읽기**만 모아 둔다. 소유: A
 *
 * ┌─ 여기 있는 것과 없는 것 ───────────────────────────────────────────────────┐
 * │ 있다  anon 키로 읽는 것. RLS(supabase/policies.sql)가 그대로 걸린다        │
 * │ 없다  쓰기. 전부 /api 를 지난다 (I9) → lib/api/room.ts                     │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 두 가지가 이 파일의 존재 이유다.
 *
 *   1. **방 스코프(I10).** 모든 함수가 roomId 를 첫 인자로 받고 그걸 .eq 로 건다.
 *      필터 없는 쿼리를 짜려면 이 파일 밖으로 나가야 하고, 그건 리뷰에서 보인다.
 *      화면에서 직접 db.from('...') 을 부르기 시작하면 그 순간 이 보증이 사라진다.
 *
 *   2. **뷰만 읽는다 (I1).** players 가 아니라 public_players, messages 가 아니라
 *      public_messages 다. 원본 테이블에는 is_bot 과 visible_at 이 그대로 있다.
 *      새 읽기를 더할 때 "이 이름에 public_ 이 붙어야 하나"를 먼저 묻는다.
 */

import { getBrowserClient } from '@/lib/server/supabase';
import type { PublicPlayer, Question, Room } from '@/lib/game/types';

/**
 * ★ capacity 를 빠뜨리면 room.capacity 가 undefined 가 되어 좌석 그리드가 0칸이 된다
 *   (SPEC §17.6). select('*') 로 바꾸지 않는다 — 컬럼이 늘 때 뭐가 딸려오는지 모른다.
 */
const ROOM_COLUMNS =
  'id, code, name, capacity, phase, phase_seq, phase_ends_at, round, host_id, roster_seq, nominated_player_id, revote_candidates, world_started_at';

export interface AnswerRow {
  id: string;
  player_id: string;
  text: string;
  question_id: string;
}

export interface VoteRow {
  voter_id: string;
  target_id: string;
  reason: string;
}

export interface MessageRow {
  id: string;
  player_id: string;
  text: string;
  visible_at: string;
}

/** supabase-js 는 던지지 않고 { error } 를 준다. react-query 가 보려면 던져야 한다. */
function must<T>(what: string, res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(`${what} 읽기 실패: ${res.error.message}`);
  return (res.data ?? []) as T;
}

/** 코드로 방을 찾는다. 없으면 null — 오타를 에러가 아니라 화면 문구로 다루기 위해서다. */
export async function fetchRoomByCode(code: string): Promise<Room | null> {
  const db = await getBrowserClient();
  const res = await db
    .from('rooms')
    .select(ROOM_COLUMNS)
    .eq('code', code.toUpperCase())
    .maybeSingle();

  if (res.error) throw new Error(`방 읽기 실패: ${res.error.message}`);
  return (res.data as Room | null) ?? null;
}

/** 좌석 명단. ★ players 가 아니라 public_players 다 (I1). */
export async function fetchRoster(roomId: string): Promise<PublicPlayer[]> {
  const db = await getBrowserClient();
  return must<PublicPlayer[]>(
    '참가자',
    await db.from('public_players').select('*').eq('room_id', roomId).order('seat'),
  );
}

export async function fetchQuestions(roomId: string): Promise<Question[]> {
  const db = await getBrowserClient();
  return must<Question[]>(
    '질문',
    await db.from('questions').select('*').eq('room_id', roomId).order('round'),
  );
}

/**
 * 공개된 답변.
 *
 * ★ 클라이언트가 visible_at 을 거르지 않는다. RLS 가 visible_at <= now() 인 행만
 *   주므로(SPEC §7.2) 여기 온 것은 전부 이미 공개된 것이다. 화면에서 한 번 더
 *   거르면 "안 온 것"과 "걸러진 것"이 뒤섞여 왜 안 보이는지 알 수 없어진다.
 */
export async function fetchAnswers(roomId: string): Promise<AnswerRow[]> {
  const db = await getBrowserClient();
  return must<AnswerRow[]>(
    '답변',
    await db
      .from('answers')
      .select('id, player_id, text, question_id')
      .eq('room_id', roomId),
  );
}

/** 투표. reveal 이후에만 행이 보인다 (SPEC §7.2). */
export async function fetchVotes(roomId: string): Promise<VoteRow[]> {
  const db = await getBrowserClient();
  return must<VoteRow[]>(
    '투표',
    await db
      .from('votes')
      .select('voter_id, target_id, reason')
      .eq('room_id', roomId),
  );
}

/**
 * 자유 채팅.
 *
 * ★ Broadcast 를 쓰지 않고 폴링한다 (SPEC §5.4, §13-6). 봇 메시지는 타이핑 지연
 *   때문에 미래 visible_at 을 갖는데, Broadcast 는 insert 순간에 나가므로 도착
 *   시각과 표시 시각의 간격이 봇만 유독 길어진다 — devtools 를 열면 그것만으로
 *   봇이 갈린다 (I1). 뷰가 visible_at 이 지난 행만 내보내므로 이쪽은 샐 게 없다.
 */
export async function fetchMessages(roomId: string): Promise<MessageRow[]> {
  const db = await getBrowserClient();
  return must<MessageRow[]>(
    '메시지',
    await db
      .from('public_messages')
      .select('id, player_id, text, visible_at')
      .eq('room_id', roomId)
      .order('visible_at'),
  );
}
