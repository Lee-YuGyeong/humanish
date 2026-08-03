/**
 * 타이핑 지연 · 말투 관측. 소유: B (SPEC §2)
 *
 * 지연은 setTimeout으로 기다리는 게 아니라 visible_at에 시각으로 박는다.
 * 서버 함수가 6초를 기다릴 수 없기 때문이다 (SPEC §5.3).
 *
 * 여기 함수는 전부 순수(랜덤 없음)로 둔다 — 지터는 쓰는 쪽(generate)이 얹는다.
 * 그래야 그대로 테스트된다.
 */

/** 관측된 인간 말투. 봇이 방 분위기에 맞추는 근거. */
export interface StyleProfile {
  /** 평균 글자 수. */
  avgLength: number;
  /** 자주 쓰인 종결·감탄 표현. */
  markers: string[];
  /** 오타 빈도 0~1. */
  typoRate: number;
}

/** 아무도 말 안 한 방의 기본값 — 짧고 건조한 한국어 채팅 평균치. */
export const DEFAULT_STYLE: StyleProfile = {
  avgLength: 12,
  markers: ['ㅋㅋ'],
  typoRate: 0.2,
};

const MARKER_CANDIDATES = ['ㅋㅋ', 'ㅎㅎ', 'ㅠㅠ', 'ㄹㅇ', ';;', '~', '...', '!', '?'] as const;

