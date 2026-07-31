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
 *
 * ┌─ 왜 말하기 전에 서 있는가 (I1) ───────────────────────────────────────────┐
 * │ 사람은 Enter를 누른 순간 composing이 되고 keys가 비워져 **발이 묶인다**       │
 * │ (app/world/world-scene.tsx의 `if (composing) keys.current = {}`).          │
 * │ 즉 사람의 말풍선은 **항상 멈춰 선 아바타 위에** 뜬다. 말풍선은 3D에 뜨므로   │
 * │ 봇만 걸어가면서 말하면 그 자리가 눈으로 갈린다.                             │
 * │                                                                          │
 * │ 그래서 발화는 두 걸음이다: scheduleSpeech로 **예약**하고 → 그동안 서 있다가  │
 * │ → takeSpeech로 꺼내 말한다. 서 있는 시간은 사람의 타이핑 시간과 같은 곡선을  │
 * │ 쓴다. 시야(heading)는 사람도 포커스 중에 계속 돌지만, 지금은 목적지 추적을    │
 * │ 통째로 멈추므로 heading도 같이 멈춘다 — 키보드에 손이 간 사람과 같다.        │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

import {
  BOT_CHAT_MAX_MS,
  BOT_CHAT_MIN_MS,
  BOT_IDLE_MAX_MS,
  BOT_IDLE_MIN_MS,
  BOT_JUMP_MAX_MS,
  BOT_JUMP_MIN_MS,
  BOT_READ_MAX_MS,
  BOT_READ_MIN_MS,
  BOT_REACT_CHANCE,
  BOT_REACT_COOLDOWN_MS,
  BOT_SPEED_MAX,
  BOT_SPEED_MIN,
  GRAVITY,
  JUMP_SPEED,
  MOVE_THROTTLE_MS,
  SPEAK_JITTER_MS,
  WORLD,
} from '../../lib/mp/constants';
import type { AnimState, PlayerSnapshot } from '../../lib/mp/protocol';
import { spawnFor } from '../../lib/mp/spawn';
// 타이핑 지연은 2D 게임과 **같은 곡선**을 쓴다 (lib/agent/disguise.ts — 소유 B).
// 재는 대상이 같기 때문이다: "사람이 이 길이의 한국어를 치는 데 걸리는 시간".
// 여기 복사해 두면 그 순간 두 벌이 되고, 한쪽만 손보면 월드에서만 티가 나기 시작한다.
// 그 파일은 의존성이 하나도 없어서 워커 번들에 그대로 들어간다 (worker/tsconfig.json).
import { typingDelayMs } from '../../lib/agent/disguise';

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
  /** 발 높이. 봇은 바닥에서만 뛴다(가구에 올라서지 않는다) */
  y: number;
  /** 수직 속도 (m/s). y > 0 인 동안에만 의미가 있다 */
  vy: number;
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
  sentY: number;
  sentHeading: number;
  sentAnim: AnimState;
  sentAt: number;

  /** 다음에 한 번 뛸 시각 (epoch ms) */
  nextJumpAt: number;

  /** 다음에 한마디 할 시각 (epoch ms) */
  nextChatAt: number;

  /**
   * 예약된 발화. 저장하지 않는다 — DO가 evict되면 그 한마디는 그냥 사라진다. 무해하다.
   * 예약이 걸린 뒤 typeAt이 지나면 **타이핑 중**이라 걷지도 뛰지도 않는다 (머리말 3번 상자).
   */
  pendingText: string | null;
  /**
   * 이 시각부터 "친다" — 발이 묶인다.
   * 사람 말에 대한 반응이면 읽는 시간만큼 뒤고, 스스로 말을 꺼내는 거면 예약 즉시다.
   */
  typeAt: number;
  /** pendingText를 내보낼 시각 (epoch ms). pendingText가 null이면 의미 없다. */
  speakAt: number;
  /**
   * 예약 일련번호. scheduleSpeech마다 1 오른다.
   *
   * LLM 덮어쓰기가 **자기가 부탁했던 그 발화**에만 닿게 하는 열쇠다. 응답을 기다리는
   * 사이에 그 발화가 이미 나가고 다음 예약이 걸렸다면, 번호가 달라 조용히 버려진다 —
   * 안 그러면 지난 대화에 대한 답이 엉뚱한 말에 얹힌다.
   */
  speechSeq: number;

  /** 이 시각 전에는 사람 말에 반응하지 않는다 (epoch ms). 한 자리가 대화를 독점하지 않게 한다. */
  nextReactAt: number;
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
    y: 0,
    vy: 0,
    heading: start.heading,
    anim: 'idle',
    tx: target.x,
    tz: target.z,
    // 전부 동시에 출발하면 그 순간 8명이 똑같이 움직여서 바로 들킨다. 흩뿌린다.
    waitUntil: now + rand(0, BOT_IDLE_MAX_MS),
    speed: rand(BOT_SPEED_MIN, BOT_SPEED_MAX),
    sentX: start.x,
    sentZ: start.z,
    sentY: 0,
    sentHeading: start.heading,
    sentAnim: 'idle',
    sentAt: 0,
    nextChatAt: now + rand(BOT_CHAT_MIN_MS, BOT_CHAT_MAX_MS),
    // 첫 점프도 흩뿌린다. 안 그러면 봇 셋이 같은 초에 같이 뛴다
    nextJumpAt: now + rand(BOT_JUMP_MIN_MS, BOT_JUMP_MAX_MS),
    pendingText: null,
    typeAt: 0,
    speakAt: 0,
    speechSeq: 0,
    nextReactAt: 0,
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
  // ★ 타이핑 중에는 발이 묶인다 (I1 — 머리말 3번 상자). 목적지 추적을 건너뛰므로
  //   waitUntil·tx·tz는 그대로 남고, 말하고 나면 가던 길을 이어서 간다.
  //   예약이 걸려도 typeAt 전(= 읽는 중)에는 평소처럼 걷는다.
  const typing = bot.pendingText !== null && now >= bot.typeAt;

  if (typing) {
    bot.anim = 'idle';
  } else if (now < bot.waitUntil) {
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

  // 타이핑 중이면 새로 뛰지 않는다 — 사람도 Space가 입력줄로 먹힌다. 이미 공중이었다면
  // 착지까지는 물리를 굴린다(사람도 뛰던 중에 Enter를 칠 수 있다).
  stepJump(bot, now, dt, !typing);

  const changed =
    bot.anim !== bot.sentAnim ||
    Math.abs(bot.x - bot.sentX) > 0.001 ||
    Math.abs(bot.z - bot.sentZ) > 0.001 ||
    Math.abs(bot.y - bot.sentY) > 0.001 ||
    Math.abs(bot.heading - bot.sentHeading) > 0.001;

  if (!changed || now - bot.sentAt < MOVE_THROTTLE_MS) return false;

  bot.sentX = bot.x;
  bot.sentZ = bot.z;
  bot.sentY = bot.y;
  bot.sentHeading = bot.heading;
  bot.sentAnim = bot.anim;
  bot.sentAt = now;
  return true;
}

