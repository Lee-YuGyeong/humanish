/**
 * 방 · 페이즈 진단. 소유: A (SPEC §5, §12.1, §12.5, §13-2, §13-3)
 *
 * GET /api/admin/rooms  →  { now, app_now, drift_ms, rooms: AdminRoom[] }
 *
 * /admin 화면 전용 내부 진단이다. 게임 진행에는 쓰이지 않는다.
 * 읽기만 한다 — 여기서 페이즈를 넘기지 않는다. 전환은 /api/phase/advance 하나뿐이고
 * 거기는 쿠키로 되찾은 player_id를 요구한다 (I9, SPEC §17.4).
 *
 * ┌─ 여기서 answers·votes 개수를 세지 않는 이유 (I1) ────────────────────────┐
 * │ 봇 답변과 봇 투표는 **페이즈 진입 순간** 한꺼번에 들어간다               │
 * │ (on_enter_phase, SPEC §5.3). 그래서 진행 중인 방의 답변 수·투표 수는     │
 * │ 그 자체로 "이 방의 봇 수"다. vote 페이즈로 넘어간 직후 투표가 3개면      │
 * │ 봇이 3명이라는 뜻이고, 남은 자리가 전부 사람이라는 뜻이다.               │
 * │                                                                         │
 * │ RLS가 그 행들을 가리는 것도 같은 이유다 (answers는 visible_at 게이팅,    │
 * │ votes는 reveal 이전 전면 차단 — supabase/policies.sql). service role로   │
 * │ 세서 내려보내면 그 방어를 이 라우트 하나로 무너뜨린다.                   │
 * │                                                                         │
 * │ is_bot을 안 보내는 것만으로는 부족하다. **세어서 보내는 것도 같은        │
 * │ 위반이다.** 여기에 컬럼을 더할 때마다 "이걸로 봇을 골라낼 수 있나"를     │
 * │ 먼저 묻는다 (SPEC §7.2).                                                │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * seated(앉은 수)는 괜찮다. public_players가 이미 같은 수의 닉네임·좌석을 보여준다.
 * roles_assigned도 방 단위 불리언이라 사람과 봇을 가르지 않는다.
 */

import { getServiceClient } from '@/lib/server/supabase';
import { apiError } from '@/lib/server/auth';
import type { Phase } from '@/lib/game/types';

export const dynamic = 'force-dynamic';

/** 한 화면에 담기는 만큼만. 방은 24시간 뒤 정리된다 (SPEC §16.4). */
const ROOM_LIMIT = 50;

export interface AdminRoom {
  id: string;
  code: string;
  capacity: number;
  phase: Phase;
  phase_seq: number;
  round: number;
  phase_ends_at: string | null;
  roster_seq: number;
  created_at: string;
  /** 앉은 자리 수. 봇과 사람을 가르지 않는다 (I1). */
  seated: number;
  /** player_roles가 채워졌나 = /api/room/start를 제대로 거쳤나 (SPEC §8) */
  roles_assigned: boolean;
  /**
   * DB 시각 기준 남은 ms. 시간이 없는 페이즈(lobby·reveal·replay)는 null.
   * 음수면 이미 만료했는데 아직 안 넘어간 것이다 — 워치독이 잡아야 할 방이다.
   * ★ 판정은 전부 DB `now()`다. 클라이언트 시계를 쓰지 않는다 (I2).
   */
  remaining_ms: number | null;
}

export async function GET(): Promise<Response> {
  try {
    const db = getServiceClient();

    // 기준 시계는 DB 하나다. 앱 서버의 new Date()로 만료를 판정하면 안 된다 (SPEC §12.5).
    const { data: dbNowRaw, error: nowErr } = await db.rpc('server_now');
    if (nowErr) throw new Error(`server_now 실패: ${nowErr.message}`);

    const dbNow = new Date(dbNowRaw as string);
    const appNow = new Date();

    const { data: rooms, error: roomsErr } = await db
      .from('rooms')
      // ★ capacity를 빠뜨리면 화면의 "좌석/정원"이 0이 된다 (§17.6)
      .select('id, code, capacity, phase, phase_seq, round, phase_ends_at, roster_seq, created_at')
      .order('created_at', { ascending: false })
      .limit(ROOM_LIMIT);
    if (roomsErr) throw new Error(`rooms 조회 실패: ${roomsErr.message}`);

    const ids = (rooms ?? []).map((r) => r.id as string);

    // 방이 하나도 없으면 .in()에 빈 배열이 들어가 무의미한 쿼리가 두 번 나간다.
    if (ids.length === 0) {
      return Response.json(
        {
          now: dbNow.toISOString(),
          app_now: appNow.toISOString(),
          drift_ms: dbNow.getTime() - appNow.getTime(),
          rooms: [],
        },
        { headers: { 'cache-control': 'no-store' } },
      );
    }

    // ★ room_id만 고른다. is_bot을 select에 넣지 않는다 (I1).
    const [{ data: players, error: playersErr }, { data: roles, error: rolesErr }] =
      await Promise.all([
        db.from('players').select('room_id').in('room_id', ids),
        db.from('player_roles').select('room_id').in('room_id', ids),
      ]);
    if (playersErr) throw new Error(`players 조회 실패: ${playersErr.message}`);
    if (rolesErr) throw new Error(`player_roles 조회 실패: ${rolesErr.message}`);

    const seated = new Map<string, number>();
    for (const p of players ?? []) {
      const key = p.room_id as string;
      seated.set(key, (seated.get(key) ?? 0) + 1);
    }
    const assigned = new Set((roles ?? []).map((r) => r.room_id as string));

    const out: AdminRoom[] = (rooms ?? []).map((r) => ({
      id: r.id as string,
      code: r.code as string,
      capacity: r.capacity as number,
      phase: r.phase as Phase,
      phase_seq: r.phase_seq as number,
      round: r.round as number,
      phase_ends_at: (r.phase_ends_at as string | null) ?? null,
      roster_seq: r.roster_seq as number,
      created_at: r.created_at as string,
      seated: seated.get(r.id as string) ?? 0,
      roles_assigned: assigned.has(r.id as string),
      remaining_ms: r.phase_ends_at
        ? new Date(r.phase_ends_at as string).getTime() - dbNow.getTime()
        : null,
    }));

    return Response.json(
      {
        now: dbNow.toISOString(),
        app_now: appNow.toISOString(),
        /** DB 시계 − 앱 서버 시계. 개발 기계에서 2.26초까지 벌어진 적이 있다 (SPEC §12.5). */
        drift_ms: dbNow.getTime() - appNow.getTime(),
        rooms: out,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    return apiError(e);
  }
}