/** 사람 메시지에서 StyleProfile을 뽑는다. */
export function observeStyle(texts: string[]): StyleProfile {
  if (texts.length === 0) return DEFAULT_STYLE;

  const avgLength = Math.round(
    texts.reduce((sum, t) => sum + t.length, 0) / texts.length,
  );

  const markers = MARKER_CANDIDATES.map((m) => ({
    m,
    n: texts.filter((t) => t.includes(m)).length,
  }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 3)
    .map((x) => x.m);

  // 초성체(ㄹㅇ, ㅇㅋ 같은 자모 덩어리)를 오타·대충 침의 근사치로 센다.
  // 웃음(ㅋㅎ)과 울음(ㅠㅜ)은 오타가 아니므로 걷어내고 잰다.
  const typo =
    texts.filter((t) => /[ㄱ-ㅎㅏ-ㅣ]{2,}/.test(t.replace(/[ㅋㅎㅠㅜ]/g, ''))).length /
    texts.length;

  return { avgLength, markers, typoRate: Math.min(1, typo) };
}

// ── 오타 ────────────────────────────────────────────────────────────────────
/*
 * ┌─ 왜 오타를 모델한테 안 시키고 코드로 넣는가 ───────────────────────────────┐
 * │ "오타가 가끔 나고 고치지 않는다"를 인물 프롬프트에 넣어 뒀었는데, 8b 가 실제로 │
 * │ 낸 건 이랬다 (실측): "스클린 켜서", "야요 어제 점심에", "민준야!".            │
 * │ 이건 빨리 친 사람의 오타가 아니라 **한국어가 서툰 사람**으로 읽힌다 — 오히려   │
 * │ 봇 티가 커진다. 그래서 발화는 멀쩡하게 받고, 오타는 여기서 얹는다.            │
 * │                                                                            │
 * │ 비율은 **방에 맞춘다**(style.typoRate). 봇만 늘 15% 로 틀리고 사람들은 3% 면   │
 * │ 그게 거꾸로 봇 지문이 된다 (I1). observeStyle 이 그 값을 재 두고도 여태 아무도 │
 * │ 안 쓰고 있었다.                                                             │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

/**
 * 오타를 낼 확률의 상·하한. 방이 아무리 깨끗해도 아주 가끔은 틀리고, 아무리 험해도
 * 넷 중 하나꼴을 넘지 않는다.
 *
 * ★ 오타가 많다 싶으면 **여기만** 내린다. 비율 자체는 방을 따라가야 하므로
 *   (styleProfile.typoRate — 봇만 유난히 많이/적게 틀리면 그게 지문이다, I1)
 *   호출부에서 끄지 말고 이 상한으로 조인다.
 */
const TYPO_MIN = 0.04;
const TYPO_MAX = 0.22;

const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;
/**
 * 종성 표에서 ㅆ 의 자리. 한 글자는 `0xAC00 + 초성×588 + 중성×21칸 + 종성` 이고
 * 종성 표는 ㅅ(19) 바로 뒤가 ㅆ(20) 이다 — 그래서 **코드포인트에서 1만 빼면**
 * "있"이 "잇"이 된다. 다른 글자로 샐 길이 없다.
 */
const JONG_SSANG_SIOT = 20;

/**
 * 발화에 오타를 얹는다. 순수 함수다 — 난수는 rand로 받는다 (이 파일의 규약).
 *
 * 두 가지뿐이고, 둘 다 **읽는 데 지장이 없다**는 게 고르는 기준이다.
 *   ① 띄어쓰기 붙이기        "밥 먹었어" → "밥먹었어"
 *   ② 쌍시옷 받침 흘리기      "있어" → "잇어",  "먹었어" → "먹엇어"
 *
 * ┌─ 자판 인접키 오타를 왜 뺐나 ───────────────────────────────────────────────┐
 * │ 두벌식에서 옆 키를 누른 것처럼 자모를 바꾸는 코드가 있었다. 낱말 첫 글자를    │
 * │ 피하고 대부분 정정 줄까지 붙였는데도 **읽는 사람에게는 그냥 글이 깨진 것**으로│
 * │ 보였다 ("있오", "먹옸는데", "나더"). 사람의 오타는 본인은 알아도 남이 볼 땐   │
 * │ 거슬리고, 봇이 내면 "사람 같다"가 아니라 "얘 왜 이래"가 된다.               │
 * │                                                                            │
 * │ 위 둘은 다르다. 아무 글자도 깨지지 않는다 — ①은 공백만 빼고, ②는 받침 하나를 │
 * │ 홑으로 만들 뿐이라 "잇어"를 못 읽는 사람이 없다. 새 오타를 더할 때도 이 기준을 │
 * │ 먼저 볼 것: **남이 읽다가 걸리면 그건 사람다움이 아니다.**                    │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * 한 발화에 오타는 최대 하나다. 짧은 채팅 한 줄에서 두 번 틀리면 그건 대충 친 게
 * 아니라 그냥 맞춤법을 모르는 사람이 된다. 후보를 다 모아 놓고 하나만 고르므로,
 * 고칠 자리가 많은 문장일수록 그 자리들이 고르게 뽑힌다.
 */
export function applyTypo(text: string, style: StyleProfile, rand: () => number): string {
  const chance = Math.min(TYPO_MAX, Math.max(TYPO_MIN, style.typoRate));
  if (text.length < 3 || rand() >= chance) return text;

  const swap = (at: number, to: string) => text.slice(0, at) + to + text.slice(at + 1);
  const ops: (() => string)[] = [];

  for (let i = 0; i < text.length; i += 1) {
    // ① 띄어쓰기 붙이기
    if (text[i] === ' ') {
      ops.push(() => swap(i, ''));
      continue;
    }
    // ② 쌍시옷 받침 흘리기 — ㅆ 받침인 글자만
    const cp = text.charCodeAt(i);
    if (cp >= HANGUL_BASE && cp <= HANGUL_LAST && (cp - HANGUL_BASE) % 28 === JONG_SSANG_SIOT) {
      ops.push(() => swap(i, String.fromCharCode(cp - 1)));
    }
  }

  if (ops.length === 0) return text;
  return ops[Math.floor(rand() * ops.length)]();
}

// ── 웃음 ────────────────────────────────────────────────────────────────────
/*
 * ┌─ 왜 웃음 길이를 코드에서 흔드는가 ────────────────────────────────────────┐
 * │ 인물 프롬프트가 "웃음은 ㅋㅋ만 쓴다"라고 못 박아 두는데(world-persona.ts의    │
 * │ 지문 표), 8b 는 그걸 **글자 수까지 그대로** 지킨다 — 매번 정확히 두 글자다.  │
 * │ 사람은 그러지 않는다. 같은 사람이 ㅋ 하나로 툭 던지기도 하고 ㅋㅋㅋㅋㅋ까지   │
 * │ 늘리기도 한다. 늘 같은 길이로 웃는 자리는 세어 보면 드러난다 (I1).          │
 * │                                                                            │
 * │ 오타(applyTypo)와 같은 자리에서 같은 규약으로 얹는다 — 발화는 멀쩡하게 받고, │
 * │ 사람다움은 후처리로. 프롬프트에 "가끔 길게 웃어라"를 넣으면 8b 는 그것마저    │
 * │ 매번 똑같이 지킨다.                                                        │
 * │                                                                            │
 * │ ★ 없던 웃음을 만들지 않는다. 이미 있는 웃음의 길이만 바꾼다 — 웃음 표기는    │
 * │   인물을 가르는 지문이라(ㅋㅋ=easy · ㅎㅎ=warm · 나머지는 없음), 없는 자리에  │
 * │   끼워 넣으면 인물이 뭉개진다.                                             │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

/**
 * 웃음 표기 성향. 인물마다 다르다 (persona.ts의 `Persona.laugh`).
 *
 * 이 값이 **없는 인물 = 웃음을 안 쓰는 인물**이고, stretchLaugh는 손대지 않는다.
 * 두 글자를 섞는 인물은 두지 않는다 — 그 자체가 인물을 가르는 지문이다.
 */
export interface LaughStyle {
  /** 이 인물이 쓰는 웃음 글자. */
  ch: 'ㅋ' | 'ㅎ';
  /** 평소 길이. 인물 프롬프트가 적어 둔 것과 같아야 한다. */
  base: number;
  /** 제일 신났을 때 길이. base와 같으면 늘어나지 않는다. */
  max: number;
}

/** 이 확률 아래면 한 글자로 툭 던진다 ("ㅋ"). */
const LAUGH_SHORT = 0.2;
/** 여기까지는 평소 길이 그대로 — 대부분의 발화는 안 바뀐다. */
const LAUGH_BASE = 0.7;

/** 이번 웃음의 길이를 고른다. base에 몰리고 양쪽으로 조금씩 흩어진다. */
function laughLength(laugh: LaughStyle, rand: () => number): number {
  const r = rand();
  if (r < LAUGH_SHORT) return 1;
  if (r < LAUGH_BASE) return laugh.base;
  const span = laugh.max - laugh.base;
  if (span <= 0) return laugh.base;
  return laugh.base + 1 + Math.floor(rand() * span);
}

/**
 * 발화 안의 웃음 하나를 골라 길이를 다시 뽑는다. 순수 함수다 — 난수는 rand로 받는다.
 *
 * 인물이 쓰는 글자(laugh.ch)가 이어진 자리만 후보다. **한 발화에 하나만** 바꾼다 —
 * applyTypo와 같은 이유로, 한 줄에서 두 번 흔들면 그건 사람이 아니라 고장 난 것으로
 * 읽힌다. laugh가 없으면(웃음을 안 쓰는 인물) 원문 그대로다.
 */
export function stretchLaugh(
  text: string,
  laugh: LaughStyle | undefined,
  rand: () => number,
): string {
  if (!laugh) return text;

  // 이어진 웃음 덩어리를 전부 모은다. "ㅋㅋ 뭐야 ㅋㅋ"면 후보가 둘이다.
  const runs: { at: number; len: number }[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== laugh.ch) continue;
    let len = 1;
    while (i + len < text.length && text[i + len] === laugh.ch) len += 1;
    runs.push({ at: i, len });
    i += len - 1;
  }
  if (runs.length === 0) return text;

  const run = runs[Math.floor(rand() * runs.length)];
  const len = laughLength(laugh, rand);
  if (len === run.len) return text;
  return text.slice(0, run.at) + laugh.ch.repeat(len) + text.slice(run.at + run.len);
}

