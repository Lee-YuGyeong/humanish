/**
 * 봇 조종 — 발화 예약과 "타이핑 중 정지". 소유: A
 *
 * worker/src 는 원래 `npm test` 대상이 아니었다(워커 타입 검사는 별도 tsconfig 다).
 * 그런데 발화 예약이 들어오면서 봇 조종이 **순수 상태 기계**가 됐고, 여기서 깨지면
 * 증상이 "가끔 봇이 걸어가면서 말한다"라 브라우저로는 거의 안 잡힌다. 그래서 넣는다.
 *
 * bots.ts 는 lib/mp 와 lib/agent/disguise 만 import 하므로(워커 전역 타입 없음)
 * node 환경에서 그대로 돌아간다.
 */

import { describe, expect, it } from 'vitest';

import {
  createBot,
  hasContent,
  pickLine,
  pickResponder,
  primeForTopic,
  readDelayMs,
  replaceSpeech,
  scheduleArrivedSpeech,
  scheduleInstantSpeech,
  scheduleSpeech,
  shouldChat,
  stepBot,
  takeSpeech,
  type BotState,
} from '../../worker/src/bots';
import {
  BOT_DISTRACTED_MAX_MS,
  BOT_READ_MAX_MS,
  BOT_READ_MIN_MS,
  BOT_REACT_CHANCE,
  BOT_REACT_COOLDOWN_MS,
  BOT_TYPE_CHARS_MAX,
  BOT_TYPE_CHARS_MIN,
  LOUNGE_TYPE_MAX_MS,
  MOVE_THROTTLE_MS,
  RUN_SPEED,
  SPEAK_JITTER_MS,
  WALK_SPEED,
} from '../../lib/mp/constants';
import { COLLIDERS, STEP_UP, groundHeightAt, isBlocked } from '../../lib/mp/collide';
import { typingDelayMs } from '../../lib/agent/disguise';

const SEED = { id: 'bot-1', seat: 2, nickname: '익명2', maskId: 'mask-02' };

/**
 * 서 있는 시간·목적지를 못 박은 봇. createBot 은 랜덤을 쓰므로 뒤에서 덮어쓴다.
 *
 * ★ z = -11 인 통로를 쓴다. **가구가 없는 줄이라야 한다** — 원래 (0,0) 에서
 *   출발했는데 거기는 식탁의 밀어내기 범위 안이라, 충돌이 들어오자 첫 틱에
 *   옆으로 밀려 좌표 검사가 깨졌다.
 */
const LANE_Z = -11;

function walkingBot(now: number): BotState {
  const bot = createBot(SEED, 5, now, { id: SEED.id, x: -6, z: LANE_Z, heading: 0 });
  bot.waitUntil = 0; // 바로 걷는다
  bot.tx = 8; // 한참 먼 목적지 — 테스트 동안 도착하지 않는다
  bot.tz = LANE_Z;
  // ★ 걸음걸이를 못 박는다. createBot 은 BOT_RUN_CHANCE 로 달리기를 뽑을 수 있고,
  //   그러면 anim 이 'run' 이라 아래 검사들이 22% 확률로 깨진다. 이 픽스처가 보려는
  //   것은 걸음걸이가 아니라 **발이 묶이는가**다 — 달리기는 따로 검사한다.
  bot.running = false;
  bot.speed = 2;
  return bot;
}

/** 걷든 뛰든 "이동 중"인가. 봇 anim 에 'run' 이 생긴 뒤로 둘을 같이 봐야 한다. */
function isMoving(bot: BotState): boolean {
  return bot.anim === 'walk' || bot.anim === 'run';
}

/** dt=0.1 로 n 틱 굴린다. 실제 BOT_TICK_MS 와 같은 간격이다. */
function run(bot: BotState, from: number, ticks: number): number {
  let now = from;
  for (let i = 0; i < ticks; i += 1) {
    now += MOVE_THROTTLE_MS;
    stepBot(bot, now, MOVE_THROTTLE_MS / 1000);
  }
  return now;
}