/**
 * 점프 한 틱. 사람 클라이언트(LocalRig)와 **같은 상수·같은 적분**을 쓴다 —
 * 중력이 다르면 체공 시간이 달라지고, 그 차이가 곧 봇 표식이 된다 (I1).
 *
 * 봇은 걷는 중에도 뛴다(사람도 그렇다). 대신 가구 위에는 올라서지 않으므로
 * 착지 높이는 항상 0이다.
 *
 * allowNew가 false면 **새로 뛰지만 않는다** — 공중이었으면 착지까지 굴린다.
 * 타이핑 중에 공중에서 얼어붙으면 그게 곧 봇 표식이다 (I1).
 */
function stepJump(bot: BotState, now: number, dt: number, allowNew: boolean): void {
  if (bot.y <= 0 && bot.vy === 0) {
    if (!allowNew || now < bot.nextJumpAt) return;
    bot.nextJumpAt = now + rand(BOT_JUMP_MIN_MS, BOT_JUMP_MAX_MS);
    bot.vy = JUMP_SPEED;
  }

  bot.vy -= GRAVITY * dt;
  bot.y += bot.vy * dt;

  if (bot.y <= 0) {
    bot.y = 0;
    bot.vy = 0;
  }
}

/**
 * 지금 한마디 할 때인가. true면 다음 시각을 다시 잡아 준다.
 * **사람이 아무도 없으면 부르지 않는다** — 빈 방에서 봇끼리 떠들 이유가 없다.
 *
 * 이미 예약이 걸려 있으면(= 타이핑 중) false다. 사람도 한 번에 한 줄만 친다.
 */
export function shouldChat(bot: BotState, now: number): boolean {
  if (bot.pendingText !== null) return false;
  if (now < bot.nextChatAt) return false;
  bot.nextChatAt = now + rand(BOT_CHAT_MIN_MS, BOT_CHAT_MAX_MS);
  return true;
}

/**
 * 발화를 예약한다. readDelay가 지나면 봇은 서서 "친다" — stepBot이 발을 묶는다.
 * 스스로 말을 꺼낼 때는 readDelay가 0이고, 사람 말에 대한 반응일 때만 읽는 시간이 붙는다.
 *
 * ★ 이 함수가 정한 speakAt은 **나중에 바뀌지 않는다.** 3단계에서 LLM이 붙으면
 *   pendingText만 갈아끼우고 시각은 그대로 둔다 — 발화 타이밍 분포가 LLM 성공/실패와
 *   무관해야 자리 단위 봇 신호가 안 된다 (lib/agent/chat-reply.ts가 visible_at을
 *   건드리지 않는 것과 같은 규칙, I1).
 */