/**
 * 인물이 안 쓰기로 한 문장부호를 걷어낸다 (persona.avoidPunct).
 *
 * ┌─ 왜 프롬프트로 안 끝나는가 ───────────────────────────────────────────────┐
 * │ 실측: 느낌표를 금지한 인물이 "안녕하세요!"로 인사했다. 8b는 인사·감탄 자리   │
 * │ 에서 금칙을 자주 놓친다. 부호 하나가 새면 그 인물이 다른 인물과 안 갈리고,   │
 * │ 지문 표가 인물을 가르는 방식이라 인물이 뭉개지면 자리도 같이 묶인다 (I1).    │
 * │                                                                            │
 * │ ★ 지우는 건 부호뿐이다. 자모(ㅋㅋ·ㅠㅠ)를 지우면 "그러네 ㅎㅎ"가 "그러네"로  │
 * │   남아 사람이 안 치는 모양이 된다 — 그건 프롬프트가 할 일이다.              │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * 부호를 뺀 자리에 생긴 겹공백은 정리한다. 순수 함수다 — 난수를 쓰지 않는다.
 */
export function stripAvoidedPunct(text: string, avoid: readonly string[] | undefined): string {
  if (!avoid || avoid.length === 0) return text;
  let t = text;
  for (const ch of avoid) t = t.split(ch).join('');
  return t.replace(/\s+/g, ' ').trim();
}