describe('가구 충돌', () => {
  /** 회전 없는 소파 — 이 위를 정면으로 가로지르게 시켜 본다. */
  const SOFA = COLLIDERS.find((c) => c.rot === 0 && c.top === 0.99)!;

  /**
   * 이 스위트는 **수평 충돌만** 본다. 점프를 봉인한다.
   *
   * ┌─ ★ 왜 필요해졌나 (2026-08-07) ────────────────────────────────────────────┐
   * │ BOT_JUMP_MIN_MS 를 20초 → 10초로 당기자 이 검사들이 25% 확률로 깨졌다.     │
   * │ 검사가 20~30초를 굴리는데 그 사이 봇이 뛰어서 **소파를 넘어 들어가** 버린   │
   * │ 것이다. 소파 윗면(0.99)은 점프 최고점(≈1.05)보다 낮으니 넘는 것 자체는      │
   * │ 의도된 동작이다 — 사람도 그렇게 가구 위에 올라선다 (JUMP_SPEED 의 상자).    │
   * │                                                                          │
   * │ 즉 깨진 건 규칙이 아니라 **검사의 축**이었다. 아래 「점프·낙하」 스위트가    │
   * │ waitUntil 을 무한대로 밀어 수평을 봉인하는 것과 정확히 거울상이다.          │
   * │                                                                          │
   * │ ★ 다만 그때 **진짜 결함이 하나 드러났다** — 내려오는 도중에 가구 footprint  │
   * │   안으로 걸어 들어가면 발밑이 0 으로 잡혀 그대로 가구 **안에** 내려앉고,    │
   * │   드물게 못 빠져나온다(적대적 픽스처 300판 중 3판). 사람도 같은 코드·같은   │
   * │   상수라 똑같이 겪으므로 I1 비대칭은 아니고, 고칠 자리는 봇이 아니라        │
   * │   lib/mp/collide 를 함께 읽는 양쪽 수직 처리다. **여기서 봉인하는 것으로**  │
   * │   **그 결함이 사라지지는 않는다** — 별건으로 남겨 둔 것이다.               │
   * └──────────────────────────────────────────────────────────────────────────┘
   */
  function groundBound(bot: BotState): BotState {
    bot.nextJumpAt = Number.MAX_SAFE_INTEGER;
    return bot;
  }

  it('가구를 뚫고 지나가지 않는다', () => {
    const t0 = 1_000_000;
    const bot = groundBound(
      createBot(SEED, 5, t0, { id: SEED.id, x: SOFA.x, z: SOFA.z - 2.5, heading: 0 }),
    );
    bot.waitUntil = 0;
    bot.speed = 2.5;
    // 소파 정반대편 — 직선으로 가면 반드시 소파를 통과해야 한다
    bot.tx = SOFA.x;
    bot.tz = SOFA.z + 2.5;

    let now = t0;
    for (let i = 0; i < 300; i += 1) {
      now += MOVE_THROTTLE_MS;
      stepBot(bot, now, MOVE_THROTTLE_MS / 1000);
      // ★ 사람과 **같은 기준**으로 본다 (STEP_UP · 실제 발 높이). 예전엔 여기가
      //   `(…, 0, 0)` 이었는데, 그게 곧 "봇은 낮은 턱도 못 넘는다"는 규칙이었고
      //   그 차이가 I1 누출이었다 (bots.ts 의 BOT_STEP_UP 상자).
      //   소파(top 0.99)는 STEP_UP(0.55)보다 높으므로 여전히 못 넘는다.
      expect(isBlocked(bot.x, bot.z, bot.y, STEP_UP)).toBe(false);
    }
  });

  it('막히면 몇 초 뒤 목적지를 다시 잡는다 — 영원히 비비지 않는다', () => {
    const t0 = 1_000_000;
    const bot = groundBound(
      createBot(SEED, 5, t0, { id: SEED.id, x: SOFA.x, z: SOFA.z - 2.5, heading: 0 }),
    );
    bot.waitUntil = 0;
    bot.speed = 2.5;
    bot.tx = SOFA.x;
    bot.tz = SOFA.z + 2.5;

    run(bot, t0, 200); // 20초 — STUCK_MS(2.5초)를 한참 넘긴다
    expect([bot.tx, bot.tz]).not.toEqual([SOFA.x, SOFA.z + 2.5]);
  });

  it("가구에 눌려 못 가면 'walk' 로 제자리걸음하지 않는다", () => {
    const t0 = 1_000_000;
    const bot = groundBound(
      createBot(SEED, 5, t0, { id: SEED.id, x: SOFA.x, z: SOFA.z - 1.1, heading: 0 }),
    );
    bot.waitUntil = 0;
    bot.speed = 2.5;
    bot.tx = SOFA.x; // 소파 정면 — 밀고 들어갈 수 없다
    bot.tz = SOFA.z + 2.5;

    let now = t0;
    let walkedInPlace = 0;
    for (let i = 0; i < 5; i += 1) {
      const before = { x: bot.x, z: bot.z };
      now += MOVE_THROTTLE_MS;
      stepBot(bot, now, MOVE_THROTTLE_MS / 1000);
      const moved = Math.hypot(bot.x - before.x, bot.z - before.z);
      // 걷기든 달리기든 "이동 클립인데 제자리"면 같은 증상이다.
      if (isMoving(bot) && moved < 0.01) walkedInPlace += 1;
    }
    expect(walkedInPlace).toBe(0);
  });

  it('걷는 방향과 보는 방향이 크게 어긋나지 않는다 — 옆걸음처럼 보이면 안 된다', () => {
    const t0 = 1_000_000;
    // 소파를 비스듬히 지나가게 해서 미끄러지는 구간을 만든다
    // 시작·목적지를 넉넉히 벌려 **한 번의 걸음**으로 50틱 넘게 걷게 한다 (아래 상자).
    const bot = groundBound(
      createBot(SEED, 5, t0, { id: SEED.id, x: SOFA.x - 6, z: SOFA.z - 2.8, heading: 0 }),
    );
    bot.waitUntil = 0;
    bot.speed = 2.5;
    bot.tx = SOFA.x + 6;
    bot.tz = SOFA.z + 2.8;

    /*
     * ┌─ ★ 목적지에 닿는 순간 **표본 수집을 끝낸다** ────────────────────────────┐
     * │ 닿으면 stepBot 이 randomPoint 로 새 목적지를 잡고 pickGait 으로 속도도    │
     * │ 다시 뽑는다. 그 직후 몇 틱은 **크게 꺾는 구간**이라 정렬이 당연히 흐트러   │
     * │ 지고, 방향이 랜덤이라 흐트러지는 정도까지 판마다 다르다. 그 표본이 섞이면 │
     * │ 이 검사가 80회 중 1회씩 랜덤하게 깨진다(실측).                           │
     * │                                                                        │
     * │ 이 검사의 주제는 **가구를 스치며 미끄러지는 동안** 몸이 가는 쪽을 보는가다. │
     * │ 꺾을 때의 회전은 다른 문제이고 turnToward(속도 배율)가 따로 진다.         │
     * └──────────────────────────────────────────────────────────────────────┘
     */
    const leg = { tx: bot.tx, tz: bot.tz };

    let now = t0;
    const diffs: number[] = [];
    for (let i = 0; i < 120; i += 1) {
      const before = { x: bot.x, z: bot.z };
      now += MOVE_THROTTLE_MS;
      stepBot(bot, now, MOVE_THROTTLE_MS / 1000);
      if (bot.tx !== leg.tx || bot.tz !== leg.tz) break; // 걸음이 끝났다
      const mx = bot.x - before.x;
      const mz = bot.z - before.z;
      if (!isMoving(bot) || Math.hypot(mx, mz) < 0.05) continue;

      let diff = Math.abs(((Math.atan2(mx, mz) - bot.heading + Math.PI) % (Math.PI * 2)) - Math.PI);
      if (diff > Math.PI) diff = Math.PI * 2 - diff;
      diffs.push(diff);
    }

    // ★ 순간값으로 재면 안 된다. 회전은 TURN_RATE(3.4rad/s)로 따라가므로 출발 직후와
    //   모퉁이에서 꺾이는 순간에는 잠깐 벌어진다 — 그건 사람도 그렇다.
    //   "대부분의 시간 동안 가는 쪽을 보고 있는가"가 실제로 보고 싶은 것이다.
    expect(diffs.length).toBeGreaterThan(30);
    const aligned = diffs.filter((d) => d < Math.PI / 2).length;
    expect(aligned / diffs.length).toBeGreaterThan(0.9);
  });

  it('가구 안에서 시작해도 첫 틱 전에 밀려나 있다', () => {
    const t0 = 1_000_000;
    const bot = createBot(SEED, 5, t0, { id: SEED.id, x: SOFA.x, z: SOFA.z, heading: 0 });
    expect(isBlocked(bot.x, bot.z, bot.y, STEP_UP)).toBe(false);
  });

  /*
   * ┌─ ★ 갇힘 회귀 (2026-08-07) ───────────────────────────────────────────────┐
   * │ 걷기 블록은 *후보* 자리만 본다 — 막히면 **안 움직이는 것**이 전부라, 일단  │
   * │ 밀어내기 범위 안에 들어가면 후보도 전부 막혀서 영원히 얼어붙었다.          │
   * │ 들어가는 길은 실재했다: 소파 위에서 **가장자리 밖으로 걸어 나오는** 순간.   │
   * │ 점프를 잦게 만들자 적대적 픽스처 300판 중 3판이 60초 내내 못 나왔다.       │
   * │                                                                          │
   * │ 답은 사람 클라가 매 프레임 하는 그것이다 — 지금 서 있는 자리를 밀어낸다     │
   * │ (world-scene.tsx 의 resolveColliders). 그래서 이 검사는 **탈출**만 본다.   │
   * └──────────────────────────────────────────────────────────────────────────┘
   */
  /**
   * **실측된 얼어붙음 상태 그대로다.** 오른쪽 소파 둘(4.8,-8.0 · 7.9,-6.4)이 ㄱ 자로
   * 만나는 구석이고, 목적지 방향까지 있어야 재현된다 — 후보 자리가 **그 방향으로**
   * 막혀 있어야 걷기 블록이 이동을 거절하기 때문이다.
   *
   * ★ 자리만으로는 재현되지 않는다. 소파 한가운데처럼 한 번에 깔끔히 밀려나는
   *   자리에서는 후보가 열려서 옛 코드도 그냥 걸어 나온다. 그래서 좌표와 목적지를
   *   **둘 다** 박는다 (적대적 픽스처 1000판 중 8판에서 나온 값이고, 그 판들은
   *   좌표가 틱마다 소수점까지 완전히 같았다 = 한 틱도 안 움직였다).
   * ★ 가구를 옮기면 이 값은 무의미해진다. 아래 첫 expect 가 그때 먼저 걸린다.
   */
  const WEDGE = { x: 6.8, z: -7.55, tx: 2.2, tz: -1.7 };

  it('가구에 끼면 빠져나온다 — 얼어붙지 않는다', () => {
    const t0 = 1_000_000;
    const bot = groundBound(
      createBot(SEED, 5, t0, { id: SEED.id, x: SOFA.x, z: SOFA.z - 2.5, heading: 0 }),
    );
    bot.waitUntil = 0;
    bot.speed = 2.5;

    // 실측된 상태를 그대로 세팅한다 — 가구 윗면에서 걸어 나오다 끼는 경로의 종착점이다.
    bot.x = WEDGE.x;
    bot.z = WEDGE.z;
    bot.tx = WEDGE.tx;
    bot.tz = WEDGE.tz;
    bot.y = 0;
    bot.grounded = true;
    bot.bestDist = Infinity;
    bot.progressAt = t0;
    bot.blockedAt = t0;

    // 전제 확인: 여기는 실제로 막힌 자리여야 한다. 깨지면 가구가 움직인 것이다.
    expect(isBlocked(bot.x, bot.z, bot.y, STEP_UP)).toBe(true);

    /*
     * ★★ 검사의 핵심은 **한 틱**이다. 여러 틱을 굴려 "빠져나왔나"를 보면 안 된다 —
     *    6틱(BLOCKED_MS)이 지나면 randomPoint 로 목적지를 새로 잡고, 그 방향이
     *    운 좋게 열려 있으면 **옛 코드도 걸어 나온다.** 실제로 옛 코드의 갇힘은
     *    1000판 중 8판이라, 시행 하나로는 검사가 동전 던지기가 된다.
     *
     *    반면 첫 틱은 결정적이다. 옛 코드는 후보 자리가 막혀 있으면 **좌표를 아예
     *    건드리지 않는다** — 소수점 넷째 자리까지 그대로다(실측). 지금은 사람 클라처럼
     *    지금 자리를 밀어내므로 반드시 움직인다. 그 차이 하나만 본다.
     */
    stepBot(bot, t0 + MOVE_THROTTLE_MS, MOVE_THROTTLE_MS / 1000);
    expect(bot.x === WEDGE.x && bot.z === WEDGE.z).toBe(false);
  });

  it('목적지를 가구 안에 잡지 않는다', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 100; i += 1) {
      const bot = createBot(SEED, 5, t0);
      expect(isBlocked(bot.tx, bot.tz, 0, STEP_UP)).toBe(false);
    }
  });

  /*
   * ┌─ ★ I1 회귀 — 봇의 발이 사람과 같은 규칙을 탄다 ──────────────────────────┐
   * │ 예전 봇은 stepUp = 0 이라 낮은 턱을 **돌아갔고**, 발 높이는 무슨 짓을 해도 │
   * │ 0이었다. 사람은 낮은 탁자의 자리로 그냥 걸어 들어가고, 뛰어오르면 가구     │
   * │ 윗면에 선다. 그래서 규칙이 둘 섰다 —                                      │
   * │   · 낮은 탁자를 굳이 빙 돌아가면 봇                                       │
   * │   · **가구 위에 서 있으면 사람**                                          │
   * │ 총 자리·AI 수가 공개(§15-3)라 몇 자리만 확정돼도 소거법으로 나머지가 갈린다.│
   * └──────────────────────────────────────────────────────────────────────────┘
   */
  it('낮은 턱은 사람처럼 그냥 지난다 — 돌아가면 그게 표식이다 (I1)', () => {
    /** STEP_UP 아래 턱 — 사람의 이동을 막지 않는 낮은 탁자 */
    const TABLE = COLLIDERS.find((c) => c.top < STEP_UP)!;
    const t0 = 1_000_000;
    // 탁자 한가운데에서 시작한다. stepUp = 0 이던 시절에는 createBot 의
    // resolveCollisions 가 여기서 옆으로 밀어냈다 — 그 밀림이 곧 "돌아간다"였다.
    const bot = createBot(SEED, 5, t0, { id: SEED.id, x: TABLE.x, z: TABLE.z, heading: 0 });

    expect(bot.x).toBe(TABLE.x);
    expect(bot.z).toBe(TABLE.z);
    expect(isBlocked(bot.x, bot.z, bot.y, STEP_UP)).toBe(false);
  });

  it('가구 위로 떨어지면 그 윗면에 선다 — 착지 높이가 늘 0이면 그게 표식이다 (I1)', () => {
    /** STEP_UP 보다 높은 가구 — 걸어서는 못 올라가고 뛰어야 올라간다 */
    const SOFA_TOP = SOFA.top;
    const t0 = 1_000_000;
    const bot = createBot(SEED, 5, t0, { id: SEED.id, x: SOFA.x, z: SOFA.z, heading: 0 });
    // 소파 윗면보다 위에서 떨어뜨린다 (사람이 점프로 올라서는 그 상황).
    bot.x = SOFA.x;
    bot.z = SOFA.z;
    bot.y = SOFA_TOP + 0.4;
    bot.vy = 0;
    bot.grounded = false;
    bot.waitUntil = Number.MAX_SAFE_INTEGER; // 걷지 않게 세워 둔다 — 수직만 본다

    run(bot, t0, 20); // 2초 — 0.4m 낙하에는 충분하다

    expect(bot.y).toBeCloseTo(SOFA_TOP, 5);
    expect(bot.vy).toBe(0);
    expect(bot.y).toBeCloseTo(groundHeightAt(bot.x, bot.z, bot.y), 5);
  });
});