export function scheduleSpeech(
  bot: BotState,
  text: string,
  now: number,
  readDelayMs = 0,
): void {
  bot.pendingText = text;
  bot.typeAt = now + readDelayMs;
  bot.speakAt = bot.typeAt + typingDelayMs(text) + Math.floor(Math.random() * SPEAK_JITTER_MS);
  bot.speechSeq += 1;
}

/**
 * 예약된 문구만 갈아끼운다. LLM 반응이 제때 왔을 때 부른다 (room-do.ts의 upgradeSpeech).
 *
 * ★ typeAt·speakAt을 **건드리지 않는다.** 발화 타이밍 분포가 LLM 성공/실패와 무관해야
 *   자리 단위 봇 신호가 안 된다 (lib/agent/chat-reply.ts가 visible_at을 건드리지 않는
 *   것과 같은 규칙, I1). 그래서 실패·지연이면 예약된 풀 문구가 그대로 나간다 —
 *   폴백이 구조적으로 공짜다.
 *
 * 거절하는 세 경우: 다음 발화가 이미 예약됐다(seq 불일치) · 이미 말했다 · 나갈 시각이
 * 지났다. false를 돌려주지만 호출부가 할 일은 없다 — 풀 문구가 그대로 간다.
 */
export function replaceSpeech(
  bot: BotState,
  seq: number,
  text: string,
  now: number,
): boolean {
  if (bot.speechSeq !== seq) return false;
  if (bot.pendingText === null) return false;
  if (now >= bot.speakAt) return false;
  bot.pendingText = text;
  return true;
}

/** 예약된 발화를 꺼낸다. 아직 치는 중이거나 예약이 없으면 null. */
export function takeSpeech(bot: BotState, now: number): string | null {
  if (bot.pendingText === null || now < bot.speakAt) return null;
  const text = bot.pendingText;
  bot.pendingText = null;
  return text;
}

/** 사람 말을 읽는 데 걸리는 시간. scheduleSpeech의 readDelay로 넘긴다. */
export function readDelayMs(): number {
  return rand(BOT_READ_MIN_MS, BOT_READ_MAX_MS);
}

/**
 * 사람이 한마디 했다. 대꾸할 봇을 **하나만** 고른다. 아무도 안 고를 수도 있다.
 *
 * ★ I1이 두 번 걸리는 자리다 (BOT_REACT_CHANCE 주석 참고).
 *   · 둘 이상이 같은 말에 반응하면 그 둘이 한 번에 묶인다 → 하나만 고른다.
 *   · 항상 반응하면 그 자리가 봇이다 → 확률과 쿨다운을 건다.
 *
 * 고른 봇에는 쿨다운을 걸고 자발 발화 시각도 미룬다 — 방금 대꾸한 봇이 몇 초 뒤에
 * 혼잣말까지 하면 그 자리만 유난히 말이 많아진다.
 *
 * **봇의 말에는 반응하지 않는다.** 호출부가 사람 소켓의 채팅에서만 부르므로
 * 구조적으로 지켜진다 — 봇끼리 주고받기 시작하면 끝없이 돈다.
 */
export function pickResponder(bots: BotState[], now: number): BotState | null {
  const eligible = bots.filter((b) => b.pendingText === null && now >= b.nextReactAt);
  if (eligible.length === 0) return null;
  if (Math.random() >= BOT_REACT_CHANCE) return null;

  const bot = eligible[Math.floor(Math.random() * eligible.length)];
  bot.nextReactAt = now + BOT_REACT_COOLDOWN_MS;
  bot.nextChatAt = Math.max(bot.nextChatAt, now + BOT_CHAT_MIN_MS);
  return bot;
}

/**
 * 문구 풀에서 한 줄 고른다. **최근에 나온 줄은 피한다.**
 * 풀이 80줄 남짓이라 그냥 뽑으면 같은 말이 금방 또 나오고, 토씨까지 같은 반복은
 * 사람이 하지 않는다 — 그것부터 봇 티다. 전부 최근이면 어쩔 수 없이 아무거나 뽑는다.
 */
export function pickLine(lines: readonly string[], recent: readonly string[]): string {
  const fresh = lines.filter((l) => !recent.includes(l));
  const pool = fresh.length > 0 ? fresh : lines;
  return pool[Math.floor(Math.random() * pool.length)];
}

export function botSnapshot(bot: BotState): PlayerSnapshot {
  return {
    id: bot.id,
    seat: bot.seat,
    nickname: bot.nickname,
    maskId: bot.maskId,
    x: bot.x,
    z: bot.z,
    y: bot.y,
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
