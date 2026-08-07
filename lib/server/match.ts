/**
 * 전적을 적고 읽는다. 소유: A (SPEC §15-2-결정 「아직 안 한 것」)
 *
 * ┌─ 한 판이 끝날 때 사람 한 명당 한 행 ──────────────────────────────────────┐
 * │ 적는 곳은 /api/reveal 하나뿐이다. 봇은 계정이 없어서 행이 없다.            │
 * │ 읽는 곳은 /api/profile/stats 하나뿐이고, 로비 왼쪽 기둥이 그린다.          │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 왜 reveal 에서 적는가 (advance_phase 가 아니라):
 *   점수는 calcScores 로 계산하는데 그건 TS 순수 함수라 plpgsql 이 못 부른다.
 *   §17.2 가 같은 이유로 점수 계산을 reveal 훅으로 빼 뒀고, 여기도 그 결정을 탄다.
 *   채점을 SQL 로 한 벌 더 쓰면 규칙이 두 군데로 갈린다 — 이 저장소가 검사 목록으로
 *   두 번 데인 것과 같은 실수다 (CLAUDE.md).
 *
 * ★ **한 번만 적힌다.** 방의 모든 사람이 reveal 화면을 열면 이 함수도 그만큼
 *   불리는데, 기본키가 (room_id, user_id) 라 두 번째부터는 조용히 무시된다.
 *   거꾸로 한 사람만 열어도 **그 방 사람 전원의 행**이 그때 다 적힌다.
 *
 * ★ 여기서 실패해도 reveal 응답은 그대로 나가야 한다. 전적은 곁다리고,
 *   결과 화면은 게임의 마지막 장면이다. 부르는 쪽이 await 하지 않는다.
 */

import type { MatchHistoryPage, MatchRecord, ProfileStats, RecentMatch, Role } from '@/lib/game/types';
import type { RoundWinner } from '@/lib/mp/protocol';
import { getServiceClient } from '@/lib/server/supabase';
import { toProfileStats } from '@/lib/server/stats';

/**
 * 사람이 이보다 적은 방은 전적에 넣지 않는다 (SPEC §15-2-결정 「아직 안 한 것」).
 *
 * 정원 5인 방을 혼자 만들면 봇이 4명이고 스파이도 안 뽑힌다(§8). 아무나 찍어도
 * 진짜 AI라 시민 점수가 그냥 들어온다 — 혼자 방을 열고 닫으며 전적을 만들 수 있다.
 * DB의 humans check 와 두 겹이다.
 */
const MIN_HUMANS_FOR_RECORD = 2;

/** 로비가 그리는 최근 게임 줄 수. 더 받아도 화면에 안 들어간다. */
const RECENT_LIMIT = 5;

/** recordMatch 가 받는 한 자리. reveal 이 이미 들고 있는 값들이다. */
export interface MatchSeat {
  /** 계정. 봇은 null 이고, 로그인 없이 들어온 사람도 null 이다 */
  userId: string | null;
  isBot: boolean;
  role: Role | null;
  score: number;
}

/**
 * 한 판을 적는다. 이미 적힌 판이면 아무 일도 하지 않는다.
 *
 * @param roomId 방. **외래키가 아니다** — 방은 24시간 뒤 지워지지만(§16.4)
 *               전적은 남아야 한다 (supabase/schema.sql 의 match_results 주석)
 * @param seats  그 방의 모든 자리. 봇도 포함해서 넘긴다 — 사람 수를 여기서 센다
 */