describe('걸음걸이 — 봇도 달린다 (I1)', () => {
  /*
   * 왜 이 검사가 있나: 봇의 anim 은 'idle'·'walk' 둘뿐이었다. 사람은 Shift 로
   * 'run' 을 실어 보내므로 **한 번이라도 달린 자리는 사람 확정**이었고, 뒤집으면
   * "판 내내 한 번도 안 달린 자리"가 봇 후보 명단이다. 점프(BOT_JUMP_*)와 같은 구멍이다.
   */
  it('목적지를 여러 번 잡으면 걷기와 달리기가 둘 다 나온다', () => {
    const gaits = new Set<string>();
    for (let i = 0; i < 400; i += 1) {
      const bot = createBot(SEED, 5, 1_000_000 + i, { id: SEED.id, x: -6, z: LANE_Z, heading: 0 });
      gaits.add(bot.running ? 'run' : 'walk');
    }
    // 400번이면 한쪽만 나올 확률은 사실상 0이다 (BOT_RUN_CHANCE 는 0과 1 사이).
    expect([...gaits].sort()).toEqual(['run', 'walk']);
  });

  it('달리는 걸음은 anim 이 run 이고 사람의 RUN_SPEED 언저리로 간다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    bot.running = true;
    bot.speed = RUN_SPEED;

    run(bot, t0, 5);
    expect(bot.anim).toBe('run');
    // 사람이 달릴 때와 같은 속도 규모다 — 여기가 갈리면 속도만으로 자리가 갈린다.
    expect(bot.speed).toBeGreaterThan(WALK_SPEED);
  });

  /*
   * ┌─ ★ 달리면서 꺾어도 옆걸음이 안 나온다 (2026-08-07 회귀) ───────────────────┐
   * │ TURN_RATE 는 고정값이었다. 걷기(≈2.6m/s)에서는 충분했는데 달리기(5.6m/s)를  │
   * │ 넣자 **몸이 가는 쪽을 못 따라갔다** — 방향은 즉시 바뀌는데 회전은 그대로라   │
   * │ 90° 를 도는 0.46초 동안 2.6m 를 옆걸음으로 갔다. 무빙워크처럼 보인다.       │
   * │                                                                          │
   * │ 그래서 재는 값이 **시간이 아니라 거리**다: 몸이 가는 쪽을 보게 되기까지      │
   * │ 몇 미터를 갔는가. 이 값이 걸음걸이와 무관해야 화면에서 같아 보인다.         │
   * └──────────────────────────────────────────────────────────────────────────┘
   */
  it('달리면서 꺾어도 걷기와 같은 거리 안에 몸이 돌아간다 — 옆걸음 방지', () => {
    /** 90° 꺾어 걷게 하고, 몸이 가는 쪽을 볼 때까지 간 거리(m)를 잰다. */
    function turnDistance(speed: number, running: boolean): number {
      const t0 = 1_000_000;
      // 가구 없는 통로 (walkingBot 과 같은 줄). heading 0 = +z 를 보고 시작한다.
      const bot = createBot(SEED, 5, t0, { id: SEED.id, x: -6, z: LANE_Z, heading: 0 });
      bot.nextJumpAt = Number.MAX_SAFE_INTEGER;
      bot.waitUntil = 0;
      bot.running = running;
      bot.speed = speed;
      bot.tx = 8; // +x 방향 — 시작 방향과 90° 어긋난다
      bot.tz = LANE_Z;

      const from = { x: bot.x, z: bot.z };
      let now = t0;
      for (let i = 0; i < 200; i += 1) {
        now += MOVE_THROTTLE_MS;
        stepBot(bot, now, MOVE_THROTTLE_MS / 1000);
        // 목표 방향(+x = atan2(1,0) = π/2)과 몸이 보는 쪽의 차이
        const diff = Math.abs(Math.PI / 2 - bot.heading);
        if (diff < 0.1) return Math.hypot(bot.x - from.x, bot.z - from.z);
      }
      return Infinity;
    }

    const walk = turnDistance(WALK_SPEED, false);
    const run = turnDistance(RUN_SPEED, true);

    expect(walk).toBeLessThan(2);
    // 옛 코드에서는 run 이 walk 의 2배가 넘었다 (속도비 그대로). 오차를 넉넉히 봐도 1.3배면 충분하다.
    expect(run).toBeLessThan(walk * 1.3);
  });

  it('말하려고 서면 걸음걸이와 무관하게 idle 이다 — 달리다 말하면 안 된다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    bot.running = true;
    bot.speed = RUN_SPEED;

    scheduleSpeech(bot, '나는 아닌 것 같은데', t0);
    run(bot, t0, 40);
    expect(bot.anim).toBe('idle');
  });
});

