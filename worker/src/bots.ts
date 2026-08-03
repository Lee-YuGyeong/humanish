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
  BOT_DISTRACTED_CHANCE,
  BOT_DISTRACTED_MAX_MS,
  BOT_DISTRACTED_MIN_MS,
  BOT_IDLE_MAX_MS,
  BOT_IDLE_MIN_MS,
  BOT_JUMP_MAX_MS,
  BOT_JUMP_MIN_MS,
  BOT_READ_MAX_MS,
  BOT_READ_MIN_MS,
  BOT_REACT_CHANCE,
  BOT_REACT_COOLDOWN_MS,
  COMPANION_REACT_CHANCE,
  COMPANION_REACT_COOLDOWN_MS,
  BOT_SPEED_MAX,
  BOT_SPEED_MIN,
  BOT_TYPE_CHARS_MAX,
  BOT_TYPE_CHARS_MIN,
  GRAVITY,
  JUMP_SPEED,
  MOVE_THROTTLE_MS,
  SPEAK_JITTER_MS,
  WORLD,
} from '../../lib/mp/constants';
import type { AnimState, PlayerSnapshot } from '../../lib/mp/protocol';
import { spawnFor } from '../../lib/mp/spawn';
// 가구는 클라이언트만 아는 게 아니다 — 좌표를 만드는 건 서버라, 서버가 같은 가구를
// 보지 않으면 봇이 소파를 뚫고 지나간다. 데이터·판정은 lib/mp/collide.ts 하나뿐이다.
import { isBlocked, resolveCollisions } from '../../lib/mp/collide';
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

/**
 * 봇은 낮은 탁자에도 올라서지 않는다 (stepUp = 0 — 전부 막는 것으로 본다).
 *
 * 사람은 STEP_UP(0.55) 아래 턱을 걸어서 넘고, 넘는 순간 발 높이가 탁자 윗면으로
 * 올라간다(groundHeightAt). 봇에게 같은 걸 주려면 y 도 같이 올려야 하는데,
 * 빠뜨리면 **탁자를 뚫고 걷는 그림**이 된다 — 지금 고치려는 바로 그 증상이다.
 * 돌아가게 두는 쪽이 안전하고, 봇이 가구에 안 올라가는 건 원래 정한 바다.
 */
const BOT_STEP_UP = 0;

/** 목적지를 고를 때 가구를 피해 다시 뽑는 횟수. 다 실패하면 그냥 마지막 값을 쓴다. */
const TARGET_TRIES = 12;

/**
 * 이만큼 가까워지지 못하면 막힌 것으로 보고 목적지를 다시 잡는다 (ms).
 *
 * 충돌만 넣고 이걸 빠뜨리면 봇이 소파 뒤 목적지를 향해 **소파에 영원히 비빈다.**
 * 사람은 못 가는 데를 계속 밀지 않는다 — 몇 초 해보고 딴 데로 간다.
 */
const STUCK_MS = 2_500;
/** 이만큼은 줄어야 "가까워졌다"고 본다 (m). 잡음으로 진행 판정이 뒤집히지 않게 한다. */
const PROGRESS_EPS = 0.05;

/**
 * 아예 못 움직인 채로 이만큼 지나면 곧장 목적지를 다시 잡는다 (ms).
 *
 * STUCK_MS(2.5초)는 "미끄러지긴 하는데 가까워지지 않는" 경우용이라 여기엔 너무 길다.
 * 가구에 정면으로 눌린 봇이 2.5초 동안 서 있으면 눈에 띈다 — 사람은 부딪히면
 * 반 박자 안에 방향을 튼다.
 */