export async function recordMatch(roomId: string, seats: MatchSeat[]): Promise<void> {
  const humans = seats.filter((s) => !s.isBot);
  if (humans.length < MIN_HUMANS_FOR_RECORD) return;

  const rows = humans
    // 계정이 없으면 적을 곳이 없다. 역할이 비면 배정 전에 끝난 판이라 셀 수 없다.
    // 'ai' 는 봇의 역할이라 여기 올 수 없지만, 왔다면 계정과 봇이 이어졌다는
    // 뜻이므로 적지 않는다 (I1). DB의 role check 와 두 겹이다.
    .filter((s) => s.userId && (s.role === 'citizen' || s.role === 'spy'))
    .map((s) => ({
      room_id: roomId,
      user_id: s.userId as string,
      role: s.role as 'citizen' | 'spy',
      score: Math.max(0, Math.round(s.score)),
      /*
       * 자기 목표를 이뤘나. 지금 채점에서는 score > 0 과 같은 말이다 —
       * 시민은 진짜 AI를 맞혀야 +2 고, 스파이는 사람 표를 받아야 +4 다
       * (lib/game/rules.ts 의 SCORE_RULE). 그래도 **판정을 저장한다.**
       * 나중에 참가상 같은 걸 붙여 0점이 사라지면, 계산해서 보여주는 방식은
       * 옛날 판까지 전부 '승'으로 바꿔버린다.
       */
      won: s.score > 0,
      humans: humans.length,
    }));

  if (rows.length === 0) return;

  const { error } = await getServiceClient()
    .from('match_results')
    // 이미 적힌 판은 건드리지 않는다. 같은 방의 다른 사람이 먼저 열었을 뿐이다.
    .upsert(rows, { onConflict: 'room_id,user_id', ignoreDuplicates: true });

  if (error) throw new Error(`전적 기록 실패: ${error.message}`);
}

/* ─────────────────────────── 월드 판 (SPEC §18.4) ─────────────────────────── */

/**
 * 월드 판의 승패→점수 환산 (SPEC §15-2-결정의 §18.4 주석).
 *
 * 이긴 판 +3 · **진 판 -1** (2026-08-07 결정). 예전에는 진 판에도 +1 을 줬다 —
 * 참가 자체를 세서 계속 지는 사람의 레벨도 조금씩 오르게 하려던 값이다.
 * 그런데 화면에서 "패배"라고 적힌 줄 옆에 +1 이 붙어서, **지고도 오르는** 것으로
 * 읽혔다. 이제 지면 깎인다: 레벨은 판수가 아니라 이긴 판을 센다.
 *
 * ★ 이 둘은 게임 규칙이 아니라 전적 쪽 값이다. 바꾸는 건 레벨 곡선을 바꾸는
 *   일이고 §18(승패 판정)은 건드리지 않는다.
 * ★ 음수라서 **누적 경험치가 줄 수 있다.** DB 의 score check 도 음수를 받도록
 *   같이 풀었고(supabase/schema.sql), 레벨은 0 밑으로 안 내려간다
 *   (lib/server/stats.ts 의 levelFromExp 가 0 에서 자른다).
 * ★ 이미 적힌 행은 그대로 둔다 — 저장하는 값이라 소급이 없다. 옛 판의 +1 은
 *   그 판의 기록이다.
 *
 * 2D 판(recordMatch)의 개인 점수와 다른 이유: 월드는 §18.4가 이미 코드로 돌고
 * 있어서(진영 승패, worker/src/roundtable.ts) 새 규칙으로 적고, 2D 는 §18.7 이
 * 옮겨질 때까지 옛 채점(calcScores) 그대로 적는다.
 */
const WORLD_EXP_WON = 3;
const WORLD_EXP_LOST = -1;

/** 월드 판 시작 시점의 사람 좌석 하나. 봇은 애초에 안 온다 (계정이 없다). */
export interface WorldMatchSeat {
  /** 계정. 월드는 로그인 없이도 들어올 수 있어서 null 이 있을 수 있다 */
  userId: string | null;
  /** 그 판의 역할 (SPEC §18.2). 'spy' 가 아니라 'actor' 다 — §15-2-결정 주석 */
  role: 'citizen' | 'actor';
}

/**
 * 월드 판 하나를 match_results 행들로 바꾼다. **순수 함수**라 npm test 가 직접
 * 검사한다 (tests/lib/server/world-match.test.ts). 쓰는 쪽은 recordWorldMatch.
 *
 * won 은 §18.4 진영 승패 그대로다: 내 진영이 이긴 판만 true. winner 가 'ai' 면
 * (부결·지목 없음·시민 처형) 사람은 전부 진 판이다 — role === winner 가 그 셋을
 * 한 번에 말한다.
 */