describe('발화 예약', () => {
  it('예약하면 그 자리에 선다 — 사람은 타이핑 중 발이 묶인다 (I1)', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);

    const x0 = bot.x;
    run(bot, t0, 3);
    expect(bot.anim).toBe('walk');
    expect(bot.x).toBeGreaterThan(x0);

    const x = bot.x;
    scheduleSpeech(bot, '다들 조용하네', t0 + 300);
    run(bot, t0 + 300, 10);

    expect(bot.anim).toBe('idle');
    expect(bot.x).toBe(x);
    expect(bot.z).toBe(LANE_Z);
  });

  it('예약 중에는 새로 뛰지 않는다 — Space 도 입력줄로 먹힌다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    bot.nextJumpAt = 0; // 뛸 때가 한참 지났다

    scheduleSpeech(bot, '음... 잠깐만', t0);
    run(bot, t0, 10);
    expect(bot.y).toBe(0);
    expect(bot.vy).toBe(0);
  });

  it('예약 시점에 공중이었으면 착지까지는 굴린다 — 공중에서 얼면 그게 표식이다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    bot.nextJumpAt = 0;

    run(bot, t0, 2); // 뛰어오른다
    expect(bot.y).toBeGreaterThan(0);

    scheduleSpeech(bot, '그래서 결론이 뭐야', t0 + 200);
    run(bot, t0 + 200, 20); // 체공 ≈ 0.75초 < 2초
    expect(bot.y).toBe(0);
  });

  it('speakAt 전에는 안 나오고, 지나면 딱 한 번 나온다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    const text = '아까부터 저쪽이 수상해';

    scheduleSpeech(bot, text, t0);
    // 범위는 **글자 수 예산**으로 잡힌다. 문구 길이로 재면 예산이 낮게 뽑힌 판에서
    // 랜덤하게 깨진다 — 지연을 내용과 끊은 게 바로 그 뜻이다.
    expect(bot.speakAt).toBeGreaterThanOrEqual(t0 + typingDelayMs('x'.repeat(BOT_TYPE_CHARS_MIN)));
    expect(bot.speakAt).toBeLessThan(
      t0 + typingDelayMs('x'.repeat(BOT_TYPE_CHARS_MAX)) + SPEAK_JITTER_MS,
    );

    expect(takeSpeech(bot, bot.speakAt - 1)).toBeNull();
    expect(takeSpeech(bot, bot.speakAt)).toBe(text);
    expect(takeSpeech(bot, bot.speakAt + 10_000)).toBeNull();
  });

  it('치는 시간은 문구 길이와 무관하다 — 길이가 타이밍으로 새면 안 된다 (I1)', () => {
    const t0 = 1_000_000;
    const shortText = 'ㅇㅇ';
    const longText = '아까부터 저쪽이 계속 수상했는데 다들 왜 아무 말도 안 해';

    // 같은 문구를 여러 번 예약해도 매번 다른 시간이 나오고(예산이 랜덤),
    // 서로 다른 길이의 문구가 같은 범위 안에 들어온다.
    const waits = (text: string) => {
      const out: number[] = [];
      for (let i = 0; i < 200; i += 1) {
        const bot = walkingBot(t0);
        scheduleSpeech(bot, text, t0);
        out.push(bot.speakAt - bot.typeAt);
      }
      return out;
    };

    const lo = typingDelayMs('x'.repeat(BOT_TYPE_CHARS_MIN));
    const hi = typingDelayMs('x'.repeat(BOT_TYPE_CHARS_MAX)) + SPEAK_JITTER_MS;

    for (const w of [...waits(shortText), ...waits(longText)]) {
      expect(w).toBeGreaterThanOrEqual(lo);
      expect(w).toBeLessThan(hi);
    }

    // 두 길이의 평균이 서로 붙어 있어야 한다 — 벌어지면 길이가 새고 있다는 뜻이다
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(Math.abs(avg(waits(shortText)) - avg(waits(longText)))).toBeLessThan(300);
  });

  it('말하고 나면 가던 길을 이어서 간다 — 목적지가 초기화되지 않는다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);

    run(bot, t0, 3);
    const x = bot.x;

    scheduleSpeech(bot, '나는 아닌 것 같은데', t0 + 300);
    // ★ 고정 틱수로 기다리지 않는다. 치는 시간이 랜덤 예산이라 짧게도 길게도 나온다 —
    //   3초만 기다리면 아직 치는 중인 판에서 검사가 랜덤하게 깨진다.
    const ticks = Math.ceil((bot.speakAt - (t0 + 300)) / MOVE_THROTTLE_MS) + 1;
    const after = run(bot, t0 + 300, ticks);
    expect(takeSpeech(bot, after)).not.toBeNull();

    run(bot, after, 5);
    expect(bot.anim).toBe('walk');
    expect(bot.x).toBeGreaterThan(x);
    expect(bot.tx).toBe(8);
  });
});

