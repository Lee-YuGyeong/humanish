/**
 * 라운드테이블 — 한 판의 진행 상태머신 **과 집계**. 소유: A. **서버(워커)에서만 돈다.**
 *
 * 한 판의 흐름:
 *   topic ⑥ → speak 45 → topic ⑥ → speak 45 → freechat 60
 *         → vote 30 → defense 20 → verdict 20 → reveal 20 → ended     (= 252초)
 *   (주제① 사실형 → 다같이 말하기 → 주제② 감정형 → 다같이 말하기 → 자유대화
 *    → 지목 투표 → 최후변론 → 생사 재투표 → 정체 공개 → 종료)
 *
 * ┌─ ★ v2에서 뒤집힌 것 — 읽고 되돌리지 말 것 ─────────────────────────────────┐
 * │ v1의 이 머리말은 **"워커는 게임 규칙을 모른다"** 였다. 표 집계도 지목 확정도  │
 * │ 정체 판정도 Supabase(2D 게임) 소유이고, 워커는 시간 창만 흘려보냈다           │
 * │ (MULTIPLAYER §8 · GAMEPLAY-PLAN §5 방향 B).                                 │
 * │                                                                            │
 * │ **3D 월드 한정으로 그 결정을 뒤집었다.** 월드의 판은 Supabase 페이즈           │
 * │ 상태머신이 아니라 **이 Durable Object 가 소유한다** — 여기서 표를 모으고,      │
 * │ 지목을 확정하고, 처형 여부와 승리 진영까지 판정한다.                          │
 * │                                                                            │
 * │ 뒤집은 이유: 월드는 "다같이 45초 말하기"처럼 2D의 answers/votes 테이블로는     │
 * │ 표현되지 않는 라이브 흐름이고, 왕복마다 Next→Supabase를 타면 단계 경계가       │
 * │ 네트워크 지연만큼 흔들린다. 흔들리는 경계는 곧 I1 누출이다(§5.3 대칭).         │
 * │                                                                            │
 * │ ★ 그래서 **I1이 지켜지는 근거가 바뀌었다.** 전에는 "워커가 정체를 몰라서"      │
 * │   구조적으로 안 샜다. 이제는 **"알지만 reveal 말고는 안 내보내서"** 안 샌다 —  │
 * │   즉 규율로만 지켜진다. 그 규율을 이 파일이 진다:                             │
 * │     · is_bot 은 `RoundState.humanIds`(판 시작 시점 스냅샷)로만 들어온다.       │
 * │     · 정체를 내보내는 함수는 **`revealSnapshot()` 하나뿐이다.** 다른 어떤      │
 * │       export도 사람/봇을 구분하는 값을 돌려주지 않는다 — `roundSnapshot()`     │
 * │       과 `voteProgress()` 를 고칠 때 이걸 먼저 확인하라.                      │
 * │     · `revealSnapshot()` 은 phase 가 reveal/ended 가 아니면 **null 을         │
 * │       돌려준다.** 판 중간 입장자에게 스냅샷으로 흘리는 경로를 여기서 막는다.   │
 * │                                                                            │
 * │ 2D 게임은 여전히 자기 집계를 한다. 두 무대는 별개다 — 이 파일의 규칙을         │
 * │ lib/game/ 이나 supabase/ 와 맞추려 들지 말 것.                               │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ I1 — 이 파일이 만들지 않는 신호들 ────────────────────────────────────────┐
 * │ · 순차 발언(turn)을 버렸다. speak 은 전원이 동시에 말하므로 "그 차례를 어떻게 │
 * │   채우는가"라는 관찰 창 자체가 없다. 판 길이도 좌석 수와 무관해졌다.          │
 * │ · 조명(spotlightId)은 **defense 에서만** 켜진다. 그 밖의 단계에서 켜지면      │
 * │   조명 자체가 신호다.                                                       │
 * │ · 모든 단계 길이가 고정이다. defense 는 지목된 자리가 사람이든 봇이든 20초를  │
 * │   꽉 채운다 — 조기 종료가 없다 (§5.3, 이 저장소가 두 번 데인 함정).           │
 * │ · 동점 추첨은 **좌석/명단 순서에 의존하지 않는다** (tallyNomination 참고).     │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * bots.ts 와 같은 결이다 — 가변 상태 + 스텝 함수. DB·네트워크를 모르고 now 는 인자로 받는다.
 */

import type {
  RevealIdentity,
  RevealVote,
  RoundPhase,
  RoundRole,
  RoundWinner,
} from '../../lib/mp/protocol';
import {
  ROUND_DEFENSE_MS,
  ROUND_FREECHAT_MS,
  ROUND_REVEAL_MS,
  ROUND_SPEAK_MS,
  ROUND_TOPIC_MS,
  ROUND_TOPIC_ROUNDS,
  ROUND_VERDICT_MS,
  ROUND_VOTE_MS,
} from '../../lib/mp/constants';

