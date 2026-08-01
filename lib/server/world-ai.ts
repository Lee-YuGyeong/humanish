/**
 * 3D 월드의 AI 거주자. 소유: A
 *
 * ┌─ 왜 players 행을 만들지 않는가 (I1) ──────────────────────────────────────┐
 * │ 로비에 봇을 앉히면 public_players 가 phase='lobby' 동안 is_ready·lobby_line 을 │
 * │ 내려주는데(supabase/policies.sql), 봇만 그 값이 비어 있어서 **값이 있는 자리 =  │
 * │ 사람**이 된다. 봇 명단이 통째로 드러난다. 그 파일이 같은 경고를 달아두었고,      │
 * │ SPEC §15-3 에 "봇을 로비에서 채우는 안"이 아직 미결정으로 열려 있다.           │
 * │                                                                            │
 * │ 그래서 월드 AI 는 **게임 좌석이 아니다.** DB 에 행이 없고, 로비 화면·투표·역할  │
 * │ 어디에도 나타나지 않는다. 워커가 3D 공간에 세우는 아바타일 뿐이다.             │
 * │ 게임 규칙은 한 줄도 바뀌지 않는다 — 시작하면 진짜 좌석이 이 자리를 대신한다.    │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ id 는 반드시 uuid 모양이어야 한다 (I1) ──────────────────────────────────┐
 * │ PlayerSnapshot.id 는 클라이언트로 그대로 나간다. 'world-ai-1' 같은 걸 쓰면    │
 * │ **id 모양만 보고 AI를 골라낼 수 있다.** 그래서 방 id + 번호를 해시해 진짜      │
 * │ 플레이어 uuid 와 구별되지 않는 값을 만든다. 결정적이라 DO 가 재시작해도        │
 * │ 같은 id 가 나오고, 그래야 저장된 좌표(BotPose)를 이어받는다.                  │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

import { getServiceClient } from '@/lib/server/supabase';
import { ApiError } from '@/lib/server/auth';

/**
 * 월드에 세울 AI 수. 게임 정원과 무관하다 — 빈자리가 있는 만큼만 선다.
 * 늘리기 전에 "봇끼리 떠들기 시작하지 않나"를 확인할 것 (worker/src/room-do.ts의
 * reactToHuman 은 사람 발화에서만 불린다).
 */
export const WORLD_AI_COUNT = 1;

/*
 * 월드 AI 가 연기할 인물은 lib/agent/world-persona.ts 로 이관했다 (페르소나는 B 도메인).
 * "지금은 게임 중이 아니다" 부정문도 함께 사라졌다 — 무대 자체가
 * generate.ts 의 `setting: 'world'` 분기로 깔린다 (world-agent 라우트가 싣는다).
 */

/**
 * LLM 이 늦거나 실패했을 때 월드 AI 가 대신 던지는 한마디.
 *
 * ★ 게임 문구 풀(bot_line_pool.phase='chat')을 쓰지 않는다. 거기는 "그래서 누구 찍을
 *   거야" · "시간 얼마 안 남았지" 처럼 **게임이 돌아가는 중**을 전제한 말들이라,
 *   그냥 모여 노는 공간에서 나오면 그 자체로 헛소리다 (실측 — 사용자가 본 AI 발언이
 *   전부 이 목록이었다).
 *
 * 여기 문구는 맥락이 없어도 어색하지 않은 것만 둔다. 클라이언트로 절대 나가지 않는다.
 */
export const WORLD_LINES: readonly string[] = [
  '여기 생각보다 넓네',
  '소파 앉으면 편한가',
  '저 스크린 계속 돌아가네',
  '음악 좀 크지 않아',
  '아 잠깐만',
  '방금 뭐라고 했어',
  '오 이거 뭐야',
  '천장 높다',
  '박스 저거 다 진짜인가',
  '조명 색 괜찮네',
  '여기 어떻게 알고 왔어',
  '좀 걷다 올게',
  '배고프다',
  '다들 뭐 하고 있어',
  '오늘 좀 피곤하네',
  'ㅋㅋㅋ',
  '그러게',
  '진짜?',
];