// ── 어체 ────────────────────────────────────────────────────────────────────
/*
 * ┌─ 왜 어체를 프롬프트로 못 끝내는가 ─────────────────────────────────────────┐
 * │ 인물마다 어체가 이미 적혀 있고("반말", "절대 안 쓰는 것: 존댓말"),           │
 * │ generate.ts 의 CONDUCT_RULES 에도 못 박혀 있다. 그런데도 **누가 질문을        │
 * │ 던지는 순간** 무너진다.                                                     │
 * │                                                                            │
 * │ 실측 — "너 어디 살아?" 한 마디에 반말 인물들이 한꺼번에:                     │
 * │   지호 "창고에서 살고 있어요"  · 민준 "평일은 대학교에 다니고 주말에 집에    │
 * │   있어요" · 현수 "아주 멀리서 살고 있어요. 서울입니다"                       │
 * │ 스스로 말을 꺼낼 때는 멀쩡히 반말이다. 즉 인물 설명이 약한 게 아니라, 8b 가   │
 * │ **답하는 자세**로 들어가면 존댓말이 딸려 온다. 프롬프트 두 겹으로 막아 봤고   │
 * │ 뚫렸다 — 그래서 그물을 건다 (stripAvoidedPunct 와 같은 이유·같은 자리).      │
 * │                                                                            │
 * │ 어체가 섞이면 그 자리가 그대로 드러난다 (I1). 이 방 사람들은 한 어체로       │
 * │ 끝까지 가는데 한 자리만 문장마다 갈리면, 그게 곧 표식이다.                   │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

/** 이 인물이 쓰는 어체. 반말이 기본이다 (인물 대부분이 반말이다). */
export type Speech = 'casual' | 'polite';

/**
 * 종결 '요'를 뗄 수 있는 앞 글자. **아무 '요'나 떼면 안 된다** —
 * "필요"·"중요"가 "필"·"중"이 된다. 실제 어미 뒤에 붙은 '요'만 본다.
 */
const POLITE_TAIL_STEM = '어아여에데네군구지고나까래워와려러으라봐해돼게';

/**
 * 존댓말 발화를 반말로 되돌린다. 반말 인물에게만 쓴다.
 *
 * 버리지 않고 **고쳐 쓰는** 이유: 이 자리에서 버리면 월드에서는 곧 침묵인데
 * (world-agent 가 폴백을 거른다), 질문에 답할 때마다 새는 문제라 답의 절반이
 * 통째로 사라진다. 늘 받기만 하고 답을 안 하는 자리가 되면 그게 더 큰 표식이다.
 *
 * 순수 함수다 — 난수를 쓰지 않는다.
 */
