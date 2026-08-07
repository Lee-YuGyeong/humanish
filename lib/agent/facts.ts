/**
 * 인물이 그 판에서 **지어낸 사실**의 누적 (factSheet). 순수 함수만.
 *
 * ┌─ 왜 필요한가 ─────────────────────────────────────────────────────────────┐
 * │ 대화 기록은 창(window)이라 밀려나고, 무엇보다 **매 턴이 서로 독립이다.**     │
 * │ 그래서 같은 인물에게 같은 질문을 두 번 하면 다른 답이 나온다.               │
 * │                                                                            │
 * │ 실측 — 지호에게 "너 어디 살아?"를 세 번:                                    │
 * │   "인천서구로 살고 있어" / "서울 서초구에 살고 있어" / "인천 살고있어"       │
 * │ 현수도 부산 → 서울 서초구 → 서울 남부로 옮겨 다녔다.                        │
 * │                                                                            │
 * │ 사람은 이걸 절대 안 틀린다. 심문자는 정확히 이걸 노린다 —                   │
 * │ "아까 몇 살이랬지", "무슨 색 소파랬지". 창이 밀려나길 기다릴 것도 없이       │
 * │ **연달아 두 번만 물으면 걸린다.** 이 파일이 그걸 막는다.                    │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ ★ 이 값은 모델 출력에서 온다 — 시스템 프롬프트로 되돌아간다 (SPEC §9.1) ──┐
 * │ 사람 발화 → 모델 → facts → **다음 턴의 시스템 프롬프트**. 이 고리는 참가자   │
 * │ 발화를 신뢰 구역으로 실어 나르는 길이 될 수 있다. 그래서 여기서 좁게 거른다: │
 * │   · 한 줄, 짧게 (개행 없음 · MAX_FACT_LEN)                                  │
 * │   · "키: 값" 모양만 — 문장이 아니라 **항목**이라 지시가 들어설 자리가 없다   │
 * │   · 정체 자백 낱말(generate.ts의 IDENTITY_LEAK)과 지시문투는 통째로 버린다   │
 * │ 거르지 못한 건 남기지 않는다 — 사실 하나 잃는 쪽이 프롬프트가 뚫리는 것보다  │
 * │ 싸다.                                                                       │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

/**
 * 한 인물이 들고 다니는 사실의 최대 개수.
 *
 * 8b는 시스템 프롬프트가 길어지면 정작 시킨 일을 놓친다 (generate.ts의 실측들).
 * 한 판에서 심문자가 되짚을 만한 항목은 그리 많지 않다 — 사는 곳 · 나이 · 방금 먹은 것
 * 정도다. 넘치면 **오래된 것부터가 아니라 새 것을 버린다**: 먼저 말한 사실일수록
 * 이미 남들이 기억하고 있어서, 뒤집혔을 때 더 크게 걸린다.
 */
export const MAX_FACTS = 12;

/**
 * 사실 한 줄의 길이 상한.
 *
 * 발화 상한(world-agent의 MAX_REPLY_LEN = 42)에 항목 이름을 붙일 만큼은 돼야 한다 —
 * pinFact가 봇이 실제로 한 답을 통째로 값에 넣기 때문이다.
 */
export const MAX_FACT_LEN = 60;

/**
 * 지시문으로 읽히는 낱말. 이게 든 "사실"은 사실이 아니라 명령이다 —
 * 참가자 발화가 모델을 거쳐 시스템 프롬프트로 승격되는 길을 여기서 끊는다.
 */
const INSTRUCTION_LIKE =
  /(무시하|잊어|규칙|지침|시스템|프롬프트|하십시오|하세요|해라|해야\s*한다|출력하|답하라)/;

/** 정체 자백. generate.ts의 IDENTITY_LEAK과 같은 목록이다 — 여기로도 샐 수 있다. */
const IDENTITY_LEAK =
  /(인공\s*지능|언어\s*모델|어시스턴트|챗\s*봇|프롬프트|시스템\s*(메시지|명령)|봇\s*(이야|이다|입니다)|\bAI\b|\bLLM\b|\bGPT\b)/i;