/**
 * 난수원. **집계에 쓰는 랜덤은 전부 인자로 받는다.**
 *
 * ★ 이 파일의 다른 곳(주제 뽑기)은 Math.random 을 그냥 쓴다 — 결과가 화면 문구일 뿐이라
 *   테스트가 확정할 게 없기 때문이다. 집계는 다르다: 동점 추첨 하나가 **누가 처형되는지**를
 *   바꾸므로, 테스트가 "동점 3자면 셋 다 뽑힐 수 있다"와 "이 rng 면 반드시 b 가 뽑힌다"를
 *   둘 다 결정적으로 확인할 수 있어야 한다. bots.ts 의 `pickResponder(…, chanceOverride)` 가
 *   같은 이유로 확률을 인자로 뺀 선례다.
 */
export type Rng = () => number;

/**
 * 한 판의 전부. **가변**이다 — stepRound/castVote 가 제자리에서 고친다.
 *
 * ★ 전부 구조화 복제 가능한 값만 담는다(Map/Set 금지). room-do 가 단계 전환 때마다
 *   `ctx.storage` 에 통째로 굽기 때문이다 — 봇이 0기인 방은 틱 타이머가 없어서
 *   투표 중에 DO 가 hibernate 할 수 있고, 그때 인스턴스 필드는 통째로 날아간다.
 */
export interface RoundState {
  phase: RoundPhase;
  /** 이 단계가 끝나는 서버 시각(epoch ms). 전환은 오직 이 값으로 판정한다 (I2). */
  phaseEndsAt: number;

  /**
   * 이 판의 전적 키 (SPEC §15-2-결정). match_results 의 room_id 자리에 들어간다 —
   * 방 id 가 아니라 **판 id** 를 쓰는 이유는 rematch 다: 같은 방에서 「한 판 더」를
   * 돌 때마다 새 판이고, 방 id 로 적으면 기본키 (room_id, user_id) 가 두 번째 판부터
   * 조용히 무시한다. **판이 시작될 때 한 번 발급되고 절대 안 바뀐다** — reveal 에서
   * 발급하면 DO 가 그 틱에 죽었다 살아났을 때 같은 판이 다른 키로 두 번 적힌다.
   * 이 값이 없는 판(필드가 생기기 전에 구운 것)은 전적을 안 적는다.
   */
  matchId: string | null;

  /**
   * 판 시작 때 뽑아 둔 주제 둘. [0] 사실형, [1] 감정형이고 **서로 다르다**
   * (GAMEFLOW-V2 §3-② 일관성 축 — 같은 사람이 두 축에서 어긋나는지를 본다).
   * 미리 뽑는 이유: 라운드 경계에서 뽑으면 그 순간의 랜덤이 단계 전환을 늦출 수 있고,
   * 저장/복구 후에 주제가 바뀌어 버린다.
   */
  topics: string[];
  /** 지금 화면에 띄운 주제. topic·speak 이 아니면 null. */
  topic: string | null;
  /** 몇 번째 주제 라운드인가 (1-based). topic·speak 이 아니면 0. */
  round: number;

  /** defense 에서 조명받는 좌석. 그 밖엔 반드시 null (I1). */
  spotlightId: string | null;

  /**
   * ★ 판 시작 시점의 좌석 명단. **판이 도는 동안 절대 갱신하지 않는다.**
   *   room-do 의 `ensureMeta` 는 누가 접속할 때마다 좌석을 다시 읽어 오는데,
   *   그 최신 명단으로 집계하면 **분모가 판 도중에 바뀐다** — 늦게 들어온 사람의 표가
   *   섞이고, 조기 종료 임계가 투표 중에 움직인다.
   */
  seatIds: string[];
  /**
   * ★ 그중 사람인 좌석 (판 시작 시점). **이 배열이 이 파일에 들어온 유일한 is_bot 이다.**
   *   승패를 정하는 표는 사람 표만 센다 (SPEC §18.3 — 봇은 아무나 찍으므로 세면
   *   판정이 주사위가 된다). 봇도 반드시 투표하되 집계에서만 빠진다.
   */
  humanIds: string[];
  /**
   * ★ 그중 연기자 좌석 (SPEC §18.2). humanIds 의 부분집합. 수는 0~상한 균등 랜덤이고
   *   **비공개다** — 밖으로 나가는 길은 각자에게 가는 `t:'role'`(humanRole)과
   *   revealSnapshot 둘뿐이다. 0명인 판이 정상적으로 나온다 — 예외 처리 대상이 아니다.
   */
  actorIds: string[];