const BLOCKED_MS = 600;
/** 이 비율보다 적게 갔으면 "못 갔다"로 본다 (이번 틱에 가려던 거리 대비). */
const BLOCKED_RATIO = 0.25;

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
   * 발화 **자리**를 잡아 뒀는가. 할 말이 정해졌는지와 별개다.
   *
   * ┌─ ★ pendingText로 겸하지 않는다 (I1) ──────────────────────────────────────┐
   * │ 하드코딩 문구 풀을 없앤 뒤로, 자리를 잡는 순간에는 할 말이 아직 없다 —      │
   * │ LLM이 도착해야 정해지고 끝내 안 올 수도 있다 (scheduleSpeech 주석).         │
   * │ 그래도 **서서 치는 시간은 똑같이 흘러야 한다.** 둘을 한 필드로 묶으면        │
   * │ LLM을 기다리는 동안만 발이 안 묶이고, 그 차이가 곧 봇 표식이 된다.          │
   * └──────────────────────────────────────────────────────────────────────────┘
   *
   * 예약이 걸린 뒤 typeAt이 지나면 **타이핑 중**이라 걷지도 뛰지도 않는다 (머리말 3번 상자).
   */
  speechHeld: boolean;
  /**
   * 예약된 문구. 저장하지 않는다 — DO가 evict되면 그 한마디는 그냥 사라진다. 무해하다.
   * 자리는 잡혔는데 문구가 안 정해졌으면 null이고, 그러면 그 자리는 조용히 지나간다.
   */
  pendingText: string | null;
  /**
   * 앞 발화를 내보낸 **직후에 이어 칠 한 줄**. 보통 null이다.
   *
   * LLM이 두 줄을 냈을 때 뒷줄이 여기 온다 (app/api/internal/world-agent).
   * 사람은 한 생각을 두 번에 나눠 친다 — 늘 한 줄로 딱 끝나는 자리가 봇이다 (I1).
   *
   * ★ 자리를 따로 잡지 않는다 — takeSpeech가 앞 줄을 내보내면서 그 자리에서
   *   바로 이어 예약한다. 사람도 두 번째 줄은 곧바로 치지, 몇십 초 뒤에 치지 않는다.
   */
  pendingTail: string | null;
  /**
   * 이 시각부터 "친다" — 발이 묶인다.
   * 사람 말에 대한 반응이면 읽는 시간만큼 뒤고, 스스로 말을 꺼내는 거면 예약 즉시다.
   */
  typeAt: number;
  /** 잡아 둔 자리를 내보낼 시각 (epoch ms). speechHeld가 false면 의미 없다. */
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

  /** 목적지까지 남은 거리의 최근 최소값. 안 줄면 가구에 막힌 것이다 */
  bestDist: number;
  /** bestDist 가 마지막으로 갱신된 시각 (epoch ms) */
  progressAt: number;
  /** 마지막으로 실제로 움직인 시각 (epoch ms). 가구에 정면으로 눌렸는지 본다 */
  blockedAt: number;
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

/**
 * 설 수 있는 자리 하나. **가구 안은 피한다** —
 * 가구 안을 목적지로 잡으면 봇이 그 앞에서 영원히 비빈다.
 */
function randomPoint(): { x: number; z: number } {
  let p = { x: 0, z: 0 };
  for (let i = 0; i < TARGET_TRIES; i += 1) {
    p = {
      x: rand(WORLD.minX + EDGE_INSET, WORLD.maxX - EDGE_INSET),
      z: rand(WORLD.minZ + EDGE_INSET, WORLD.maxZ - EDGE_INSET),
    };
    if (!isBlocked(p.x, p.z, 0, BOT_STEP_UP)) return p;
  }
  return p; // 다 막혔다면(있을 수 없다) 그냥 간다 — 아래 막힘 판정이 곧 다시 잡는다
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
  const raw = pose ?? { ...spawnFor(seed.seat, capacity), heading: 0 };
  // 좌석 원(spawnFor)이 가구와 겹칠 수 있고, 저장된 좌표는 가구를 옮기기 전 것일 수 있다.
  // 가구 안에서 시작하면 첫 틱에 튕겨 나가는 게 보인다 — 여기서 미리 밀어낸다.
  const pushed = resolveCollisions(raw.x, raw.z, 0, BOT_STEP_UP);
  // 밀어내도 안 풀리는 쐐기(소파 두 개 사이 구석)일 수 있다. 그러면 빈자리를 새로 뽑는다.
  const free = isBlocked(pushed.x, pushed.z, 0, BOT_STEP_UP) ? randomPoint() : pushed;
  const start = { ...raw, x: free.x, z: free.z };
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
    speechHeld: false,
    pendingText: null,
    pendingTail: null,
    typeAt: 0,
    speakAt: 0,
    speechSeq: 0,
    nextReactAt: 0,
    bestDist: Infinity,
    progressAt: now,
    blockedAt: now,
  };
}