export function toCasual(text: string): string {
  return (
    text
      // 1인칭부터. "저한테 뭘 묻고 있어?"처럼 대명사만 존대로 남는 게 제일 흔하다.
      .replace(/저희/g, '우리')
      .replace(/제가/g, '내가')
      .replace(/저는/g, '나는')
      .replace(/저도/g, '나도')
      .replace(/저한테/g, '나한테')
      .replace(/저에게/g, '나한테')
      .replace(/저를/g, '나를')
      .replace(/저랑/g, '나랑')
      /*
       * ★ 존대 인사 관용구를 **통째로** 바꾼다. 어미 규칙으로는 안 되는 자리다.
       *
       *   아래 '요' 떼기는 '세'를 건드리지 않는다 — "하세요"에서 요만 떼면 "하세"라는
       *   말이 안 되는 게 남기 때문이다. 그런데 인사말은 거의 전부 하세요체라,
       *   그물에 인사 크기의 구멍이 뚫려 있었다.
       *
       *   실측 — 반말 인물들이 인사 자리에서만 존댓말로 튀었다:
       *     지호 "안녕하세요 쫀쫀해" · 재영 "어서 오셨어" · 현수 "안녕하셨어?"
       *     도영(3~8자 초성체) "어서오세요"
       *   스스로 말할 때나 답할 때는 멀쩡한 반말이다. 인사만 그렇다.
       */
      /*
       * 8b 는 이 인사를 온갖 모양으로 낸다 (전부 실측):
       *   안녕하세요 · 안녕하세용 · 안녕하세여 · 안녕하세 · 안녕해요 · 안녕해
       * 반말 인물에게는 전부 "안녕" 하나면 된다.
       * ★ 긴 것부터 적는다 — "하세"를 앞에 두면 "하세요"가 "안녕요"가 된다.
       */
      .replace(/안녕(하세요|하세용|하세여|하셨어요|하셨어|하십니까|하시죠|하세|해요|해|하요)/g, '안녕')
      .replace(/반갑습니다|반가워요|반갑네요/g, '반가워')
      .replace(/고맙습니다|고마워요/g, '고마워')
      // 격식체(하십시오체) — 해요체보다 먼저 본다
      .replace(/입니다/g, '이야')
      .replace(/합니다/g, '해')
      .replace(/습니다/g, '어')
      // 해요체 지정사. '요'를 떼기 전에 처리한다 — 안 그러면 "이에요"가 "이에"로 남는다
      .replace(/이에요|이예요/g, '이야')
      .replace(/([가-힣])예요/g, '$1야')
      .replace(/에요/g, '야')
      .replace(/그쵸/g, '그치')
      .replace(/죠(?=[\s.,!?~…]|$)/g, '지')
      // 종결 '요'
      .replace(new RegExp(`([${POLITE_TAIL_STEM}])요(?=[\\s.,!?~…]|$)`, 'g'), '$1')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * 반말 발화를 존댓말로 올린다. 존댓말 인물에게만 쓴다.
 *
 * ★ toCasual 보다 **덜 건드린다.** 반말→존댓말은 어미를 만들어 붙이는 일이라
 *   틀리면 없는 말이 된다 ("누가" → "누가요"). 확실한 어미만 올리고 나머지는
 *   그대로 둔다 — 어색한 한 줄보다 안 고친 한 줄이 낫다.
 *
 * 순수 함수다 — 난수를 쓰지 않는다.
 */
export function toPolite(text: string): string {
  return (
    text
      .replace(/내가/g, '제가')
      .replace(/나는/g, '저는')
      .replace(/나도/g, '저도')
      .replace(/나한테/g, '저한테')
      .replace(/나를/g, '저를')
      .replace(/나랑/g, '저랑')
      /*
       * ★ 어미는 **문장 맨 끝에서만** 올린다. toCasual 과 다른 점이고, 여기가
       *   틀리기 쉬운 자리다 — 띄어쓰기 앞까지 어미로 보면 연결어미를 종결어미로
       *   오인한다 (검사에 걸린 실패: "그랬는지 몰라" → "그랬는죠 몰라").
       *   '요'를 떼는 건 어디서 해도 안전하지만, 붙이는 건 끝에서만 안전하다.
       *
       * ★ '가'·'다'·'냐'·'지'는 아예 손대지 않는다. "누가"·"많다"·"그랬는지"처럼
       *   어미가 아닌 자리가 섞여 있어서, 맞히는 것보다 망치는 게 많다.
       */
      // 존댓말 인물이 반말 인사에 요만 붙여 만든 말 — "안녕요"는 없는 말이다
      .replace(/안녕요/g, '안녕하세요')
      .replace(/이야([\s.,!?~…]*)$/, '이에요$1')
      .replace(/([가-힣])야([\s.,!?~…]*)$/, '$1예요$2')
      .replace(/([어아해봐와네데라])([\s.,!?~…]*)$/, '$1요$2')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * 인물의 어체에 맞춘다. 양쪽 다 본다 — 반말 인물이 존댓말로 답하는 것도,
 * 존댓말 인물이 반말로 답하는 것도 같은 표식이다 (I1).
 */
export function enforceSpeech(text: string, speech: Speech | undefined): string {
  return speech === 'polite' ? toPolite(text) : toCasual(text);
}

/** 즉답(0ms)은 그 자체로 봇 신호다 (I1). 사람은 읽고 생각하고 친다. */
export const MIN_TYPING_MS = 900;
/** 페이즈가 30초라 이 이상 끌면 발화가 페이즈 밖으로 밀린다 (SPEC §5). */
export const MAX_TYPING_MS = 6_500;

/** 글자 수를 반영한 타이핑 지연(ms). 결정적이다 — 지터는 호출자가 얹는다. */
export function typingDelayMs(text: string): number {
  return Math.min(MAX_TYPING_MS, MIN_TYPING_MS + text.length * 55);
}