/**
 * "키: 값"에서 키만. 병합이 이걸로 같은 항목을 알아본다.
 *
 * 콜론을 **요구하는** 것이 이 설계의 핵심이다. 자유 문장을 받으면
 * "인천 서구에 산다"와 "서울에 산다"가 서로 다른 항목이 되어 둘 다 남고,
 * 모순을 막으려던 게 모순을 쌓아 두는 통이 된다.
 */
export function factKey(fact: string): string {
  const i = fact.indexOf(':');
  if (i < 0) return '';
  const label = fact.slice(0, i).trim();
  if (label === '') return '';
  return foldLabel(label);
}

/** 공백·대소문자를 지운 비교용 모양. */
function flat(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase();
}

/**
 * 항목 이름을 주제 하나로 접는다.
 *
 * 모델이 제 마음대로 이름을 붙이기 때문이다 — 실측: 코드가 "먹은 것: …"을 박은 판에
 * 모델이 "식사: 치킨"을, "나이: …" 옆에 "나의 나이: 23"을 따로 얹었다. 이름만 다르고
 * 주제는 같아서, 접지 않으면 같은 질문에 두 답이 명단에 나란히 남는다 — 막으려던
 * 모순이 명단 안으로 들어온다.
 *
 * ★ TOPICS의 정규식은 **질문**을 겨냥해 쓴 것이라 이름에 그대로 대면 안 맞는다
 *   ("먹은 것"에는 "먹었"이 없다 — 검사에 걸렸다). 그래서 이름 일치를 먼저 본다.
 */
function foldLabel(label: string): string {
  const f = flat(label);
  for (const t of TOPICS) if (flat(t.label) === f) return t.label;
  for (const t of TOPICS) if (t.test.test(label)) return t.label;
  return f;
}

/**
 * 사실 한 줄을 받아들일 수 있는 모양으로. 못 쓰겠으면 null.
 * 자르지 않고 **버린다** — 잘린 사실은 다음 턴에 잘린 채로 말해진다.
 */
export function sanitizeFact(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length === 0 || t.length > MAX_FACT_LEN) return null;
  if (factKey(t) === '') return null;
  // 값이 비어 있으면 사실이 아니다 ("사는 곳:")
  if (t.slice(t.indexOf(':') + 1).trim() === '') return null;
  if (INSTRUCTION_LIKE.test(t) || IDENTITY_LEAK.test(t)) return null;
  return t;
}

/*
 * ┌─ 왜 모델이 낸 facts만으로는 안 되는가 (실측) ──────────────────────────────┐
 * │ 출력 형식에 "facts" 칸을 만들고 채우라고 시켜 봤다. 7턴 중 **1턴만** 채웠다. │
 * │ 그래서 "아까 어디 산다고 했지?"에 여전히 딴 답이 나왔다:                      │
 * │   Q 너 어디 살아?          A 서울에 살고                                     │
 * │   Q 아까 어디 산다고 했지?  A 오늘 산책 가서 약속 못 뵈서...                  │
 * │   Q 너 사는 데 어디랬더라   A 창고에 사는 데 살고 있어                        │
 * │                                                                            │
 * │ 8b 는 시킨 칸을 그냥 안 채운다 — 어체 규칙이 뚫린 것과 같은 성질이다          │
 * │ (disguise.ts 의 상자). 그래서 **모델 협조 없이 코드가 못 박는다**:            │
 * │ 질문의 주제를 알아보고, 그때 실제로 나간 답을 값으로 그대로 넣는다.           │
 * │                                                                            │
 * │ 모델이 낸 facts 도 계속 받는다 — 아래 표가 모르는 주제를 주워 오는 몫이다.    │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

/**
 * 심문자가 되짚는 주제. **처음 맞는 것이 이긴다** — 순서가 곧 우선순위다.
 *
 * 여기 없는 주제는 그냥 안 박힌다. 그게 맞는 실패다 — 엉뚱한 주제로 묶어서
 * "사는 곳: 김치찌개"를 만드는 것보다 안 박히는 편이 낫다. 늘리는 건 언제든 된다.
 */