/** 다음 목적지를 잡고 막힘 판정을 초기화한다. */
function retarget(bot: BotState, now: number): void {
  const next = randomPoint();
  bot.tx = next.x;
  bot.tz = next.z;
  bot.bestDist = Infinity;
  bot.progressAt = now;
  bot.blockedAt = now;
}

/**
 * 원하는 방향으로 서서히 돈다. 사람이 마우스를 홱 돌리는 것보다 느려야 자연스럽다.
 * atan2(dx, dz) 는 three.js 의 y회전과 축이 맞는다 (app/world/avatar.tsx 의 정면 축 주석).
 */
function turnToward(bot: BotState, want: number, dt: number): void {
  let diff = ((want - bot.heading + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  const maxTurn = TURN_RATE * dt;
  bot.heading += Math.max(-maxTurn, Math.min(maxTurn, diff));
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
  //   ★ pendingText가 아니라 speechHeld를 본다 — LLM이 끝내 안 와서 할 말이 없어도
  //     서 있는 시간은 똑같아야 한다 (BotState.speechHeld 주석, I1).
  const typing = bot.speechHeld && now >= bot.typeAt;

  // ★ 걷으려 하지 않는 동안에는 막힘 시계를 멈춘다. 안 그러면 말하려고 서 있던 3초가
  //   "못 갔다"로 세어져서, 말이 끝나자마자 가던 목적지를 잊고 방향을 튼다.
  //   막힘 판정은 **걸으려고 애쓴 시간**만 재야 한다.
  if (typing || now < bot.waitUntil) {
    bot.anim = 'idle';
    bot.progressAt = now;
    bot.blockedAt = now;
  } else {
    const dx = bot.tx - bot.x;
    const dz = bot.tz - bot.z;
    const dist = Math.hypot(dx, dz);

    if (dist < ARRIVE_EPS) {
      // 도착 — 잠깐 서 있다가 다음 목적지로. 속도도 다시 뽑아 걸음걸이를 바꾼다.
      retarget(bot, now);
      bot.waitUntil = now + rand(BOT_IDLE_MIN_MS, BOT_IDLE_MAX_MS);
      bot.speed = rand(BOT_SPEED_MIN, BOT_SPEED_MAX);
      bot.anim = 'idle';
    } else if (dist >= bot.bestDist - PROGRESS_EPS && now - bot.progressAt > STUCK_MS) {
      // 몇 초째 가까워지지 못했다 = 가구에 막혔다. 사람은 못 가는 데를 계속 밀지 않는다.
      retarget(bot, now);
      bot.anim = 'idle';
    } else {
      if (dist < bot.bestDist - PROGRESS_EPS) {
        bot.bestDist = dist;
        bot.progressAt = now;
      }

      const step = Math.min(bot.speed * dt, dist);
      const fromX = bot.x;
      const fromZ = bot.z;

      // 가구에 막히면 밀려난다 — 벽을 따라 미끄러지는 느낌이 난다.
      // ★ 사람(LocalRig)과 **같은 함수**를 쓴다. 여기만 다르면 봇이 가구를 뚫는다.
      // ★ 발 높이를 bot.y 가 아니라 **0으로 고정해서** 본다. 점프 중(y>0)에 판정을
      //   풀면 봇이 소파를 뛰어넘고 그 안에 착지한다 — 봇의 착지 높이는 항상 0이라
      //   가구 안에 서 있게 된다. 뛰어도 가구는 못 넘는 편이 낫다.
      const moved = resolveCollisions(
        bot.x + (dx / dist) * step,
        bot.z + (dz / dist) * step,
        0,
        BOT_STEP_UP,
      );
      // ★ 밀어냈는데도 아직 가구 안이면 **그 자리로 가지 않는다.**
      //   소파 두 개가 ㄱ 자로 놓인 구석처럼, A 에서 밀면 B 안이고 B 에서 밀면 A 안인
      //   쐐기가 있다. 거기는 몇 번을 밀어도 안 풀린다 — 들어가지 않는 게 유일한 답이다.
      if (!isBlocked(moved.x, moved.z, 0, BOT_STEP_UP)) {
        bot.x = moved.x;
        bot.z = moved.z;
      }

      const mx = bot.x - fromX;
      const mz = bot.z - fromZ;

      if (Math.hypot(mx, mz) < step * BLOCKED_RATIO) {
        // 가구에 정면으로 눌려 거의 못 갔다.
        // ★ 여기서 'walk' 를 유지하면 **제자리걸음**이 된다 — 화면에서 제일 이상해
        //   보이는 게 그거다. 사람도 부딪히면 멈추고 방향을 튼다.
        bot.anim = 'idle';
        if (now - bot.blockedAt > BLOCKED_MS) retarget(bot, now);
      } else {
        bot.blockedAt = now;
        bot.anim = 'walk';
        // ★ 목적지가 아니라 **실제로 간 방향**으로 돈다. 가구를 따라 미끄러지는 동안
        //   목적지를 보고 있으면 옆걸음·뒷걸음처럼 보인다. 사람은 가는 쪽을 본다.
        turnToward(bot, Math.atan2(mx, mz), dt);
      }
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
 * 지금 한마디 할 때인가. 시각이 됐으면 **막히든 말든** 다음 시각을 다시 잡아 준다.
 * **사람이 아무도 없으면 부르지 않는다** — 빈 방에서 봇끼리 떠들 이유가 없다.
 *
 * 이미 예약이 걸려 있으면(= 타이핑 중) false다. 사람도 한 번에 한 줄만 친다.
 *
 * ┌─ mayInitiate — 왜 "마지막 발화가 내 것이면" 막는가 ────────────────────────┐
 * │ 이 자리는 25~75초마다 한 번씩 무조건 말을 꺼냈다. 사람이 조용하면 그 사이       │
 * │ 대화 기록은 **제 발화로만 채워지고**, 그러면 LLM 은 trigger 없는 chat 분기      │
 * │ ("대화 흐름에 자연스럽게 끼어들어라")를 타면서 **자기가 방금 한 말에 대꾸한다.**  │
 * │ 사용자가 본 게 정확히 그거다 — 혼자 떠들고 혼자 대답하는 아바타.               │
 * │                                                                            │
 * │ 그래서 규칙을 하나 건다: **누가 말을 받아 주기 전에는 두 번 연달아 말하지 않는다.** │
 * │ 사람도 그렇게 한다. 첫 한마디(기록이 빈 방)는 허용한다 — 말을 걸어 보는 건       │
 * │ 자연스럽고, 그 뒤로는 상대가 답해야 이어진다.                                 │
 * │                                                                            │
 * │ 막힐 때도 nextChatAt 은 앞으로 민다. 안 그러면 몇 분 밀린 타이머가 사람이 입을   │
 * │ 여는 순간 터져서, 대꾸(reactToHuman)와 혼잣말이 겹쳐 두 줄이 한꺼번에 나간다.   │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
export function shouldChat(bot: BotState, now: number, mayInitiate: boolean): boolean {
  if (bot.speechHeld) return false;
  if (now < bot.nextChatAt) return false;
  bot.nextChatAt = now + rand(BOT_CHAT_MIN_MS, BOT_CHAT_MAX_MS);
  return mayInitiate;
}

/**
 * 발화 **자리**를 예약한다. readDelay가 지나면 봇은 서서 "친다" — stepBot이 발을 묶는다.
 * 스스로 말을 꺼낼 때는 readDelay가 0이고, 사람 말에 대한 반응일 때만 읽는 시간이 붙는다.
 *
 * ★ 이 함수가 정한 speakAt은 **나중에 바뀌지 않는다.** LLM 답이 오면 pendingText만
 *   갈아끼우고 시각은 그대로 둔다 — 발화 타이밍 분포가 LLM 성공/실패와 무관해야
 *   자리 단위 봇 신호가 안 된다 (lib/agent/chat-reply.ts가 visible_at을 건드리지
 *   않는 것과 같은 규칙, I1).
 *
 * ┌─ text가 null일 수 있다 — 그게 기본이다 ───────────────────────────────────┐
 * │ 예전에는 하드코딩 문구 풀에서 한 줄 뽑아 미리 채웠고, LLM이 늦으면 그 문구가  │
 * │ 그대로 나갔다. 실제로 월드에서 들리는 말이 거의 전부 그 목록이었다 —          │
 * │ 맥락 없는 같은 말이 돌아서 그 자체가 봇 티였다. 풀을 통째로 없앴다.           │
 * │                                                                            │
 * │ 그래서 지금은 **자리만 잡고 문구는 비워 둔다.** LLM이 speakAt 전에 오면 그    │
 * │ 말을 하고, 안 오면 잠깐 서 있다 그냥 간다 (takeSpeech가 null을 돌려준다).     │
 * │ 서 있는 시간은 어느 쪽이든 같다 — 그게 speechHeld를 따로 둔 이유다.          │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
export function scheduleSpeech(
  bot: BotState,
  /** 미리 정해진 문구. 월드에서는 보통 null이고 LLM이 replaceSpeech로 채운다. */
  text: string | null,
  now: number,
  readDelayMs = 0,
): void {
  bot.speechHeld = true;
  bot.pendingText = text;
  bot.pendingTail = null;
  bot.typeAt = now + readDelayMs;
  // ★ 지연은 **text 길이와 무관하다** (BOT_TYPE_CHARS_* 주석 참고). 그 문구는 LLM 이
  //   제때 오면 통째로 갈아치워지므로, 그 길이로 타이밍을 정하면 아무도 못 볼 문장이
  //   타이밍을 정하는 셈이고 LLM 답 길이까지 옥죈다.
  //   typingDelayMs 를 그대로 쓰려고 같은 길이의 더미를 넘긴다 — 공식을 복사하지 않는다.
  const chars = Math.round(rand(BOT_TYPE_CHARS_MIN, BOT_TYPE_CHARS_MAX));
  bot.speakAt =
    bot.typeAt + typingDelayMs('x'.repeat(chars)) + Math.floor(Math.random() * SPEAK_JITTER_MS);
  bot.speechSeq += 1;
}

/**
 * 뒷줄을 **앞 줄 바로 뒤에** 잇는다. takeSpeech가 내부에서만 부른다.
 *
 * ★ 여기서는 typingDelayMs에 **진짜 문구**를 넘긴다. 위(scheduleSpeech)가 더미를
 *   넘기는 건 그 문구가 나중에 LLM으로 갈아치워지기 때문인데, 뒷줄은 이미 정해졌고
 *   바뀌지 않는다 — 길이가 새어 나갈 데가 없다. 짧으면 1초 남짓이라 앞 줄을 치고
 *   곧바로 한 줄 더 치는 모양이 된다.
 */
function scheduleTail(bot: BotState, text: string, now: number): void {
  bot.speechHeld = true;
  bot.pendingText = text;
  bot.pendingTail = null;
  bot.typeAt = now;
  bot.speakAt = now + typingDelayMs(text) + Math.floor(Math.random() * SPEAK_JITTER_MS);
  // ★ seq를 올린다 — 이 자리를 노리던 LLM 응답이 정정 줄을 덮어쓰면 안 된다.
  bot.speechSeq += 1;
}

/**
 * 잡아 둔 자리에 문구를 채운다. LLM 반응이 제때 왔을 때 부른다 (room-do.ts의 upgradeSpeech).
 *
 * ★ typeAt·speakAt을 **건드리지 않는다.** 발화 타이밍 분포가 LLM 성공/실패와 무관해야
 *   자리 단위 봇 신호가 안 된다 (lib/agent/chat-reply.ts가 visible_at을 건드리지 않는
 *   것과 같은 규칙, I1). 실패·지연이면 자리가 빈 채로 지나갈 뿐 타이밍은 그대로다.
 *
 * 거절하는 세 경우: 다음 발화가 이미 예약됐다(seq 불일치) · 자리가 이미 지나갔다 ·
 * 나갈 시각이 지났다. false면 그 답은 버려지고 봇은 이번엔 아무 말도 하지 않는다.
 */
export function replaceSpeech(
  bot: BotState,
  seq: number,
  text: string,
  now: number,
  /** 이 발화 뒤에 이어 칠 한 줄. 없으면 null (보통 null이다). */
  tail: string | null = null,
): boolean {
  if (bot.speechSeq !== seq) return false;
  if (!bot.speechHeld) return false;
  if (now >= bot.speakAt) return false;
  bot.pendingText = text;
  bot.pendingTail = tail;
  return true;
}

/**
 * 잡아 둔 자리를 꺼낸다. 아직 치는 중이거나 잡아 둔 자리가 없으면 null.
 *
 * ★ 시각이 됐는데 문구가 안 채워졌어도 **자리는 놓아준다** — 그래야 봇이 다시 걷고
 *   다음 발화를 예약할 수 있다. 이때도 null이라 호출부는 아무것도 내보내지 않는다.
 */
export function takeSpeech(bot: BotState, now: number): string | null {
  if (!bot.speechHeld || now < bot.speakAt) return null;
  const text = bot.pendingText;
  const tail = bot.pendingTail;
  bot.speechHeld = false;
  bot.pendingText = null;
  bot.pendingTail = null;

  // 뒷줄이 걸려 있으면 그 자리에서 바로 이어 예약한다.
  // ★ 앞 줄이 실제로 나갔을 때만이다 — 자리가 빈 채 지나갔는데(text가 null) 뒷줄만
  //   나가면 앞뒤 없는 한마디가 뜬금없이 떠 있게 된다.
  if (text !== null && tail !== null) scheduleTail(bot, tail, now);

  return text;
}

/**
 * 사람 말을 읽고 답을 치기 시작할 때까지. scheduleSpeech의 readDelay로 넘긴다.
 *
 * ┌─ 가끔은 한참 뒤에 답한다 (I1 — BOT_DISTRACTED_* 주석) ────────────────────┐
 * │ 읽는 시간이 늘 1.2~4초면 **분포가 너무 좁다.** 사람은 폰을 보다 말고, 딴 데   │
 * │ 보다가, 한참 뒤에 "ㅇㅇ" 한 줄을 던진다. 늦는 판이 아예 없는 자리는 세어 보면 │
 * │ 드러난다.                                                                  │
 * │                                                                            │
 * │ ★ 왜 여기지 scheduleSpeech가 아닌가: 이 값은 **치기 시작하기 전** 시간이라   │
 * │   그동안 봇이 평소처럼 걷는다. 치는 시간(typeAt→speakAt) 쪽에 더하면 그만큼   │
 * │   얼어붙은 채 서 있게 되고, 그건 정반대로 눈에 띈다.                         │
 * │   스스로 꺼내는 말(readDelay=0)에는 안 붙는다 — 말하기로 정하고 딴짓하다      │
 * │   치는 건 "늦게 답하는" 것과 다르고, 그쪽은 애초에 25~75초 간격이 넓다.       │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
export function readDelayMs(): number {
  const base = rand(BOT_READ_MIN_MS, BOT_READ_MAX_MS);
  if (Math.random() >= BOT_DISTRACTED_CHANCE) return base;
  return base + rand(BOT_DISTRACTED_MIN_MS, BOT_DISTRACTED_MAX_MS);
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
 * ★ **말한 당사자를 빼는 건 호출부의 몫이다.** 여기 온 배열에서 고를 뿐이라,
 *   봇 발화에 대꾸를 붙일 때 말한 봇을 안 걸러내면 자기 말에 자기가 답한다
 *   (room-do.ts의 maybeChain). 봇→봇 연쇄를 몇 번까지 허용할지도 거기서 센다 —
 *   이 함수는 한 번의 선택만 안다.
 */
export function pickResponder(
  bots: BotState[],
  now: number,
  /** 게임이 안 돌아가는 방(월드 AI만 있는 방)이면 훨씬 잘 대꾸한다 — 숨길 게 없다. */
  companionMode = false,
  /**
   * 반응 확률을 갈아끼운다. 사람 발화가 아닌 자리(봇 발화·입퇴장)를 위한 것이다 —
   * 여기서 안 받으면 호출부가 주사위를 한 번 더 굴리게 되고, 그러면 실제 확률이
   * 두 값의 곱이 돼서 상수만 봐서는 알 수 없어진다.
   */
  chanceOverride?: number,
): BotState | null {
  const chance = chanceOverride ?? (companionMode ? COMPANION_REACT_CHANCE : BOT_REACT_CHANCE);
  const cooldown = companionMode ? COMPANION_REACT_COOLDOWN_MS : BOT_REACT_COOLDOWN_MS;

  const eligible = bots.filter((b) => !b.speechHeld && now >= b.nextReactAt);
  if (eligible.length === 0) return null;
  if (Math.random() >= chance) return null;

  const bot = eligible[Math.floor(Math.random() * eligible.length)];
  bot.nextReactAt = now + cooldown;
  // 방금 대꾸한 자리가 몇 초 뒤 혼잣말까지 하면 그 자리만 유난히 말이 많아진다.
  bot.nextChatAt = Math.max(bot.nextChatAt, now + BOT_CHAT_MIN_MS);
  return bot;
}

/**
 * 문구 풀에서 한 줄 고른다. **최근에 나온 줄은 피한다.**
 * 풀이 80줄 남짓이라 그냥 뽑으면 같은 말이 금방 또 나오고, 토씨까지 같은 반복은
 * 사람이 하지 않는다 — 그것부터 봇 티다. 전부 최근이면 어쩔 수 없이 아무거나 뽑는다.
 *
 * ★ 풀이 비면 null이다. 그게 월드의 기본 상태다 — 하드코딩 문구를 없앤 뒤로 로비
 *   방에는 미리 채울 말이 없고, LLM이 채우지 못하면 그 자리는 조용히 지나간다
 *   (scheduleSpeech 주석). 게임이 도는 방만 DB의 bot_line_pool을 받아 온다.
 */
export function pickLine(lines: readonly string[], recent: readonly string[]): string | null {
  const fresh = lines.filter((l) => !recent.includes(l));
  const pool = fresh.length > 0 ? fresh : lines;
  if (pool.length === 0) return null;
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

/*
 * 예전에 여기 FALLBACK_LINES(8줄)가 있었다. 방 메타를 못 받았을 때의 "최소 대비책"이었는데,
 * 실제로는 그게 월드에서 제일 자주 들리는 말이 됐다 — 맥락 없는 같은 문장이 돌아서
 * 그 자체가 봇 티였다. 되살리지 않는다. 할 말이 없으면 말하지 않는 쪽이 낫다
 * (scheduleSpeech 주석의 상자).
 */
