/**
 * 봇 아바타 조종. 소유: A — **서버에서만 돈다.**
 *
 * ┌─ 왜 서버가 조종하는가 (I1) ────────────────────────────────────────────────┐
 * │ 봇 아바타를 누군가의 브라우저가 대신 움직이면 **그 브라우저는 누가 봇인지 안다.** │
 * │ 호스트 한 명이 정답을 들고 게임하는 셈이라 게임이 성립하지 않는다.             │
 * │ 그래서 조종은 방 DO 안에서만 하고, 밖으로는 사람과 똑같은 player_moved만 나간다. │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 왜 좌표를 "계획"으로 안 보내는가 (I1) ────────────────────────────────────┐
 * │ "A→B로 4초간 이동" 같은 계획 1건으로 보내면 대역폭은 아끼지만, devtools를 열면 │
 * │ 사람(10Hz 샘플 스트림)과 봇(계획 한 줄)이 한눈에 갈린다. SPEC §6.1이 브로드캐스트를 │
 * │ 버린 것과 정확히 같은 이유다. 그래서 봇도 100ms마다 한 샘플씩, 사람과 같은        │
 * │ "변했을 때만 보낸다" 규칙까지 그대로 따른다.                                  │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

import {
  BOT_CHAT_MAX_MS,
  BOT_CHAT_MIN_MS,
  BOT_IDLE_MAX_MS,
  BOT_IDLE_MIN_MS,
  BOT_SPEED_MAX,
  BOT_SPEED_MIN,
  MOVE_THROTTLE_MS,
  WORLD,
} from '../../lib/mp/constants';
import type { AnimState, PlayerSnapshot } from '../../lib/mp/protocol';
import { spawnFor } from '../../lib/mp/spawn';

/** 목적지에 "닿았다"고 볼 거리 (m). 더 작게 잡으면 목표 주변에서 덜덜 떤다. */
const ARRIVE_EPS = 0.25;
/** 회전 속도 (rad/s). 사람이 마우스를 홱 돌리는 것보다 느려야 자연스럽다. */
const TURN_RATE = 3.4;
/** 벽에서 이만큼 떨어진 데까지만 목적지를 잡는다. */
const EDGE_INSET = 1.2;

export interface BotState {
  id: string;
  seat: number;
  nickname: string;
  maskId: string;

  x: number;
  z: number;
  heading: number;
  anim: AnimState;

  /** 현재 목적지 */
  tx: number;
  tz: number;
  /** 이 시각까지는 서 있는다 (epoch ms) */
  waitUntil: number;
  speed: number;

  /** 마지막으로 내보낸 값. 사람의 lastSent와 같은 역할이다 */
  sentX: number;
  sentZ: number;
  sentHeading: number;
  sentAnim: AnimState;
  sentAt: number;

  /** 다음에 한마디 할 시각 (epoch ms) */
  nextChatAt: number;
}