describe('읽는 시간', () => {
  it('readDelay 동안에는 계속 걷는다 — 사람이 말한 순간 멈추면 그게 표식이다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);

    scheduleSpeech(bot, '그건 좀 이상한데', t0, 2_000);
    run(bot, t0, 5); // 0.5초 — 아직 읽는 중
    expect(bot.anim).toBe('walk');

    const x = bot.x;
    run(bot, t0 + 500, 20); // 2.5초 — 읽기가 끝나 치기 시작했다
    expect(bot.anim).toBe('idle');
    expect(bot.x).toBeGreaterThan(x);
  });

  it('readDelay 는 speakAt 을 통째로 뒤로 민다', () => {
    const t0 = 1_000_000;
    const now = walkingBot(t0);
    const later = walkingBot(t0);
    const text = '나는 아닌 것 같은데';

    scheduleSpeech(now, text, t0, 0);
    scheduleSpeech(later, text, t0, 2_000);

    // ★ speakAt 끼리 견주지 않는다. 치는 시간은 이제 랜덤 예산이라 두 봇이 서로 다르다 —
    //   readDelay 가 미는 건 **typeAt** 이고, speakAt 은 거기서부터 다시 쌓인다.
    expect(now.typeAt).toBe(t0);
    expect(later.typeAt).toBe(t0 + 2_000);
    expect(now.speakAt).toBeGreaterThan(now.typeAt);
    expect(later.speakAt).toBeGreaterThan(later.typeAt);
  });

  it('읽는 시간은 상수 범위 안이다 — 가끔 딴짓한 판만 뒤로 늘어난다', () => {
    let distracted = 0;
    for (let i = 0; i < 600; i += 1) {
      const d = readDelayMs();
      expect(d).toBeGreaterThanOrEqual(BOT_READ_MIN_MS);
      expect(d).toBeLessThanOrEqual(BOT_READ_MAX_MS + BOT_DISTRACTED_MAX_MS);
      if (d > BOT_READ_MAX_MS) distracted += 1;
    }
    /*
     * ★ 늦는 판이 **아예 없으면** 그게 문제다 (I1). 읽는 시간이 늘 1.2~4초면 분포가
     *   너무 좁아서, 사람과 견주면 "항상 몇 초 안에 답하는 자리"로 드러난다.
     *   반대로 매번 늦어도 안 된다 — 그것도 그 자리만의 규칙이 된다.
     */
    expect(distracted, '늦게 답하는 판이 하나도 없다').toBeGreaterThan(0);
    expect(distracted, '늘 늦게 답한다').toBeLessThan(600 / 2);
  });
});

/*
 * 하드코딩 문구 풀을 없앤 뒤 생긴 상태다 — 자리는 잡혔는데 할 말이 아직(또는 끝내) 없다.
 * 여기서 지키려는 건 하나: **LLM 이 오든 안 오든 봇이 서 있는 모습이 같아야 한다.**
 * 어긋나면 "LLM 을 기다리는 자리 = 봇"이 되어 I1 이 무너진다.
 */
describe('문구 없는 예약 — 월드의 기본 경로', () => {
  it('할 말이 없어도 발이 묶인다 — 서 있는 시간이 LLM 성패와 같아야 한다 (I1)', () => {
    const t0 = 1_000_000;
    const withText = walkingBot(t0);
    const without = walkingBot(t0);

    scheduleSpeech(withText, '아 그거 나도 봤어', t0);
    scheduleSpeech(without, null, t0);

    run(withText, t0, 5);
    run(without, t0, 5);

    expect(without.anim).toBe('idle');
    expect(without.anim).toBe(withText.anim);
  });

  it('시각이 되면 자리를 놓아주되 아무 말도 내보내지 않는다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    scheduleSpeech(bot, null, t0);

    expect(takeSpeech(bot, bot.speakAt - 1)).toBeNull(); // 아직 치는 중
    expect(takeSpeech(bot, bot.speakAt)).toBeNull(); // 시각이 됐지만 할 말이 없다

    // 자리는 놓였다 — 다시 걷고 다음 발화도 예약할 수 있어야 한다.
    // mayInitiate=true = "마지막 발화가 사람 것" — 여기서 보려는 건 자리 해제뿐이다.
    bot.nextChatAt = 0;
    expect(shouldChat(bot, bot.speakAt, true)).toBe(true);
  });

  it('LLM 이 제때 오면 그 자리가 채워진다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    scheduleSpeech(bot, null, t0, 2_000);

    expect(replaceSpeech(bot, bot.speechSeq, '오 그거 나도 봤어', t0 + 500)).toBe(true);
    expect(takeSpeech(bot, bot.speakAt)).toBe('오 그거 나도 봤어');
  });

  it('빈 자리도 겹쳐 예약되지 않는다 — 한 번에 한 줄만 친다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    bot.nextChatAt = 0;

    scheduleSpeech(bot, null, t0);
    // 사람이 마지막으로 말했더라도(mayInitiate=true) 자리가 잡혀 있으면 막힌다.
    expect(shouldChat(bot, t0 + 60_000, true)).toBe(false);
  });
});

describe('scheduleInstantSpeech — 라운지의 즉답 예약', () => {
  it('서지 않는다 — 다음 틱에 자리가 비고 계속 걷는다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    scheduleInstantSpeech(bot, t0);

    // 자리는 첫 takeSpeech 에서 곧장 비고, 아무 말도 나가지 않는다.
    expect(takeSpeech(bot, t0 + MOVE_THROTTLE_MS)).toBeNull();
    expect(bot.speechHeld).toBe(false);

    run(bot, t0 + MOVE_THROTTLE_MS, 5);
    expect(bot.anim).toBe('walk');
  });

  it('LLM 답은 예약 자리로 못 들어온다 — 지각 경로(도착 후 잠깐 서서 말하기)만 남는다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    scheduleInstantSpeech(bot, t0);
    const seq = bot.speechSeq;

    // speakAt = now 라 replaceSpeech 는 항상 거절 — 호출부(upgradeSpeech)는
    // companion 지각 경로로 넘어가 scheduleArrivedSpeech 로 내보낸다.
    expect(replaceSpeech(bot, seq, '바로 온 답', t0 + 1_500)).toBe(false);
    // 그 사이 새 예약이 없었으면 일련번호는 그대로다 — 지각 경로의 열쇠가 맞는다.
    takeSpeech(bot, t0 + MOVE_THROTTLE_MS);
    expect(bot.speechSeq).toBe(seq);
  });

  it('다음 예약이 걸렸으면 일련번호가 달라진다 — 묵은 답이 새 자리에 얹히지 않는다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    scheduleInstantSpeech(bot, t0);
    const stale = bot.speechSeq;

    takeSpeech(bot, t0 + MOVE_THROTTLE_MS); // 자리 해제
    scheduleInstantSpeech(bot, t0 + 5_000); // 새 반응 예약

    expect(bot.speechSeq).not.toBe(stale);
  });
});

