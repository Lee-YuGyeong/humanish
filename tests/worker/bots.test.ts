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
  pickLine,
  pickResponder,
  readDelayMs,
  replaceSpeech,
  scheduleSpeech,
  shouldChat,
  stepBot,
  takeSpeech,
  type BotState,
} from '../../worker/src/bots';
import {
  BOT_READ_MAX_MS,
  BOT_READ_MIN_MS,
  BOT_REACT_COOLDOWN_MS,
  BOT_TYPE_CHARS_MAX,
  BOT_TYPE_CHARS_MIN,
  MOVE_THROTTLE_MS,
  SPEAK_JITTER_MS,
} from '../../lib/mp/constants';
import { COLLIDERS, isBlocked } from '../../lib/mp/collide';
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
      // 봇은 낮은 탁자에도 안 올라선다 → stepUp = 0 으로 본다
      expect(isBlocked(bot.x, bot.z, 0, 0)).toBe(false);
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
    expect(isBlocked(bot.x, bot.z, 0, 0)).toBe(false);
  });

  it('목적지를 가구 안에 잡지 않는다', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 100; i += 1) {
      const bot = createBot(SEED, 5, t0);
      expect(isBlocked(bot.tx, bot.tz, 0, 0)).toBe(false);
    }
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

  it('읽는 시간은 상수 범위 안이다', () => {
    for (let i = 0; i < 50; i += 1) {
      const d = readDelayMs();
      expect(d).toBeGreaterThanOrEqual(BOT_READ_MIN_MS);
      expect(d).toBeLessThanOrEqual(BOT_READ_MAX_MS);
    }
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
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(pickLine(POOL, []));
    expect(seen.size).toBe(POOL.length);
  });
});

describe('shouldChat', () => {
  it('때가 되면 true, 그 뒤로는 다시 잠긴다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    bot.nextChatAt = t0;

    expect(shouldChat(bot, t0)).toBe(true);
    expect(shouldChat(bot, t0)).toBe(false);
    expect(bot.nextChatAt).toBeGreaterThan(t0);
  });

  it('이미 치는 중이면 겹쳐 예약하지 않는다 — 사람도 한 번에 한 줄만 친다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);
    bot.nextChatAt = 0;

    scheduleSpeech(bot, '방금 뭐라고 했어?', t0);
    expect(shouldChat(bot, t0 + 60_000)).toBe(false);

    takeSpeech(bot, bot.speakAt);
    expect(shouldChat(bot, t0 + 60_000)).toBe(true);
  });
});