export interface WorldSeat {
  id: string;
  seat: number;
  nickname: string;
  mask_id: string;
  /** ★ 서버끼리만 오간다. 클라이언트로 나가는 PlayerSnapshot 에는 없다 */
  is_bot: boolean;
  /**
   * players 행이 없는 월드 AI. **워커에게는 보내지 않는다** (world-room 이 걷어낸다) —
   * 워커는 사람과 봇만 구분하면 되고, 그 아래 갈래까지 알 이유가 없다.
   * agent_logs.player_id 가 players(id) 를 참조하므로 기록을 건너뛸 때만 쓴다.
   */
  synthetic?: true;
}

export interface WorldRoster {
  capacity: number;
  phase: string | null;
  seats: WorldSeat[];
  /**
   * 월드 AI 가 서 있는 방인가 (= 게임이 아직 안 돌아간다).
   *
   * 워커가 이걸로 대화 성향을 바꾼다. 게임 중 봇은 아껴 말해야 하지만(늘 대꾸하는
   * 자리가 곧 봇이다), 혼자 들어온 사람 옆의 동행자가 열 번에 네 번만 대답하면
   * 그건 그냥 고장 난 것으로 보인다.
   */
  companionMode: boolean;
}

/** 방 id + 번호 → 결정적 uuid. 진짜 players.id 와 모양이 같아야 한다 (머리말 2번 상자). */
async function stableUuid(roomId: string, index: number): Promise<string> {
  const data = new TextEncoder().encode(`${roomId}:world-ai:${index}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const hex = Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  // uuid v4 자리(버전 4 · variant 10xx)를 맞춘다. 그래야 uuid 검사기에도 걸리지 않는다.
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * 워커에게 줄 월드 명단 — 진짜 사람·봇 좌석에 월드 AI 를 얹는다.
 *
 * 게임이 시작되면(phase !== 'lobby') **얹지 않는다.** 그때는 진짜 봇이 빈자리를
 * 채우고 있고, 거기에 AI 를 더하면 정원을 넘고 id 도 바뀐다.
 */
export async function buildWorldRoster(roomId: string): Promise<WorldRoster | null> {
  const db = getServiceClient();

  const { data: room } = await db
    .from('rooms')
    // capacity를 빠뜨리면 자리 계산이 통째로 어긋난다 — 컬럼을 항상 명시한다.
    .select('id, capacity, phase')
    .eq('id', roomId)
    .maybeSingle();
  if (!room) return null;

  // 방 스코프를 반드시 건다 (I10).
  const { data: playerRows, error } = await db
    .from('players')
    .select('id, seat, nickname, is_bot')
    .eq('room_id', roomId)
    .order('seat', { ascending: true });
  if (error) throw new ApiError(500, `좌석 조회 실패: ${error.message}`);

  const seats: WorldSeat[] = ((playerRows ?? []) as {
    id: string;
    seat: number;
    nickname: string;
    is_bot: boolean;
  }[]).map((p) => ({
    id: p.id,
    seat: p.seat,
    nickname: p.nickname,
    mask_id: `mask-${String(p.seat).padStart(2, '0')}`,
    is_bot: p.is_bot,
  }));

  let companionMode = false;
  if (room.phase === 'lobby') {
    const taken = new Set(seats.map((s) => s.seat));
    let added = 0;
    for (let seat = 1; seat <= room.capacity && added < WORLD_AI_COUNT; seat += 1) {
      if (taken.has(seat)) continue;
      seats.push({
        // 닉네임·가면은 fill_with_bots 와 같은 규칙이다. 다르게 만들면 그게 표식이다.
        id: await stableUuid(roomId, added),
        seat,
        nickname: `익명${seat}`,
        mask_id: `mask-${String(seat).padStart(2, '0')}`,
        is_bot: true,
        synthetic: true,
      });
      added += 1;
    }
    seats.sort((a, b) => a.seat - b.seat);
    companionMode = added > 0;
  }

  return { capacity: room.capacity, phase: room.phase, seats, companionMode };
}