const TOPICS: readonly { label: string; test: RegExp }[] = [
  // '어디 살' 이 '지금 어디' 보다 먼저다 — "너 지금 어디 살아?" 는 사는 곳이다
  // '산'까지 받는다 — "어디 산다고 했지?"가 되짚는 말투의 대표형이다 (검사에 걸렸다)
  { label: '사는 곳', test: /어디\s*(살|산|삽)|사는\s*(곳|데|지역)|어디\s*사(니|냐|세|는)|거주/ },
  { label: '나이', test: /몇\s*살|나이|연세|몇\s*년생/ },
  { label: '하는 일', test: /무슨\s*일|직업|일\s*해|회사|학교|전공|학년|알바|다니는/ },
  { label: '먹은 것', test: /뭐\s*먹|먹었|식사|점심|저녁|아침.*뭐|메뉴/ },
  { label: '지금 있는 곳', test: /지금\s*어디|어디\s*(야|니|냐|에요|예요)/ },
  /*
   * ★ '집 나선 시각'이 '지금 시각'보다 **먼저**다 (2026-08-07, 실측).
   *   월드 주제 풀에 "오늘 집을 나선 시각은 몇 시였어?"가 있는데(worker/src/roundtable.ts
   *   의 FACT_TOPICS), 그게 `/몇\s*시/` 에 걸려 **'지금 시각'으로 박혔다.** 그러면
   *   나중에 "지금 몇 시야?"에 봇이 아침에 집 나선 시각을 그대로 답하고, clock.ts 가
   *   넣어 준 진짜 시각과도 어긋난다 — 같은 방 사람이 보면 대놓고 앞뒤가 안 맞는다.
   *   '처음 맞는 것이 이긴다'는 이 표의 규칙을 그대로 쓴다 (위 상자).
   */
  { label: '집 나선 시각', test: /(집|회사|학교).{0,4}(나선|나갔|나온|나왔|출발)|등교|출근\s*(시간|시각)/ },
  { label: '잠든·깬 시각', test: /(잠든|잤|잠들|깬|일어난|기상).{0,4}(시각|시간|때)|몇\s*시에\s*(잤|잠|깼|일어)/ },
  { label: '지금 시각', test: /몇\s*시|무슨\s*요일|오늘\s*며칠|날짜/ },
  { label: '날씨', test: /날씨|비\s*와|더워|추워/ },
  { label: '취미', test: /취미|뭐\s*하고\s*놀|좋아하는|즐겨/ },
  { label: '반려동물', test: /강아지|고양이|반려|키우/ },
  { label: '가족', test: /형제|자매|가족|형\s*있|누나|동생|외동/ },
  { label: '입은 옷', test: /무슨\s*색|입고\s*있|옷/ },
  { label: '배터리', test: /배터리|퍼센트|몇\s*프로/ },
  { label: '알람', test: /알람|몇\s*시에\s*일어|기상/ },
];

/** 이 질문이 어느 주제인가. 모르면 null — 그러면 못 박지 않는다. */
export function topicOf(question: string | null | undefined): string | null {
  if (!question) return null;
  const q = question.trim();
  if (q === '') return null;
  for (const t of TOPICS) if (t.test.test(q)) return t.label;
  return null;
}