  /** voterId → targetId. **마지막 선택이 유효하다** (덮어쓴다). 사람·봇 전부 담긴다. */
  votes: Record<string, string>;
  /** voterId → 찬(true=처형) / 반(false=생존). 지목된 본인의 표는 애초에 안 들어온다. */
  verdicts: Record<string, boolean>;

  /**
   * vote 마감에 확정된 지목 대상. 사람 표가 한 장도 없으면 null(지목 없음).
   * ★ defense 진입 전에는 **밖으로 나가면 안 된다** — roundSnapshot 이 막는다.
   */
  nomineeId: string | null;
  /** 지목 집계가 끝났는가. 두 번 돌면 동점 추첨이 다시 굴러 결과가 바뀐다. */
  nominationSettled: boolean;

  /** verdict 집계 결과. 지목된 본인의 표는 빠져 있다. */
  verdictTally: { guilty: number; innocent: number };
  /** 처형됐는가. 찬이 **과반**일 때만 true — 동수는 생존이다. */
  executed: boolean;
  /** 이긴 진영. reveal 에 도달하기 전에는 null. */
  winner: RoundWinner | null;
  verdictSettled: boolean;

  /** 판이 끝났는가 (phase === 'ended'). */
  done: boolean;
}

/* ─────────────────────────────── 주제 풀 ─────────────────────────────── */

/**
 * 주제 풀. **공개 문구라 I1과 무관하다** (봇 발화 풀이 아니라 모두가 보는 화면 주제다).
 *
 * 두 축으로 가른 이유 (GAMEFLOW-V2 §3-②): 1라운드는 **사실형** — 검증 가능한 디테일을
 * 묻는다. 2라운드는 **감정형** — 검증은 불가능하지만 앞의 사실과 결이 맞는지를 본다.
 * 같은 축을 두 번 물으면 두 라운드가 사실상 한 라운드다.
 *
 * ★ 임시 상수다. 원래 자리는 §17.2 question_pool(DB)이고 room-meta 로 실어 오는 게 맞다.
 *   (follow-up: /api/internal/world-room 응답에 topics 추가)
 */
export const FACT_TOPICS: readonly string[] = [
  '지금 휴대폰 배터리 몇 %야?',
  '오늘 아침에 처음 먹은 것은?',
  '가장 최근에 연 앱은 무엇이야?',
  '지금 앉은 자리에서 왼쪽에 뭐가 보여?',
  '오늘 집을 나선 시각은 몇 시였어?',
  '어제 잠든 시각과 오늘 깬 시각은?',
];

export const EMOTION_TOPICS: readonly string[] = [
  '오늘 기분을 색 하나로 말하면?',
  '최근에 가장 크게 웃은 순간은?',
  '가장 최근에 한 사소한 거짓말은?',
  '지금 가장 하기 싫은 일은?',
  '누군가에게 지금 딱 한마디 한다면?',
  '요즘 가장 자주 드는 생각은?',
];

/** rng()가 1을 돌려줘도 배열 밖으로 나가지 않는다. */
function pick<T>(arr: readonly T[], rng: Rng): T {
  const i = Math.min(arr.length - 1, Math.floor(rng() * arr.length));
  return arr[i];
}

/**
 * 판에 쓸 주제 둘을 뽑는다. 길이는 언제나 ROUND_TOPIC_ROUNDS 다 —
 * 풀이 모자라면 같은 축에서 다시 뽑아서라도 채운다(단계 수는 좌석 수와 무관하게 고정).
 */
function pickTopics(rng: Rng): string[] {
  const axes = [FACT_TOPICS, EMOTION_TOPICS];
  const out: string[] = [];
  for (let i = 0; i < ROUND_TOPIC_ROUNDS; i += 1) out.push(pick(axes[i % axes.length], rng));
  return out;
}

/* ─────────────────────────────── 연기자 (§18.2) ─────────────────────────────── */

/** 사람 수 → 연기자 상한 (SPEC §18.1 인원표). 2명 이하 0 · 3~5명 1 · 6명부터 2. */
function actorCap(humanCount: number): number {
  if (humanCount <= 2) return 0;
  if (humanCount <= 5) return 1;
  return 2;
}

/**
 * 연기자를 뽑는다. **수는 0~상한 균등 랜덤이고 비공개다** (§18.2) — 고정값이면
 * 표만 보면 누구나 아는 수라, 랜덤으로 두는 것이 곧 비밀로 두는 것이다.
 *
 * ★ 뽑기가 명단 순서에 의존하면 안 된다 (I1 — tallyNomination 의 동점 추첨과 같은
 *   이유). humanIds 는 좌석/입장 순서라, 앞에서 자르기 전에 rng 로 섞는다.
 */