/** 저장·복원용. 좌표만 남기면 충분하다 — 나머지는 다시 뽑아도 티가 안 난다. */
export interface BotPose {
  id: string;
  x: number;
  z: number;
  heading: number;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomPoint(): { x: number; z: number } {
  return {
    x: rand(WORLD.minX + EDGE_INSET, WORLD.maxX - EDGE_INSET),
    z: rand(WORLD.minZ + EDGE_INSET, WORLD.maxZ - EDGE_INSET),
  };
}

// 시작 위치는 lib/mp/spawn.ts 하나로 정한다. 사람(room-do.ts·클라이언트)도 같은 함수를
// 쓴다 — 봇만 다른 자리에서 시작하면 그것부터 표식이 된다 (I1).
export { spawnFor };

export function createBot(
  seed: { id: string; seat: number; nickname: string; maskId: string },
  capacity: number,
  now: number,
  pose?: BotPose,
): BotState {
  const start = pose ?? { ...spawnFor(seed.seat, capacity), heading: 0 };
  const target = randomPoint();
  return {
    ...seed,
    x: start.x,
    z: start.z,
    heading: start.heading,
    anim: 'idle',
    tx: target.x,
    tz: target.z,
    // 전부 동시에 출발하면 그 순간 8명이 똑같이 움직여서 바로 들킨다. 흩뿌린다.
    waitUntil: now + rand(0, BOT_IDLE_MAX_MS),
    speed: rand(BOT_SPEED_MIN, BOT_SPEED_MAX),
    sentX: start.x,
    sentZ: start.z,
    sentHeading: start.heading,
    sentAnim: 'idle',
    sentAt: 0,
    nextChatAt: now + rand(BOT_CHAT_MIN_MS, BOT_CHAT_MAX_MS),
  };
}

/**
 * 한 틱 굴린다. dt는 초 단위.
 *
 * 반환값이 true면 "이번 틱에 내보낼 만큼 변했다"는 뜻이다. 판정 기준은
 * 사람 클라이언트(LocalAvatar)와 **같아야 한다** — 값이 변했고, 마지막 송신에서
 * MOVE_THROTTLE_MS가 지났을 때.
 */
export function stepBot(bot: BotState, now: number, dt: number): boolean {
  if (now < bot.waitUntil) {
    bot.anim = 'idle';
  } else {
    const dx = bot.tx - bot.x;
    const dz = bot.tz - bot.z;
    const dist = Math.hypot(dx, dz);

    if (dist < ARRIVE_EPS) {
      // 도착 — 잠깐 서 있다가 다음 목적지로. 속도도 다시 뽑아 걸음걸이를 바꾼다.
      const next = randomPoint();
      bot.tx = next.x;
      bot.tz = next.z;
      bot.waitUntil = now + rand(BOT_IDLE_MIN_MS, BOT_IDLE_MAX_MS);
      bot.speed = rand(BOT_SPEED_MIN, BOT_SPEED_MAX);
      bot.anim = 'idle';
    } else {
      const step = Math.min(bot.speed * dt, dist);
      bot.x += (dx / dist) * step;
      bot.z += (dz / dist) * step;
      bot.anim = 'walk';

      // 진행 방향으로 서서히 돈다. atan2(dx, dz)는 three.js의 y회전과 축이 맞는다.
      const want = Math.atan2(dx, dz);
      let diff = ((want - bot.heading + Math.PI) % (Math.PI * 2)) - Math.PI;
      if (diff < -Math.PI) diff += Math.PI * 2;
      const maxTurn = TURN_RATE * dt;
      bot.heading += Math.max(-maxTurn, Math.min(maxTurn, diff));
    }
  }

  const changed =
    bot.anim !== bot.sentAnim ||
    Math.abs(bot.x - bot.sentX) > 0.001 ||
    Math.abs(bot.z - bot.sentZ) > 0.001 ||
    Math.abs(bot.heading - bot.sentHeading) > 0.001;

  if (!changed || now - bot.sentAt < MOVE_THROTTLE_MS) return false;

  bot.sentX = bot.x;
  bot.sentZ = bot.z;
  bot.sentHeading = bot.heading;
  bot.sentAnim = bot.anim;
  bot.sentAt = now;
  return true;
}

/**
 * 지금 한마디 할 때인가. true면 다음 시각을 다시 잡아 준다.
 * **사람이 아무도 없으면 부르지 않는다** — 빈 방에서 봇끼리 떠들 이유가 없다.
 */
export function shouldChat(bot: BotState, now: number): boolean {
  if (now < bot.nextChatAt) return false;
  bot.nextChatAt = now + rand(BOT_CHAT_MIN_MS, BOT_CHAT_MAX_MS);
  return true;
}

export function botSnapshot(bot: BotState): PlayerSnapshot {
  return {
    id: bot.id,
    seat: bot.seat,
    nickname: bot.nickname,
    maskId: bot.maskId,
    x: bot.x,
    z: bot.z,
    heading: bot.heading,
    anim: bot.anim,
  };
}

export function toPose(bot: BotState): BotPose {
  return { id: bot.id, x: bot.x, z: bot.z, heading: bot.heading };
}

/**
 * 문구 풀이 비었을 때의 최소 대비책.
 * 실제 풀은 Supabase의 bot_line_pool이고 /api/internal/world-room이 실어 준다.
 * **이 배열이 클라이언트로 가면 안 된다** — 풀과 대조하면 봇이 특정된다.
 */
export const FALLBACK_LINES = [
  '음... 잠깐만',
  '방금 뭐라고 했어?',
  '그건 좀 이상한데',
  '나는 아닌 것 같은데',
  '다들 조용하네',
  '아까부터 저쪽이 수상해',
  '그래서 결론이 뭐야',
  '좀 더 생각해볼게',
];