/**
 * 이 말이 **물음인가.**
 *
 * ┌─ 왜 필요한가 (2026-08-07, 실측) ──────────────────────────────────────────┐
 * │ pinFact 는 위 표에 걸리기만 하면 사실을 못 박는데, 표의 정규식은 낱말 단위라  │
 * │ **평서문에도 걸린다.** 월드에서 pinFact 에 들어오는 건 라운드 주제만이 아니라 │
 * │ 사람이 방금 친 아무 줄이다 (app/api/internal/world-agent 의 trigger).        │
 * │                                                                            │
 * │ 실측된 모양: 사람이 "나 지금 회사인데 너무 졸려" 라고 하면 '하는 일'에 걸리고, │
 * │ 봇이 거기에 "ㅇㅇ 힘내" 라고 대꾸한 게 **「하는 일: ㅇㅇ 힘내」로 박힌다.**    │
 * │ 한 번 박히면 먼저 말한 것이 이기므로(mergeFacts) 그 판 내내 안 고쳐지고,      │
 * │ 다음 턴부터 시스템 프롬프트의 [내가 이미 말한 것]에 실려 나간다 — 나중에      │
 * │ 진짜로 "무슨 일 해?" 를 물으면 그 문장을 그대로 되풀이한다. 신고의 동문서답.  │
 * │                                                                            │
 * │ 그래서 **물음일 때만 박는다.** 판정은 일부러 좁게 잡는다 — 물음표가 있거나    │
 * │ 한국어 의문 어미로 끝날 때만이다. "너 어디 살아"(물음표 없음)처럼 놓치는 게    │
 * │ 있지만, 이 파일의 규칙이 이미 그쪽이다: **엉뚱하게 박는 것보다 안 박는 게      │
 * │ 낫다** (TOPICS 의 상자). 라운드 주제는 전부 물음표로 끝나므로 안 놓친다.      │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * 순수 함수다.
 */
export function isQuestionLike(text: string | null | undefined): boolean {
  if (!text) return false;
  const q = text.trim();
  if (q === '') return false;
  if (/[?？]/.test(q)) return true;
  /*
   * 물음표 없이도 물음이 확실한 어미만 받는다. '야'·'어'·'아'는 평서문과 겹쳐서 뺀다.
   * '까'는 앞이 '니'면 뺀다 — "그러니까"·"맞으니까"는 물음이 아니다. 그래서
   * '습니까'·'ㅂ니까'를 **먼저** 둔다(정규식 선택지는 왼쪽부터 맞춰 본다).
   */
  return /(습니까|ㅂ니까|나요|가요|까요|는지|던가|니|냐|랬|댔|(?<!니)까)\s*$/.test(q);
}

/**
 * "이 질문에 이렇게 답했다"를 사실 한 줄로. 주제를 모르거나 못 쓸 모양이면 null.
 *
 * ★ 값은 **봇이 실제로 한 답 그대로**다. 요약하지 않는다 — 요약하면 다음 턴에
 *   요약본을 말하게 되고, 그러면 처음 답과 또 달라진다.
 *
 * ★ **물음이 아니면 안 박는다** (isQuestionLike 의 상자). 평서문에 딸려 나온 대꾸를
 *   답으로 박으면 그 판 내내 동문서답이 된다.
 *
 * 순수 함수다.
 */
export function pinFact(question: string | null | undefined, reply: string): string | null {
  if (!isQuestionLike(question)) return null;
  const label = topicOf(question);
  if (!label) return null;
  return sanitizeFact(`${label}: ${reply}`);
}

/**
 * 이미 말한 것 + 이번에 말한 것 → 새 factSheet.
 *
 * ★ **먼저 말한 것이 이긴다.** 나중에 온 같은 키는 조용히 버린다 —
 *   그게 이 파일의 전부다. 덮어쓰게 두면 봇은 매번 최신 답으로 갱신되고,
 *   "아까 뭐랬지"에 여전히 다른 답을 한다.
 *
 * 순수 함수다 — 인자만 보고 새 배열을 만든다.
 */
export function mergeFacts(
  existing: readonly string[],
  incoming: readonly unknown[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const f of existing) {
    const s = sanitizeFact(f);
    if (!s) continue;
    const k = factKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= MAX_FACTS) return out;
  }

  for (const f of incoming) {
    const s = sanitizeFact(f);
    if (!s) continue;
    const k = factKey(s);
    if (seen.has(k)) continue; // 먼저 말한 것이 이긴다
    seen.add(k);
    out.push(s);
    if (out.length >= MAX_FACTS) return out;
  }

  return out;
}
