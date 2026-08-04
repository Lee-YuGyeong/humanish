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
 *
 * 2로 올린 근거(2026-08-04): "봇끼리 떠들기 시작하지 않나"는 워커에서 막혀 있다 —
 * 봇→봇 대꾸는 maybeChain 이 상한(BOT_CHAIN_MAX)을 세고 사람 발화가 와야 풀리며,
 * 자발 발화는 직전 발화가 자기 것이면 차례를 쉰다 (room-do.ts tick ①의 자답 가드).
 * 더 올리기 전에는 라운지에서 봇 발화 밀도를 실측할 것.
 */
export const WORLD_AI_COUNT = 2;

/*
 * 월드 AI 가 연기할 인물은 lib/agent/world-persona.ts 로 이관했다 (페르소나는 B 도메인).
 * "지금은 게임 중이 아니다" 부정문도 함께 사라졌다 — 무대 자체가
 * generate.ts 의 `setting: 'world'` 분기로 깔린다 (world-agent 라우트가 싣는다).
 */

/*
 * ┌─ 월드 AI 에게는 문구 풀이 없다 ───────────────────────────────────────────┐
 * │ 예전에는 여기 WORLD_LINES(18줄: '여기 생각보다 넓네', 'ㅋㅋㅋ', '그러게' …)가  │
 * │ 있었고, LLM 이 늦거나 실패하면 그게 대신 나갔다.                             │
 * │                                                                            │
 * │ 두 번 갈아엎고 내린 결론은 **풀 자체가 문제**라는 것이다. 처음엔 게임 풀       │
 * │ (bot_line_pool.phase='chat')을 썼는데 "그래서 누구 찍을 거야" 같은 말이 라운지 │
 * │ 에서 헛소리가 됐고, 그래서 맥락 없이도 어색하지 않은 문구로 갈아 끼웠다.       │
 * │ 그랬더니 이번엔 그 18줄이 **월드에서 들리는 말의 거의 전부**가 됐다 — 몇 분만  │
 * │ 있어도 같은 문장이 돌아오고, 그 반복이 그대로 봇 표식이었다 (실측 두 번).      │
 * │                                                                            │
 * │ 그래서 없앴다. 월드 AI 의 말은 전부 LLM 에서 온다(app/api/internal/world-agent)│
 * │ 못 받으면 그 자리는 조용히 지나간다 — 서 있는 시간은 그대로라 타이밍으로는     │
 * │ 티가 나지 않는다 (worker/src/bots.ts 의 speechHeld, I1).                     │
 * │                                                                            │
 * │ ★ 여기에 배열을 다시 만들지 않는다. 코드로 된 대비책은 반드시 "제일 자주       │
 * │   들리는 말"이 된다 — LLM 이 흔들릴 때마다 그쪽으로 떨어지기 때문이다.        │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

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

/**
 * 방 id + **자리 번호** → 결정적 uuid. 진짜 players.id 와 모양이 같아야 한다 (머리말 2번 상자).
 * 자리에 묶는 이유: 자리가 바뀌면 id 도 바뀌어야 워커의 명부 diff(id 기준)가
 * player_left + player_joined 로 이동을 방송한다. 순번으로 만들면 자리가 밀릴 때
 * id 가 그대로라 아무 이벤트도 안 나고, 화면에 옛 익명N 이 그대로 남는다.
 */
async function stableUuid(roomId: string, seat: number): Promise<string> {
  const data = new TextEncoder().encode(`${roomId}:world-ai:${seat}`);
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
    /*
     * ┌─ 월드 AI 는 **지금 최대 자리 다음 번호부터** 선다 (2026-08-04 결정) ────────┐
     * │ 예전엔 1번부터 빈 자리를 채웠다. 그런데 DB 의 자리 배정(pick_free_seat)은   │
     * │ 월드 AI 를 모르고 무작위로 고르므로, 사람이 AI 가 서 있던 자리를 받을 수     │
     * │ 있었다. 그러면 AI 가 옆 자리로 밀리는데 id 가 순번 기반이라 그대로였고,      │
     * │ 명부 diff(id 기준)가 아무 이벤트도 못 내서 **같은 익명N 이 화면에 둘** 남았다.│
     * │                                                                            │
     * │ · 아래 빈 번호(나간 사람 자리)는 채우지 않는다 — 거기가 바로 무작위 배정이   │
     * │   고를 수 있는 자리다.                                                      │
     * │ · 그래도 사람이 AI 자리를 받으면(무작위니까 가능하다) 다음 조회에서 AI 가    │
     * │   더 위로 민다. id 를 자리에 묶었으므로(stableUuid) 그 이동은 player_left    │
     * │   + player_joined 로 방송된다 — 조용히 닉네임만 바뀌는 일은 없다.            │
     * │ · 위 번호가 모자라면 AI 는 그만큼 덜 선다. 이 규칙의 대가다.                 │
     * └────────────────────────────────────────────────────────────────────────────┘
     */
    const maxTaken = seats.reduce((m, s) => Math.max(m, s.seat), 0);
    let added = 0;
    for (let seat = maxTaken + 1; seat <= room.capacity && added < WORLD_AI_COUNT; seat += 1) {
      seats.push({
        // 닉네임·가면은 fill_with_bots 와 같은 규칙이다. 다르게 만들면 그게 표식이다.
        id: await stableUuid(roomId, seat),
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