describe('scheduleArrivedSpeech — 도착한 답은 잠깐 서서 치고 나간다', () => {
  it('말풍선이 뜨기 전까지 서 있는다 — 걸으면서 말하면 그게 표식이다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    scheduleArrivedSpeech(bot, '어 나도 그거 봤어', null, t0);

    expect(takeSpeech(bot, t0)).toBeNull(); // 아직 치는 중
    run(bot, t0, 3);
    expect(bot.anim).toBe('idle');

    expect(takeSpeech(bot, bot.speakAt)).toBe('어 나도 그거 봤어');
  });

  it('라운지 상한이 걸리면 그 안에 나간다 — 속도가 우선이다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    // 상한 없이는 1.5초를 넘길 만큼 긴 문구
    const long = '오늘 점심에 회사 앞에서 마라탕 먹었는데 완전 맛있었음';
    expect(typingDelayMs(long)).toBeGreaterThan(1_500);

    scheduleArrivedSpeech(bot, long, null, t0, LOUNGE_TYPE_MAX_MS);
    expect(bot.speakAt - t0).toBeLessThanOrEqual(LOUNGE_TYPE_MAX_MS);
  });

  it('상한이 없으면 사람 타이핑 속도로 친다 — 판이 도는 방의 지각 답', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    const text = '아 그건 좀 아닌 것 같은데';
    scheduleArrivedSpeech(bot, text, null, t0);

    expect(bot.speakAt - t0).toBeGreaterThanOrEqual(typingDelayMs(text));
    expect(bot.speakAt - t0).toBeLessThan(typingDelayMs(text) + SPEAK_JITTER_MS);
  });

  it('뒷줄은 앞 줄이 나간 뒤에 이어 예약된다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    scheduleArrivedSpeech(bot, '앞 줄', '뒷줄이야', t0, LOUNGE_TYPE_MAX_MS);

    expect(takeSpeech(bot, bot.speakAt)).toBe('앞 줄');
    expect(bot.speechHeld).toBe(true);
    expect(bot.pendingText).toBe('뒷줄이야');
  });
});

describe('replaceSpeech — LLM 덮어쓰기', () => {
  it('문구만 바뀌고 시각은 그대로다 (I1의 핵심)', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    scheduleSpeech(bot, '음... 잠깐만', t0, 2_000);

    const { typeAt, speakAt } = bot;
    expect(replaceSpeech(bot, bot.speechSeq, '아 그거 나도 봤어', t0 + 500)).toBe(true);

    expect(bot.pendingText).toBe('아 그거 나도 봤어');
    expect(bot.typeAt).toBe(typeAt);
    expect(bot.speakAt).toBe(speakAt);
  });

  it('말할 시각이 지났으면 거절한다 — 늦은 답은 쓸 데가 없다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    scheduleSpeech(bot, '음... 잠깐만', t0);

    expect(replaceSpeech(bot, bot.speechSeq, '늦은 답', bot.speakAt)).toBe(false);
    expect(bot.pendingText).toBe('음... 잠깐만');
  });

  it('이미 말했으면 거절한다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    scheduleSpeech(bot, '음... 잠깐만', t0);
    const seq = bot.speechSeq;
    takeSpeech(bot, bot.speakAt);

    expect(replaceSpeech(bot, seq, '늦은 답', bot.speakAt + 1)).toBe(false);
    expect(bot.pendingText).toBeNull();
  });

  it('그 사이 다음 발화가 예약됐으면 거절한다 — 지난 대화의 답이 얹히면 안 된다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    scheduleSpeech(bot, '첫 번째', t0);
    const stale = bot.speechSeq;
    const firstSpeakAt = bot.speakAt;

    takeSpeech(bot, firstSpeakAt);
    scheduleSpeech(bot, '두 번째', firstSpeakAt, 2_000);

    // 두 번째가 나갈 시각보다 한참 전이다 — 거절 사유가 시각이 아니라 번호임을 못 박는다
    const now = firstSpeakAt + 100;
    expect(now).toBeLessThan(bot.speakAt);

    expect(replaceSpeech(bot, stale, '첫 번째에 대한 답', now)).toBe(false);
    expect(bot.pendingText).toBe('두 번째');

    // 지금 번호로는 들어간다
    expect(replaceSpeech(bot, bot.speechSeq, '두 번째에 대한 답', now)).toBe(true);
    expect(bot.pendingText).toBe('두 번째에 대한 답');
  });

  it('예약할 때마다 일련번호가 오른다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    const seq0 = bot.speechSeq;
    scheduleSpeech(bot, '가', t0);
    scheduleSpeech(bot, '나', t0);
    expect(bot.speechSeq).toBe(seq0 + 2);
  });
});