function pickActors(humans: readonly string[], rng: Rng): string[] {
  const cap = actorCap(humans.length);
  // rng()가 1을 돌려줘도 cap 을 넘지 않는다 (pick 과 같은 방어)
  const count = Math.min(cap, Math.floor(rng() * (cap + 1)));
  if (count === 0) return [];
  const pool = humans.slice();
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

/* ─────────────────────────────── 판 열기 ─────────────────────────────── */

/**
 * 판을 시작한다. 좌석이 비었으면 null — 돌릴 대상이 없다.
 *
 * @param seatIds  판 시작 시점의 **전 좌석** (사람+봇). 이 배열이 그대로 얼어붙는다.
 * @param humanIds 그중 사람 좌석. seatIds 밖의 값은 버린다.
 *
 * ★ humanIds 가 비어도 판은 열린다(전원 봇). 그 판은 사람 표가 0장이라 지목 없이
 *   reveal 로 간다 — 규칙상 정상 경로다. 여기서 막으면 "사람이 몇인지"에 따라 판이
 *   열리고 안 열리고가 갈려서 그게 또 관찰 가능한 차이가 된다.
 */
export function startRound(
  seatIds: readonly string[],
  humanIds: readonly string[],
  now: number,
  rng: Rng = Math.random,
  // 전적 키. 여기서 만들지 않고 받는 이유: 이 파일은 rng 까지 인자로 받는
  // 결정적 계층이라, uuid 발급 같은 비결정을 들이면 테스트 근거가 무너진다.
  matchId: string | null = null,
): RoundState | null {
  if (seatIds.length === 0) return null;
  const seats = seatIds.slice();
  const humans = humanIds.filter((id) => seats.includes(id));
  const topics = pickTopics(rng);
  return {
    phase: 'topic',
    phaseEndsAt: now + ROUND_TOPIC_MS,
    matchId,
    topics,
    topic: topics[0] ?? null,
    round: 1,
    spotlightId: null,
    seatIds: seats,
    humanIds: humans,
    actorIds: pickActors(humans, rng),
    votes: {},
    verdicts: {},
    nomineeId: null,
    nominationSettled: false,
    verdictTally: { guilty: 0, innocent: 0 },
    executed: false,
    winner: null,
    verdictSettled: false,
    done: false,
  };
}

/* ─────────────────────────────── 집계 (순수) ─────────────────────────────── */

/**
 * 지목 집계. **사람 표만 센다** (SPEC §18.3). 최다 득표가 동점이면 동점자 중 무작위 1명.
 * 사람 표가 한 장도 없으면 null — 지목 없음이다.
 *
 * ★ 동점 추첨이 **명단 순서에 의존하면 안 된다** (I1). seatIds 는 DB 순이라 봇이 뒤쪽에
 *   몰려 있을 수 있고, votes 의 키 순서는 표가 들어온 순서 = 봇의 예약 시각 분포다.
 *   어느 쪽을 그대로 쓰든 추첨에 편향이 생긴다. 그래서 동점자를 **id 사전순으로 정렬한
 *   뒤** 균등 추첨한다 — uuid 사전순은 좌석과도 정체와도 무관하다.
 * ★ 그리고 이 함수는 humanIds 만 받는다. **is_bot 을 여기서 다시 보지 않는다** —
 *   "봇이 지목되면 재미없으니" 같은 선의의 보정이 한 줄이라도 들어오면 그날로 I1이 죽는다.
 */
export function tallyNomination(
  votes: Readonly<Record<string, string>>,
  humanIds: readonly string[],
  rng: Rng = Math.random,
): string | null {
  const humans = new Set(humanIds);
  const counts = new Map<string, number>();
  for (const [voterId, targetId] of Object.entries(votes)) {
    if (!humans.has(voterId)) continue; // 봇 표는 세지 않는다
    counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  }
  if (counts.size === 0) return null;

  let top = 0;
  for (const n of counts.values()) if (n > top) top = n;

  const tied: string[] = [];
  for (const [id, n] of counts) if (n === top) tied.push(id);
  if (tied.length === 1) return tied[0];

  tied.sort(); // ← 편향 제거. 위 주석 참고
  return pick(tied, rng);
}

/**
 * 생사 재투표 집계. 사람 표만 세고 **지목된 본인의 표는 뺀다**(기권).
 * 처형은 **찬이 과반**일 때만 — 동수는 생존이다.
 *
 * ★ 동수를 생존으로 두는 게 변론을 넣은 이유다: 확신 없이 사람을 처형하지 못하게 한다.
 *   유효표가 0이면(사람이 아무도 안 냈다) 당연히 생존이다.
 */
export function resolveVerdict(
  verdicts: Readonly<Record<string, boolean>>,
  humanIds: readonly string[],
  nomineeId: string | null,
): { executed: boolean; guilty: number; innocent: number } {
  const humans = new Set(humanIds);
  let guilty = 0;
  let innocent = 0;
  for (const [voterId, isGuilty] of Object.entries(verdicts)) {
    if (!humans.has(voterId)) continue;
    if (voterId === nomineeId) continue; // 본인은 기권
    if (isGuilty) guilty += 1;
    else innocent += 1;
  }
  // 과반: guilty > (guilty+innocent)/2 ⇔ guilty > innocent. 동수는 false.
  return { executed: guilty > innocent, guilty, innocent };
}

/**
 * 이긴 진영 (SPEC §18.4의 월드 변형). 처형된 자리의 정체가 판을 끝낸다:
 * AI → 시민 승 · 연기자 → 연기자 승 · 시민 → AI 승.
 * 처형이 없으면(지목 없음 · 부결) AI 승 — AI 가 살아남은 판이다.
 *
 * ★ 연기자는 판 시작 때 워커가 직접 뽑는다 (pickActors, §18.2). 예전 주석의
 *   "워커는 역할을 모른다"는 그때 이야기다 — 이제 RoundState.actorIds 가 안다.
 */
export function decideWinner(executed: boolean, nomineeRole: RoundRole | null): RoundWinner {
  if (!executed || nomineeRole === null) return 'ai';
  if (nomineeRole === 'ai') return 'citizen';
  return nomineeRole === 'actor' ? 'actor' : 'ai';
}

/** 판 시작 시점 명단 기준으로 이 좌석이 봇인가. **이 파일 밖으로 새면 안 되는 판단이다.** */
function isBotSeat(s: RoundState, id: string | null): boolean {
  if (id === null) return false;
  return s.seatIds.includes(id) && !s.humanIds.includes(id);
}

/**
 * 판 시작 시점 명단 기준 좌석의 진영. isBotSeat 과 같은 급 — **밖으로 새면 안 된다.**
 * 좌석이 아니면 null.
 */
function seatRole(s: RoundState, id: string | null): RoundRole | null {
  if (id === null || !s.seatIds.includes(id)) return null;
  if (!s.humanIds.includes(id)) return 'ai';
  return s.actorIds.includes(id) ? 'actor' : 'citizen';
}

/**
 * **본인에게만** 알려줄 역할 (`t:'role'` 용, §18.2). 봇·좌석 밖이면 null 이라
 * 봇 여부가 이 함수로는 새지 않는다 — null 은 "보낼 것 없음"일 뿐이다.
 *
 * ★ revealSnapshot 밖에서 정체가 나가는 **유일한 통로**다. 반환값은 반드시
 *   그 사람의 소켓 하나에만 보낸다 — 브로드캐스트에 실으면 연기자 명단이 샌다.
 */
export function humanRole(s: RoundState, id: string): 'citizen' | 'actor' | null {
  const role = seatRole(s, id);
  return role === 'ai' ? null : role;
}

/* ─────────────────────────────── 표 받기 ─────────────────────────────── */

/**
 * 지목 표를 받는다. 받았으면 true, 거절했으면 false.
 *
 * 거절하는 경우:
 *  · vote 단계가 아니다 / 마감이 지났다
 *  · voter 나 target 이 **판 시작 시점 좌석**이 아니다 (판 중간 입장자 포함)
 *  · **자기 자신을 찍었다** — SPEC §18.3(연기자 자폭 지목 차단). 봇에게도 똑같이 건다:
 *    reveal 의 votes[] 에 자기 자신 투표가 한 건이라도 보이면 그 자리가 봇으로 확정된다 (I1).
 *
 * 마감까지 몇 번이든 다시 보낼 수 있고 **마지막 것이 유효하다** — 사람이 마음을 바꾸는 건
 * 자연스럽다. 못 바꾸게 하면 오히려 사람이 봇처럼 군다.
 */
export function castVote(s: RoundState, voterId: string, targetId: string, now: number): boolean {
  if (s.phase !== 'vote' || now >= s.phaseEndsAt) return false;
  if (voterId === targetId) return false;
  if (!s.seatIds.includes(voterId) || !s.seatIds.includes(targetId)) return false;
  s.votes[voterId] = targetId;
  return true;
}

/**
 * 생사 재투표 표를 받는다. 받았으면 true, 거절했으면 false.
 * 지목된 **본인은 거절**한다(기권). 그 밖은 castVote 와 같은 규칙이고, 역시 덮어쓴다.
 */
export function castVerdict(s: RoundState, voterId: string, guilty: boolean, now: number): boolean {
  if (s.phase !== 'verdict' || now >= s.phaseEndsAt) return false;
  if (voterId === s.nomineeId) return false;
  if (!s.seatIds.includes(voterId)) return false;
  s.verdicts[voterId] = guilty;
  return true;
}

/**
 * 투표 진행 현황. **숫자 둘뿐이다** — 누가 냈는지도, 누구에게 냈는지도 담지 않는다.
 * voted 는 **표를 낸 고유 좌석 수**이고(수신 메시지 수가 아니다 — 그러면 표를 바꾼 행위가
 * 관측된다), total 은 **전 좌석 수**다(사람 좌석 수로 두지 않는다). protocol.ts 참고.
 */
export function voteProgress(s: RoundState): { voted: number; total: number } {
  const src = s.phase === 'verdict' ? s.verdicts : s.votes;
  let voted = 0;
  for (const id of s.seatIds) if (id in src) voted += 1;
  return { voted, total: s.seatIds.length };
}

/**
 * 주어진 좌석들이 **전부** 표를 냈는가. vote 의 조기 종료 판정에 쓴다 (SPEC §5.1, I5).
 *
 * ★ 무엇을 넘길지는 호출부(room-do)가 정한다 — **소켓이 살아 있는 사람 좌석**이다.
 *   · 봇을 넣으면 안 된다: 봇은 창의 25~85% 구간에 늦게 내므로 조건이 사실상 죽는다.
 *   · 끊긴 사람을 넣어도 안 된다: 자리를 남겨 두므로 조건이 영영 참이 되지 않는다 (§18.6).
 *   · 목록이 비면 **false** 다. 아무도 없는 방에서 판이 순간이동하는 걸 막는다.
 * ★ verdict 에는 절대 쓰지 마라. 지목된 본인이 기권하므로 임계가 지목자의 정체에 따라
 *   H 또는 H−1 로 갈리고, vote_progress 가 공개 카운터라 종료 시점의 숫자 하나로
 *   **지목자가 봇인지 사람인지가 읽힌다** (§5.3).
 */
export function haveAllVoted(s: RoundState, voterIds: readonly string[]): boolean {
  if (voterIds.length === 0) return false;
  return voterIds.every((id) => id in s.votes);
}

/* ─────────────────────────────── 단계 전환 ─────────────────────────────── */

/**
 * 한 단계 굴린다. 마감(phaseEndsAt)이 지났으면 다음 단계로 넘기고 true 를 돌려준다
 * (호출부가 그때 round 메시지를 브로드캐스트한다). 아직이면 false.
 *
 * ┌─ ★ 한 번에 한 단계만 넘어간다 — 이 성질에 호출부가 기대고 있다 ────────────┐
 * │ 모든 전환이 `phaseEndsAt = now + D`(D > 0)를 쓴다. 그래서 같은 now 로 다시   │
 * │ 불러도 위의 `now < s.phaseEndsAt` 에서 즉시 false 다. 호출부는 while 을 돌   │
 * │ 필요가 없고, 잠들었다 깬 DO 는 100ms 틱마다 한 칸씩 따라잡는다.              │
 * │                                                                            │
 * │ 그래서 **길이 0인 전환을 만들면 안 된다.** 특히 "지목 없음 → defense·verdict  │
 * │ 건너뛰기"를 `vote→defense→…` 두 번의 전환으로 쪼개지 마라 — vote 에서        │
 * │ **바로 reveal 로** 한 번에 간다.                                            │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 집계(지목 확정·생사 판정)를 **여기서 한다.** 밖의 "마감 직전 훅"으로 빼면 호출부가
 *   순서를 한 번만 틀려도 표가 통째로 무시되는데, 그 버그는 판이 끝나야 드러난다.
 *   순수성은 rng 를 인자로 받아서 지킨다 — 테스트는 rng 를 고정해 결과를 확정할 수 있다.
 *   집계 자체는 tallyNomination/resolveVerdict 로 따로 빼 두었으니 단위 검사도 그대로 된다.
 */
export function stepRound(s: RoundState, now: number, rng: Rng = Math.random): boolean {
  if (s.done || now < s.phaseEndsAt) return false;

  switch (s.phase) {
    case 'topic':
      s.phase = 'speak';
      s.phaseEndsAt = now + ROUND_SPEAK_MS;
      return true;

    case 'speak':
      if (s.round < ROUND_TOPIC_ROUNDS) {
        // 다음 주제 라운드. 축이 바뀐다 (사실형 → 감정형)
        s.round += 1;
        s.topic = s.topics[s.round - 1] ?? null;
        s.phase = 'topic';
        s.phaseEndsAt = now + ROUND_TOPIC_MS;
        return true;
      }
      s.phase = 'freechat';
      s.round = 0;
      s.topic = null;
      s.phaseEndsAt = now + ROUND_FREECHAT_MS;
      return true;

    case 'freechat':
      s.phase = 'vote';
      s.phaseEndsAt = now + ROUND_VOTE_MS;
      return true;

    case 'vote': {
      settleNomination(s, rng);
      if (s.nomineeId === null) {
        // 사람 표가 한 장도 없었다 → 지목 없음. 변론할 사람도, 생사를 물을 대상도 없다.
        // defense·verdict 를 **한 번의 전환으로** 건너뛴다 (위 박스 참고).
        // 아무도 지목되지 않았으면 AI 승이다 (SPEC §18.4의 취지 · GAMEFLOW-V2 §0-A3).
        settleVerdict(s);
        s.phase = 'reveal';
        s.phaseEndsAt = now + ROUND_REVEAL_MS;
        return true;
      }
      s.phase = 'defense';
      s.spotlightId = s.nomineeId; // 조명은 이 단계에서만 켜진다 (I1)
      s.phaseEndsAt = now + ROUND_DEFENSE_MS;
      return true;
    }

    case 'defense':
      s.phase = 'verdict';
      s.spotlightId = null;
      s.phaseEndsAt = now + ROUND_VERDICT_MS;
      return true;

    case 'verdict':
      settleVerdict(s);
      s.phase = 'reveal';
      s.phaseEndsAt = now + ROUND_REVEAL_MS;
      return true;

    case 'reveal':
      s.phase = 'ended';
      s.spotlightId = null;
      s.done = true;
      // 끝났다. done 가드가 막으므로 phaseEndsAt 은 더 밀지 않는다.
      s.phaseEndsAt = now;
      return true;

    default:
      return false;
  }
}

/** 지목을 확정한다. 두 번 돌면 동점 추첨이 다시 굴러 결과가 바뀌므로 한 번만. */
function settleNomination(s: RoundState, rng: Rng): void {
  if (s.nominationSettled) return;
  s.nominationSettled = true;
  s.nomineeId = tallyNomination(s.votes, s.humanIds, rng);
}

/** 처형 여부와 승리 진영을 확정한다. */
function settleVerdict(s: RoundState): void {
  if (s.verdictSettled) return;
  s.verdictSettled = true;
  const r = resolveVerdict(s.verdicts, s.humanIds, s.nomineeId);
  s.verdictTally = { guilty: r.guilty, innocent: r.innocent };
  s.executed = s.nomineeId !== null && r.executed;
  s.winner = decideWinner(s.executed, seatRole(s, s.nomineeId));
}

/**
 * 판을 강제로 끝낸다. 되살릴 수 없다.
 *
 * ★ 언제 부르나: DO 가 오래 잠들었다 깨어 판이 통째로 뒤처졌을 때다. stepRound 는
 *   따라잡을 때 각 단계에 **새로** `now + D` 를 주므로, 5분을 자고 나면 판이 처음부터
 *   다시 흐른다 — "끝난 줄 알았는데 다시 vote" 가 된다. 호출부가 뒤처짐을 재서
 *   (예: `now - phaseEndsAt` 이 한 판 길이를 넘으면) 이걸 부르는 편이 낫다.
 *   그렇게 끝난 판은 reveal 을 내지 않는다 — 정체는 판정이 끝났을 때만 공개된다.
 */
export function abortRound(s: RoundState, now: number): void {
  s.phase = 'ended';
  s.spotlightId = null;
  s.topic = null;
  s.round = 0;
  s.done = true;
  s.phaseEndsAt = now;
}

/* ─────────────────────────────── 밖으로 나가는 것 ─────────────────────────────── */

/**
 * 브로드캐스트/저장용 스냅샷. `t:'round'` 메시지의 알맹이와 **같은 모양**이다.
 * 단계가 바뀔 때마다, 그리고 새로 들어온 사람에게 한 번 보낸다.
 *
 * ★ 여기서 네 가지를 막는다:
 *   · spotlightId 는 **defense 에서만** 나간다 (I1).
 *   · nomineeId 는 **defense 이후에만** 나간다 — vote 가 끝나기 전에 새면 결과가 미리 샌다 (I1).
 *   · 정체(is_bot)는 어떤 형태로도 없다. 그건 revealSnapshot 하나뿐이다 (I1).
 *   · **topic 은 speak 에서만** 나간다 — 아래 상자.
 *
 * ┌─ 왜 topic 을 topic 단계에 안 주나 (공정성) ───────────────────────────────┐
 * │ topic 단계는 "곧 주제가 나온다"를 띄우고 6초를 세는 뜸 들이는 구간이고,     │
 * │ 주제는 그 시간이 **끝난 뒤에** 공개되는 게 규칙이다. 그런데 그 6초 동안에도 │
 * │ round 메시지에 topic 을 실어 보내고 있었다 — 화면이 안 그려도 개발자 도구  │
 * │ 로 소켓을 보면 6초 먼저 읽힌다. 답을 미리 지어 둘 수 있으면 즉흥성이 죽고,  │
 * │ 그건 이 게임에서 사람과 봇을 가르는 축(GAMEPLAY-PLAN §3-③) 자체를 흐린다.   │
 * │ **안 보내면 못 읽는다.** 화면에서 가리는 걸로 대신하지 않는다.             │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
export function roundSnapshot(s: RoundState): {
  phase: RoundPhase;
  topic: string | null;
  endsAt: number;
  round: number;
  totalRounds: number;
  spotlightId: string | null;
  nomineeId: string | null;
} {
  const afterVote =
    s.phase === 'defense' || s.phase === 'verdict' || s.phase === 'reveal' || s.phase === 'ended';
  return {
    phase: s.phase,
    topic: s.phase === 'speak' ? s.topic : null,
    endsAt: s.phaseEndsAt,
    round: s.phase === 'topic' || s.phase === 'speak' ? s.round : 0,
    totalRounds: ROUND_TOPIC_ROUNDS,
    spotlightId: s.phase === 'defense' ? s.spotlightId : null,
    nomineeId: afterVote ? s.nomineeId : null,
  };
}

/**
 * ┌─ ★★ I1의 **유일한 예외** — 정체를 내보내는 함수는 이거 하나다 ─────────────┐
 * │ `t:'reveal'` 메시지의 알맹이. 판정이 끝난 뒤에만 나가고, 정체 공개가 곧      │
 * │ 게임의 결말이다 (SPEC §18.4).                                              │
 * │                                                                            │
 * │ · **phase 가 reveal/ended 가 아니면 null 을 돌려준다.** 호출부가 실수로     │
 * │   판 중간 입장자에게 스냅샷으로 흘리는 경로를 여기서 물리적으로 막는다.      │
 * │ · identities 는 **전 좌석**을 **좌석 순서 그대로** 담는다. 봇만 담거나 봇을 │
 * │   앞/뒤에 몰아 담으면 배열 순서 자체가 답이 된다.                           │
 * │ · 이 반환값을 다른 메시지에 재사용하지 마라. 재사용하는 순간 정체가 reveal   │
 * │   밖으로 나갈 통로가 생긴다.                                                │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
export function revealSnapshot(s: RoundState): {
  nomineeId: string | null;
  executed: boolean;
  winner: RoundWinner;
  verdict: { guilty: number; innocent: number };
  votes: RevealVote[];
  identities: RevealIdentity[];
} | null {
  if (s.phase !== 'reveal' && s.phase !== 'ended') return null;
  if (!s.verdictSettled) return null;

  const votes: RevealVote[] = [];
  // 좌석 순서로 낸다 — votes 객체의 키 순서는 표가 들어온 순서(= 봇의 예약 시각 분포)라
  // 그대로 내면 배열 순서가 곧 타이밍 정보가 된다.
  for (const id of s.seatIds) {
    const targetId = s.votes[id];
    if (targetId !== undefined) votes.push({ voterId: id, targetId });
  }

  return {
    nomineeId: s.nomineeId,
    executed: s.executed,
    winner: s.winner ?? 'ai',
    verdict: { guilty: s.verdictTally.guilty, innocent: s.verdictTally.innocent },
    votes,
    // role 은 §18.2 확정 뒤에 붙었다. isBot 은 role 없이 보내던 구 워커와 같은 값 —
    // 클라이언트가 role 이 없으면 isBot 으로 접으므로 둘을 함께 낸다.
    identities: s.seatIds.map((id) => ({
      id,
      isBot: isBotSeat(s, id),
      role: seatRole(s, id) ?? 'citizen',
    })),
  };
}

/**
 * 처형된 좌석 (`t:'eliminated'` 용). 처형이 없으면 null.
 * ★ 정체는 여기 실리지 않는다 — 쓰러지는 것과 그가 봇이었는지는 별개다.
 */
export function eliminatedId(s: RoundState): string | null {
  return s.executed ? s.nomineeId : null;
}
