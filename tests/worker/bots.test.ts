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
  MOVE_THROTTLE_MS,
  SPEAK_JITTER_MS,
} from '../../lib/mp/constants';
import { typingDelayMs } from '../../lib/agent/disguise';

const SEED = { id: 'bot-1', seat: 2, nickname: '익명2', maskId: 'mask-02' };

/** 서 있는 시간·목적지를 못 박은 봇. createBot 은 랜덤을 쓰므로 뒤에서 덮어쓴다. */
function walkingBot(now: number): BotState {
  const bot = createBot(SEED, 5, now, { id: SEED.id, x: 0, z: 0, heading: 0 });
  bot.waitUntil = 0; // 바로 걷는다
  bot.tx = 8; // 한참 먼 목적지 — 테스트 동안 도착하지 않는다
  bot.tz = 0;
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

describe('발화 예약', () => {
  it('예약하면 그 자리에 선다 — 사람은 타이핑 중 발이 묶인다 (I1)', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);

    run(bot, t0, 3);
    expect(bot.anim).toBe('walk');
    expect(bot.x).toBeGreaterThan(0);

    const x = bot.x;
    scheduleSpeech(bot, '다들 조용하네', t0 + 300);
    run(bot, t0 + 300, 10);

    expect(bot.anim).toBe('idle');
    expect(bot.x).toBe(x);
    expect(bot.z).toBe(0);
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
    expect(bot.speakAt).toBeGreaterThanOrEqual(t0 + typingDelayMs(text));
    expect(bot.speakAt).toBeLessThan(t0 + typingDelayMs(text) + SPEAK_JITTER_MS);

    expect(takeSpeech(bot, bot.speakAt - 1)).toBeNull();
    expect(takeSpeech(bot, bot.speakAt)).toBe(text);
    expect(takeSpeech(bot, bot.speakAt + 10_000)).toBeNull();
  });

  it('긴 문장일수록 오래 서 있는다', () => {
    const t0 = 1_000_000;
    const short = walkingBot(t0);
    const long = walkingBot(t0);

    scheduleSpeech(short, 'ㅇㅇ', t0);
    scheduleSpeech(long, '아까부터 저쪽이 계속 수상했는데 다들 왜 아무 말도 안 해', t0);

    // 지터가 겹칠 수 없을 만큼 길이 차가 크다
    expect(long.speakAt).toBeGreaterThan(short.speakAt + SPEAK_JITTER_MS);
  });

  it('말하고 나면 가던 길을 이어서 간다 — 목적지가 초기화되지 않는다', () => {
    const t0 = 1_000_000;
    const bot = walkingBot(t0);

    run(bot, t0, 3);
    const x = bot.x;

    scheduleSpeech(bot, '나는 아닌 것 같은데', t0 + 300);
    const after = run(bot, t0 + 300, 30);
    takeSpeech(bot, after);

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

    expect(now.typeAt).toBe(t0);
    expect(later.typeAt).toBe(t0 + 2_000);
    expect(later.speakAt - now.speakAt).toBeGreaterThan(2_000 - SPEAK_JITTER_MS);
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