describe('pickResponder', () => {
  /** 확률이 끼는 경로(chanceOverride)가 남아 있어 여러 번 돌려 본다. */
  function tally(make: () => BotState[], now: number, n = 200) {
    let hit = 0;
    let miss = 0;
    for (let i = 0; i < n; i += 1) {
      if (pickResponder(make(), now) === null) miss += 1;
      else hit += 1;
    }
    return { hit, miss };
  }

  it('쿨다운 중인 봇은 절대 안 고른다', () => {
    const t0 = 1_000_000;
    const { hit } = tally(() => {
      const bot = walkingBot(t0);
      bot.nextReactAt = t0 + 10_000;
      return [bot];
    }, t0);
    expect(hit).toBe(0);
  });

  it('이미 예약이 걸린 봇은 안 고른다 — 한 번에 한 줄만 친다', () => {
    const t0 = 1_000_000;
    const { hit } = tally(() => {
      const bot = walkingBot(t0);
      scheduleSpeech(bot, '음... 잠깐만', t0);
      return [bot];
    }, t0);
    expect(hit).toBe(0);
  });

  it('고른 봇은 자발 발화를 미룬다 — 대꾸하고 몇 초 뒤 혼잣말까지 하지 않는다', () => {
    const t0 = 1_000_000;
    const bots = [walkingBot(t0)];
    bots[0].nextChatAt = t0 + 100; // 곧 혼잣말할 참이었다

    let picked: BotState | null = null;
    for (let i = 0; i < 200 && !picked; i += 1) picked = pickResponder(bots, t0);
    expect(picked).not.toBeNull();

    // 쿨다운은 0 이다 (2026-08-07) — 점유율은 시간이 아니라 확률로 맞춘다.
    expect(picked!.nextReactAt).toBe(t0 + BOT_REACT_COOLDOWN_MS);
    expect(picked!.nextChatAt).toBeGreaterThan(t0 + 100);
  });

  /*
   * 확률 게이트는 없앴다 (2026-08-07, 세 번째 신고 "대화를 안 하니까 AI 같다").
   * 아껴 말하는 자리는 반응률로 갈리기 전에 **침묵으로 먼저** 갈린다 —
   * BOT_REACT_CHANCE 의 상자. 남은 제동은 아래 두 검사(speechHeld · topicDue)다.
   */
  it('알맹이 있는 말은 다 받는다 — 절반을 씹지 않는다', () => {
    const t0 = 1_000_000;
    expect(BOT_REACT_CHANCE).toBe(1);
    let hit = 0;
    for (let i = 0; i < 300; i += 1) {
      if (pickResponder([walkingBot(t0)], t0)) hit += 1;
    }
    expect(hit).toBe(300);
  });

  /*
   * speak 창에서 LLM 답을 기다리는 동안 사람이 채팅을 치면, 그 대꾸 예약이
   * speechSeq 를 올려 **날아오던 주제 답을 무효로** 만든다. 그러면 다 같이 주제에
   * 답하는 45초에 그 자리만 주제를 씹고 잡담에만 답한 꼴이 된다 (I1).
   */
  it('주제에 답할 빚이 남았으면 사람 말 대꾸에 자리를 안 내준다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    primeForTopic(bot, t0, 45_000, true);
    expect(bot.topicDue).toBe(t0 + 45_000);
    expect(pickResponder([bot], t0 + 1_000)).toBeNull();

    // 빚을 갚으면(주제 답이 실제로 나갔다 — room-do 의 botSpoke) 평소대로 받는다.
    bot.topicDue = 0;
    expect(pickResponder([bot], t0 + 1_000)).not.toBeNull();
  });

  it('창이 닫히면 빚도 만료된다 — 한마디도 못 한 창을 다음 단계로 끌고 가지 않는다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    primeForTopic(bot, t0, 45_000, true);
    expect(pickResponder([bot], t0 + 45_001)).not.toBeNull();
  });

  it('침묵하기로 뽑힌 창은 빚이 없다 — 대꾸까지 막으면 45초가 통째로 조용해진다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    primeForTopic(bot, t0, 45_000, false);
    expect(bot.topicDue).toBe(0);
    expect(pickResponder([bot], t0 + 1_000)).not.toBeNull();
  });

  it('봇이 없으면 null', () => {
    expect(pickResponder([], 1_000_000)).toBeNull();
  });

  /*
   * ★ 예전엔 "동행자 모드가 게임보다 훨씬 잘 대꾸한다"를 검사했다. 게임 쪽 확률이
   *   1 이 된 지금 두 무대의 값이 같아서 그 비교는 성립하지 않는다.
   *   지켜야 할 방향은 남았다: **라운지가 게임보다 굼떠서는 안 된다.**
   *   말동무가 판보다 조용하면 그건 위장이 아니라 고장이다.
   */
  it('라운지가 게임보다 굼뜨지 않다', () => {
    const t0 = 1_000_000;
    const game = tally(() => [walkingBot(t0)], t0);
    let companionHit = 0;
    for (let i = 0; i < 200; i += 1) {
      if (pickResponder([walkingBot(t0)], t0, true) !== null) companionHit += 1;
    }
    expect(companionHit).toBeGreaterThanOrEqual(game.hit);
  });

  it('확률을 갈아끼울 수 있다 — 사람 발화가 아닌 자리(봇 발화·입퇴장)용이다', () => {
    /*
     * 호출부가 주사위를 한 번 더 굴리면 실제 확률이 두 값의 곱이 돼서 상수만 봐서는
     * 알 수 없어진다. 그래서 확률 자체를 받는다 (room-do.ts의 maybeChain·reactToEvent).
     */
    const t0 = 1_000_000;
    let never = 0;
    let always = 0;
    for (let i = 0; i < 200; i += 1) {
      if (pickResponder([walkingBot(t0)], t0, true, 0) !== null) never += 1;
      if (pickResponder([walkingBot(t0)], t0, false, 1) !== null) always += 1;
    }
    expect(never).toBe(0);
    expect(always).toBe(200);
  });

  it('확률을 갈아끼워도 예약 규칙은 그대로다', () => {
    const t0 = 1_000_000;
    const held = walkingBot(t0);
    scheduleSpeech(held, null, t0);
    expect(pickResponder([held], t0, true, 1)).toBeNull();

    const cooling = walkingBot(t0);
    cooling.nextReactAt = t0 + 10_000;
    expect(pickResponder([cooling], t0, true, 1)).toBeNull();
  });

  /*
   * ★ 예전엔 "동행자 모드의 쿨다운이 게임보다 짧다"를 검사했다. 이제 **양쪽 다 0**
   *   이라 그 비교가 성립하지 않는다 (2026-08-07 — 점유율은 확률로 맞춘다).
   *   검사해야 할 것은 남았다: 잠기는 자리가 아무 데도 없다는 것.
   */
  it('대꾸해도 잠기지 않는다 — 게임도 라운지도 쿨다운이 0이다', () => {
    const t0 = 1_000_000;
    const lockFor = (companion: boolean) => {
      for (let i = 0; i < 400; i += 1) {
        const got = pickResponder([walkingBot(t0)], t0, companion);
        if (got) return got.nextReactAt - t0;
      }
      throw new Error('한 번도 안 뽑혔다');
    };
    expect(lockFor(true)).toBe(0);
    expect(lockFor(false)).toBe(0);
  });
});

describe('pickLine', () => {
  const POOL = ['가', '나', '다', '라'];

  it('최근에 나온 문구는 피한다', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(pickLine(POOL, ['가', '나', '다'])).toBe('라');
    }
  });

  it('전부 최근이면 어쩔 수 없이 아무거나 뽑는다 — 빈 문자열을 내지 않는다', () => {
    const line = pickLine(POOL, POOL);
    expect(POOL).toContain(line);
  });

  it('최근이 비면 풀 전체에서 뽑는다', () => {
    const seen = new Set<string | null>();
    for (let i = 0; i < 200; i += 1) seen.add(pickLine(POOL, []));
    expect(seen.size).toBe(POOL.length);
  });

  /*
   * 로비 방(월드 AI)에는 풀이 없다 — 하드코딩 문구를 없앴기 때문이다.
   * 여기서 빈 문자열이나 undefined 가 새면 봇이 빈 말풍선을 띄운다.
   */
  it('풀이 비면 null이다 — 월드 로비의 기본 상태다', () => {
    expect(pickLine([], [])).toBeNull();
    expect(pickLine([], ['가'])).toBeNull();
  });
});

