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

import type { ProfileStats, RecentMatch, Role } from '@/lib/game/types';
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
