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
  BOT_REACT_COOLDOWN_MS,
  BOT_TYPE_CHARS_MAX,
  BOT_TYPE_CHARS_MIN,
  LOUNGE_TYPE_MAX_MS,
  MOVE_THROTTLE_MS,
  SPEAK_JITTER_MS,
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
  bot.speed = 2;
  return bot;
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

  it('가구를 뚫고 지나가지 않는다', () => {
    const t0 = 1_000_000;
    const bot = createBot(SEED, 5, t0, { id: SEED.id, x: SOFA.x, z: SOFA.z - 2.5, heading: 0 });
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
    const bot = createBot(SEED, 5, t0, { id: SEED.id, x: SOFA.x, z: SOFA.z - 2.5, heading: 0 });
    bot.waitUntil = 0;
    bot.speed = 2.5;
    bot.tx = SOFA.x;
    bot.tz = SOFA.z + 2.5;

    run(bot, t0, 200); // 20초 — STUCK_MS(2.5초)를 한참 넘긴다
    expect([bot.tx, bot.tz]).not.toEqual([SOFA.x, SOFA.z + 2.5]);
  });

  it("가구에 눌려 못 가면 'walk' 로 제자리걸음하지 않는다", () => {
    const t0 = 1_000_000;
    const bot = createBot(SEED, 5, t0, { id: SEED.id, x: SOFA.x, z: SOFA.z - 1.1, heading: 0 });
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
      if (bot.anim === 'walk' && moved < 0.01) walkedInPlace += 1;
    }
    expect(walkedInPlace).toBe(0);
  });

  it('걷는 방향과 보는 방향이 크게 어긋나지 않는다 — 옆걸음처럼 보이면 안 된다', () => {
    const t0 = 1_000_000;
    // 소파를 비스듬히 지나가게 해서 미끄러지는 구간을 만든다
    const bot = createBot(SEED, 5, t0, { id: SEED.id, x: SOFA.x - 3, z: SOFA.z - 1.4, heading: 0 });
    bot.waitUntil = 0;
    bot.speed = 2.5;
    bot.tx = SOFA.x + 3;
    bot.tz = SOFA.z + 1.4;

    let now = t0;
    const diffs: number[] = [];
    for (let i = 0; i < 120; i += 1) {
      const before = { x: bot.x, z: bot.z };
      now += MOVE_THROTTLE_MS;
      stepBot(bot, now, MOVE_THROTTLE_MS / 1000);
      const mx = bot.x - before.x;
      const mz = bot.z - before.z;
      if (bot.anim !== 'walk' || Math.hypot(mx, mz) < 0.05) continue;

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
  /** 확률이 끼므로 여러 번 돌려 본다. p=0.45 · 200회면 양쪽 다 사실상 확실하다. */
  function tally(make: () => BotState[], now: number, n = 200) {
    let hit = 0;
    let miss = 0;
    for (let i = 0; i < n; i += 1) {
      if (pickResponder(make(), now) === null) miss += 1;
      else hit += 1;
    }
    return { hit, miss };
  }

  it('항상 반응하지는 않는다 — 반응률 자체가 표식이다 (I1)', () => {
    const t0 = 1_000_000;
    const { hit, miss } = tally(() => [walkingBot(t0)], t0);
    expect(hit).toBeGreaterThan(0);
    expect(miss).toBeGreaterThan(0);
  });

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

  it('고른 봇에 쿨다운을 걸고 자발 발화도 미룬다', () => {
    const t0 = 1_000_000;
    const bots = [walkingBot(t0)];
    bots[0].nextChatAt = t0 + 100; // 곧 혼잣말할 참이었다

    let picked: BotState | null = null;
    for (let i = 0; i < 200 && !picked; i += 1) picked = pickResponder(bots, t0);
    expect(picked).not.toBeNull();

    expect(picked!.nextReactAt).toBe(t0 + BOT_REACT_COOLDOWN_MS);
    expect(picked!.nextChatAt).toBeGreaterThan(t0 + 100);
  });

  it('봇이 없으면 null', () => {
    expect(pickResponder([], 1_000_000)).toBeNull();
  });

  it('동행자 모드는 훨씬 잘 대꾸한다 — 숨길 게 없는 방이다', () => {
    const t0 = 1_000_000;
    const game = tally(() => [walkingBot(t0)], t0);
    let companionHit = 0;
    for (let i = 0; i < 200; i += 1) {
      if (pickResponder([walkingBot(t0)], t0, true) !== null) companionHit += 1;
    }
    expect(companionHit).toBeGreaterThan(game.hit);
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

  it('확률을 갈아끼워도 쿨다운·예약 규칙은 그대로다', () => {
    const t0 = 1_000_000;
    const held = walkingBot(t0);
    scheduleSpeech(held, null, t0);
    expect(pickResponder([held], t0, true, 1)).toBeNull();

    const cooling = walkingBot(t0);
    cooling.nextReactAt = t0 + 10_000;
    expect(pickResponder([cooling], t0, true, 1)).toBeNull();
  });

  it('동행자 모드의 쿨다운이 게임보다 짧다', () => {
    const t0 = 1_000_000;
    const pick = (companion: boolean) => {
      for (let i = 0; i < 400; i += 1) {
        const bots = [walkingBot(t0)];
        const got = pickResponder(bots, t0, companion);
        if (got) return got.nextReactAt - t0;
      }
      throw new Error('한 번도 안 뽑혔다');
    };
    expect(pick(true)).toBeLessThan(pick(false));
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