describe('shouldChat', () => {
  it('때가 되면 true, 그 뒤로는 다시 잠긴다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    bot.nextChatAt = t0;

    expect(shouldChat(bot, t0, true)).toBe(true);
    expect(shouldChat(bot, t0, true)).toBe(false);
    expect(bot.nextChatAt).toBeGreaterThan(t0);
  });

  it('이미 치는 중이면 겹쳐 예약하지 않는다 — 사람도 한 번에 한 줄만 친다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    bot.nextChatAt = 0;

    scheduleSpeech(bot, '방금 뭐라고 했어?', t0);
    expect(shouldChat(bot, t0 + 60_000, true)).toBe(false);

    takeSpeech(bot, bot.speakAt);
    expect(shouldChat(bot, t0 + 60_000, true)).toBe(true);
  });

  it('마지막 발화가 봇 것이면 또 꺼내지 않는다 — 혼자 떠들고 혼자 대답하는 걸 막는다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    bot.nextChatAt = t0;

    expect(shouldChat(bot, t0, false)).toBe(false);
  });

  it('막혀도 다음 시각은 앞으로 민다 — 밀린 타이머가 사람 말에 겹쳐 터지지 않게', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    bot.nextChatAt = t0;

    // 사람이 조용한 동안 몇 번을 지나가도, 그때마다 다음 시각이 새로 잡힌다.
    expect(shouldChat(bot, t0, false)).toBe(false);
    const pushed = bot.nextChatAt;
    expect(pushed).toBeGreaterThan(t0);

    // 사람이 입을 연 그 순간(= 아직 다음 시각 전)에 혼잣말이 터지지 않는다.
    expect(shouldChat(bot, t0 + 1_000, true)).toBe(false);
    expect(bot.nextChatAt).toBe(pushed);
  });
});

describe('뒷줄 — 두 줄로 나눠 친다', () => {
  it('앞 줄이 나간 **직후** 뒷줄이 이어 예약된다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    scheduleSpeech(bot, null, t0);
    replaceSpeech(bot, bot.speechSeq, '안녕 반가워', t0 + 100, '아 그리고 스크린도 꺼져 있더라');

    const first = takeSpeech(bot, bot.speakAt);
    expect(first).toBe('안녕 반가워');

    // 자리가 곧바로 다시 잡혔다 — 사람은 한 생각을 두 번에 나눠 치지,
    // 두 번째 줄을 몇십 초 뒤에 치지 않는다
    expect(bot.speechHeld).toBe(true);
    expect(bot.pendingText).toBe('아 그리고 스크린도 꺼져 있더라');
    expect(bot.speakAt).toBeGreaterThan(t0);

    expect(takeSpeech(bot, bot.speakAt)).toBe('아 그리고 스크린도 꺼져 있더라');
    expect(bot.speechHeld).toBe(false);
  });

  it('뒷줄은 오래 안 끈다 — 앞 줄 나가고 몇 초 안이다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    scheduleSpeech(bot, null, t0);
    replaceSpeech(bot, bot.speechSeq, '안녕 반가워', t0 + 100, '아 그리고 스크린도 꺼져 있더라');

    const saidAt = bot.speakAt;
    takeSpeech(bot, saidAt);
    // 진짜 문구 길이로 잰다 — 이 줄은 LLM이 갈아치우지 않으므로 길이가 샐 데가 없다
    expect(bot.speakAt - saidAt).toBeGreaterThanOrEqual(typingDelayMs('아 그리고 스크린도 꺼져 있더라'));
    expect(bot.speakAt - saidAt).toBeLessThan(typingDelayMs('아 그리고 스크린도 꺼져 있더라') + SPEAK_JITTER_MS);
  });

  it('앞 줄이 빈 채 지나갔으면 뒷줄도 안 나간다 — 앞뒤 없는 한마디가 뜨면 안 된다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    scheduleSpeech(bot, null, t0); // LLM이 끝내 안 왔다 → pendingText는 null

    expect(takeSpeech(bot, bot.speakAt)).toBeNull();
    expect(bot.speechHeld).toBe(false);
    expect(bot.pendingText).toBeNull();
  });

  it('뒷줄이 걸리면 seq가 올라간다 — 늦게 온 LLM 답이 뒷줄을 덮으면 안 된다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    scheduleSpeech(bot, null, t0);
    const seq = bot.speechSeq;
    replaceSpeech(bot, seq, '안녕 반가워', t0 + 100, '아 그리고 스크린도 꺼져 있더라');
    takeSpeech(bot, bot.speakAt);

    expect(bot.speechSeq).not.toBe(seq);
    expect(replaceSpeech(bot, seq, '늦게 온 답', bot.speakAt - 1)).toBe(false);
    expect(bot.pendingText).toBe('아 그리고 스크린도 꺼져 있더라');
  });
});

describe('딴짓 지연 — 가끔 늦게 답한다 (I1)', () => {
  it('치는 시간에는 안 섞인다 — 딴짓은 읽는 시간 쪽이라 그동안 계속 걷는다', () => {
    /*
     * 딴짓이 typeAt→speakAt(서서 치는 구간)에 섞이면 그만큼 **얼어붙은 채** 서 있게
     * 되고, 그건 늦게 답하는 것보다 훨씬 눈에 띈다. readDelayMs 쪽에 둔 이유다.
     */
    const t0 = 1_000_000;
    const lo = typingDelayMs('x'.repeat(BOT_TYPE_CHARS_MIN));
    const hi = typingDelayMs('x'.repeat(BOT_TYPE_CHARS_MAX)) + SPEAK_JITTER_MS;

    for (let i = 0; i < 200; i += 1) {
      const bot = walkingBot(t0);
      scheduleSpeech(bot, null, t0, readDelayMs());
      expect(bot.speakAt - bot.typeAt).toBeGreaterThanOrEqual(lo);
      expect(bot.speakAt - bot.typeAt).toBeLessThan(hi);
    }
  });

  it('읽는 동안에는 걷는다 — 딴짓 12초를 서서 보내면 정반대다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    const x0 = bot.x;

    scheduleSpeech(bot, '아 미안 딴거 보고 있었어', t0, 10_000); // 딴짓한 판
    run(bot, t0, 50); // 5초 — 아직 읽는(딴짓하는) 중이다

    expect(bot.anim).toBe('walk');
    expect(bot.x).toBeGreaterThan(x0);
  });
});

describe('hasContent — 알맹이 없는 말에는 대꾸하지 않는다', () => {
  /*
   * 신고: 사람이 "ㅋㅋ"만 쳤는데 봇이 "저도요."라고 답했다.
   * 답할 내용이 없는 자리에 자리를 잡으니 모델이 무에서 문장을 지어낸다
   * (실측 4/4: "ㅋㅋ" → "안녕하세요."). room-do.ts의 reactToHuman이 이걸로 돌아선다.
   */
  it('웃음·초성체·기호만 있으면 알맹이가 없다', () => {
    for (const text of ['ㅋㅋ', 'ㅋㅋㅋㅋㅋ', 'ㅎㅎ', 'ㅠㅠ', 'ㅇㅇ', 'ㄴㄴ', 'ㄹㅇ', '!!', '???', '...', '~', '👍', '  ', '']) {
      expect(hasContent(text), text).toBe(false);
    }
  });

  it('완성형 음절이 하나라도 있으면 답할 거리가 있다', () => {
    for (const text of ['왜', '밥', '어제 뭐먹음', '나도', '헐 진짜?']) {
      expect(hasContent(text), text).toBe(true);
    }
  });

  it('웃음이 섞였다고 막지 않는다 — 진짜 질문을 씹으면 그게 더 이상하다', () => {
    expect(hasContent('ㅋㅋ 왜')).toBe(true);
    expect(hasContent('ㅇㅇ 아까 먹음')).toBe(true);
  });

  it('영문·숫자도 알맹이로 센다', () => {
    expect(hasContent('ok')).toBe(true);
    expect(hasContent('3')).toBe(true);
  });
});