export function buildWorldMatchRows(
  matchId: string,
  winner: RoundWinner,
  seats: WorldMatchSeat[],
): {
  room_id: string;
  user_id: string;
  role: 'citizen' | 'actor';
  score: number;
  won: boolean;
  humans: number;
}[] {
  if (seats.length < MIN_HUMANS_FOR_RECORD) return [];

  return seats
    .filter((s) => s.userId) // 계정이 없으면 적을 곳이 없다. 사람 수에는 위에서 이미 셌다
    .map((s) => {
      const won = s.role === winner;
      return {
        /*
         * ★ 방 id 가 아니라 **판 id** 다 (worker RoundState.matchId 의 상자).
         *   room_id 컬럼은 외래키가 아니고 역할이 "같은 판 두 번 안 적기" 하나라
         *   (supabase/schema.sql) 판 id 가 그 자리의 뜻에 맞다 — 같은 방의
         *   rematch 판들이 각각 한 번씩 적힌다.
         */
        room_id: matchId,
        user_id: s.userId as string,
        role: s.role,
        score: won ? WORLD_EXP_WON : WORLD_EXP_LOST,
        won,
        humans: seats.length,
      };
    });
}

/**
 * 월드 판 하나를 적는다. 부르는 곳은 /api/internal/world-match 하나뿐이다.
 * 이미 적힌 판(워커가 겹쳐 보낸 경우)이면 아무 일도 하지 않는다 — recordMatch 와
 * 같은 기본키 무시 패턴이다.
 */
export async function recordWorldMatch(
  matchId: string,
  winner: RoundWinner,
  seats: WorldMatchSeat[],
): Promise<void> {
  const rows = buildWorldMatchRows(matchId, winner, seats);
  if (rows.length === 0) return;

  const { error } = await getServiceClient()
    .from('match_results')
    .upsert(rows, { onConflict: 'room_id,user_id', ignoreDuplicates: true });

  if (error) throw new Error(`월드 전적 기록 실패: ${error.message}`);
}

/** match_stats(uuid) 가 돌려주는 한 행 (supabase/schema.sql). */
interface Totals {
  games: number;
  wins: number;
  exp: number;
}

/**
 * 내 전적. 계정 하나치다.
 *
 * ★ 집계와 목록을 따로 묻는다. 합계를 클라이언트에서 내려면 전적 전체를 받아야
 *   하는데, 판수가 늘수록 로비를 열 때마다 그게 다 왕복한다.
 */
export async function readMatchStats(userId: string): Promise<ProfileStats> {
  const db = getServiceClient();

  const [{ data: totals, error: totalsError }, { data: recent, error: recentError }] =
    await Promise.all([
      db.rpc('match_stats', { p_user: userId }).maybeSingle(),
      db
        .from('match_results')
        .select('room_id, role, won, score, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(RECENT_LIMIT),
    ]);

  if (totalsError) throw new Error(`전적 집계 실패: ${totalsError.message}`);
  if (recentError) throw new Error(`최근 판 조회 실패: ${recentError.message}`);

  // 한 판도 없으면 match_stats 는 0,0,0 한 행을 준다. 그래도 null 을 대비한다 —
  // 여기서 터지면 전적이 없다는 이유로 로비가 안 뜬다.
  const sums = (totals as Totals | null) ?? { games: 0, wins: 0, exp: 0 };

  return toProfileStats(sums, (recent ?? []) as RecentMatch[]);
}

/** 기록 화면 한 쪽의 줄 수. 커서(before)로 다음 쪽을 이어 받는다. */
const HISTORY_PAGE = 30;

/**
 * 내 전체 기록, 한 쪽 (SPEC §15-2-결정 — 기록 화면 /account/history).
 *
 * ★ readMatchStats 와 같은 규칙 — **계정 하나치만.** userId 는 라우트가 쿠키
 *   세션에서 되찾아 넘긴다 (I9). 남의 기록을 읽는 길은 없다 (I1).
 * ★ 오프셋이 아니라 created_at 커서다. 오프셋은 새 판이 적히는 사이에 쪽이
 *   밀려 같은 줄이 두 번 오고, 판수가 늘수록 뒤쪽이 느려진다.
 *   (내 행끼리 created_at 이 겹칠 일은 사실상 없다 — 한 판에 내 행은 하나다.)
 */
export async function readMatchHistory(
  userId: string,
  before: string | null,
): Promise<MatchHistoryPage> {
  let query = getServiceClient()
    .from('match_results')
    .select('room_id, role, won, score, humans, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(HISTORY_PAGE);
  if (before) query = query.lt('created_at', before);

  const { data, error } = await query;
  if (error) throw new Error(`기록 조회 실패: ${error.message}`);

  const matches = (data ?? []) as MatchRecord[];
  return {
    matches,
    // 꽉 찬 쪽만 다음이 있을 수 있다. 모자라면 거기가 끝이다.
    next: matches.length === HISTORY_PAGE ? matches[matches.length - 1].created_at : null,
  };
}
