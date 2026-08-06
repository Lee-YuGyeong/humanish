/**
 * 역할 배정 · 점수 계산 · 승패 판정. 소유: B (SPEC §2, §8)
 *
 * 순수 함수만. DB · 네트워크 접근 금지 (SPEC §1 금지 사항).
 * A는 이 함수들의 내부를 모르고, B는 DB를 모른다.
 *
 * 채점 방식은 A가 임시 규칙(lib/server/fallback-rules.ts, 삭제됨)으로 굴리던 것을
 * 그대로 승계했다 — 이미 화면에 떠 온 규칙이라 여기서 바꾸면 결과가 소급된다.
 * 바꿀 거면 계산과 SCORE_RULE 문구를 **같이** 고친다 (문구가 결과 화면에 그대로 뜬다).
 */

import type { Role } from '@/lib/game/types';

/* ─────────────────────────── 방 정원 · 시작 조건 ─────────────────────────── */

/**
 * 한 방에 앉을 수 있는 **사람** 수 (2026-08-06 결정 — 방마다 고르던 정원을 없앴다).
 *
 * ★ 예전에는 방을 만들 때 3~8 중에서 골랐고, 그 값이 rooms.capacity 였다. 고르는
 *   칸을 없앴으므로 모든 방이 같은 값이다 — rooms.capacity 는 그대로 두되(옛 방이
 *   5로 남아 있다) 새 방은 전부 이 값으로 만든다 (supabase/functions/room.sql 의
 *   default_room_capacity).
 */
export const MAX_HUMANS_PER_ROOM = 8;

/**
 * 시작에 필요한 최소 인원(사람만).
 *
 * 사람이 1명이면 assignRoles 가 연기자를 배정하지 않고(아래), 나머지가 AI라
 * **아무나 찍어도 정답**이다. 게임의 절반(연기)과 나머지 절반(추리)이 같이 죽는다.
 */
export const MIN_HUMANS_TO_START = 2;

/**
 * 시작할 때 합류하는 AI 수 (2026-08-06 결정 — **딱 1대다**).
 *
 * 예전에는 "빈 자리를 전부 AI가 채운다"였다. 그러면 사람이 적은 방일수록 AI가 많아져
 * 아무나 찍어도 맞는 판이 되고, 사람이 꽉 찬 방에는 AI가 아예 없었다.
 * 이제 자리 수는 **사람 수 + 1** 이다 — 최대 8 + 1 = 9.
 */
export const AI_SEATS_PER_ROUND = 1;

/** 한 방의 자리 상한 = 사람 8 + AI 1. 좌석 번호는 1..9 다 (players.seat check). */
export const MAX_SEATS_PER_ROOM = MAX_HUMANS_PER_ROOM + AI_SEATS_PER_ROUND;

/** 시작을 막는 이유. null 이면 지금 시작할 수 있다. */
export type StartBlock = 'too_few' | 'too_many' | 'not_ready';

/**
 * 지금 시작할 수 있나 (2026-08-06 결정 — **사람 2~8명 + 전원 준비 완료**).
 *
 * 화면(시작 버튼)과 서버(시작 라우트)가 **같은 함수**를 본다. 한쪽만 고치면
 * 눌리는데 거절당하거나, 눌리지 않는데 서버는 받아주는 상태가 된다.
 *
 * ★ 방장도 사람이라 준비를 눌러야 한다. "모두"에 예외를 두면 화면에 뜬 준비 표시와
 *   실제 조건이 어긋난다 — 남들은 방장이 왜 안 눌러도 되는지 알 방법이 없다.
 * ★ **사람만 넘긴다.** AI를 세면 시작 자체가 막힌다 (I5 와 같은 이유).
 *
 * @param humans 사람 좌석의 준비 상태. 봇·AI 좌석은 넣지 않는다.
 */
export function startBlock(humans: { is_ready: boolean }[]): StartBlock | null {
  if (humans.length < MIN_HUMANS_TO_START) return 'too_few';
  if (humans.length > MAX_HUMANS_PER_ROOM) return 'too_many';
  if (humans.some((h) => !h.is_ready)) return 'not_ready';
  return null;
}

/** 거절 문구. 서버 응답과 화면 안내가 같은 말을 하도록 여기 하나만 둔다. */
export const START_BLOCK_MESSAGE: Record<StartBlock, string> = {
  too_few: `사람이 ${MIN_HUMANS_TO_START}명 이상이어야 시작할 수 있다`,
  too_many: `사람은 ${MAX_HUMANS_PER_ROOM}명까지다`,
  not_ready: '아직 준비하지 않은 사람이 있다',
};

/**
 * seat 순서대로의 역할 배열을 반환한다. 입력과 길이가 같다.
 * 규칙: 봇 자리는 전부 'ai'. 사람이 2명 이상이면 그중 1명만 'spy', 나머지 'citizen'.
 * 사람이 1명이면 스파이가 없다 — "AI인 척해서 표를 끌어올" 상대가 없어 성립하지 않는다.
 *
 * @param isBotBySeat seat 1..N 순서. 어느 자리가 봇인지는 호출자(A)가 안다
 * @param seed        스파이를 고르는 난수. 함수 안에서 만들지 않는다 (I3)
 */
export function assignRoles(isBotBySeat: boolean[], seed: number): Role[] {
  const humanIndexes = isBotBySeat.flatMap((isBot, i) => (isBot ? [] : [i]));
  // 음수 시드가 와도 인덱스가 음수로 새지 않게 나머지를 한 번 감는다
  const pick = (n: number) => ((seed % n) + n) % n;
  const spyIndex = humanIndexes.length >= 2 ? humanIndexes[pick(humanIndexes.length)] : -1;

  return isBotBySeat.map((isBot, i) => {
    if (isBot) return 'ai';
    return i === spyIndex ? 'spy' : 'citizen';
  });
}

/**
 * ★ 이 문구는 결과 화면에 그대로 뜬다. 아래 계산을 고치면 이 배열도 같이 고친다.
 *
 * ┌─ 봇 표를 세지 않는다 (SPEC §8.1 두 선택지 중 후자) ─────────────────────┐
 * │ 봇은 자기 아닌 아무나 무작위로 찍는다 (on_enter_phase의 vote 훅).       │
 * │ 그 표를 점수에 넣으면 **정원이 커질수록 결과가 주사위가 된다** —        │
 * │ 정원 8인 방에 사람이 둘이면 8표 중 6표가 무작위다.                      │
 * │                                                                        │
 * │ 특히 옛 규칙("스파이는 받은 표 하나당 +2")은 그 주사위를 그대로 점수로  │
 * │ 바꿔서, 스파이 상한이 시민 상한의 7배(14점 대 2점)였다. 잘해서가 아니라 │
 * │ 봇이 우연히 찍어줘서 이기는 판이 나온다.                                │
 * │                                                                        │
 * │ 사람 표만 세면 운이 사라진다. 대가는 사람이 적은 방에서 점수가 잘 안    │
 * │ 움직이는 것인데, §8.1이 예고한 그대로다. 봇에게 근거 있는 투표를        │
 * │ 시키는 쪽(LLM)은 §17.5에서 AI를 얹을 때 다시 본다.                     │
 * └────────────────────────────────────────────────────────────────────────┘
 */
export const SCORE_RULE = [
  '시민 — 진짜 AI에게 투표했으면 +2',
  '스파이 — 사람 표를 한 장이라도 받으면 +4',
  'AI — 사람 표를 한 장도 안 받으면 +3',
  '봇이 던진 표는 세지 않는다 — 무작위라서 실력이 아니다',
];

/** 스파이가 사람 표를 한 장이라도 받았을 때의 점수. 표 수에 비례하지 않는다. */
const SPY_EXPOSED_SCORE = 4;
/** AI가 사람 표를 한 장도 안 받았을 때의 점수. */
const AI_HIDDEN_SCORE = 3;
/** 시민이 진짜 AI를 맞혔을 때의 점수. */
const CITIZEN_HIT_SCORE = 2;

/**
 * 사람이 던진 표인가. 역할을 모르는 id(집계에서 빠진 플레이어)는 **사람으로 치지 않는다** —
 * 모르는 표를 사람 표로 세면 봇 표를 뺀 의미가 조용히 사라진다.
 */
function isHumanVoter(voterId: string, roles: Record<string, Role>): boolean {
  const role = roles[voterId];
  return role === 'citizen' || role === 'spy';
}

/**
 * 각자가 **사람에게서** 받은 표 수. 결과 화면이 "3표 받았는데 왜 0점?"이 되지 않도록
 * reveal 라우트가 이 값을 함께 내려보낸다.
 */
export function humanVotesReceived(
  votes: { voterId: string; targetId: string }[],
  roles: Record<string, Role>,
): Record<string, number> {
  const received: Record<string, number> = {};
  for (const id of Object.keys(roles)) received[id] = 0;
  for (const v of votes) {
    if (isHumanVoter(v.voterId, roles)) received[v.targetId] = (received[v.targetId] ?? 0) + 1;
  }
  return received;
}

export function calcScores(
  votes: { voterId: string; targetId: string }[],
  roles: Record<string, Role>,
): Record<string, number> {
  const score: Record<string, number> = {};
  for (const id of Object.keys(roles)) score[id] = 0;

  const received = humanVotesReceived(votes, roles);

  for (const v of votes) {
    if (!isHumanVoter(v.voterId, roles)) continue;
    if (roles[v.voterId] === 'citizen' && roles[v.targetId] === 'ai') {
      score[v.voterId] += CITIZEN_HIT_SCORE;
    }
  }
  for (const [id, role] of Object.entries(roles)) {
    if (role === 'spy' && (received[id] ?? 0) > 0) score[id] += SPY_EXPOSED_SCORE;
    if (role === 'ai' && (received[id] ?? 0) === 0) score[id] += AI_HIDDEN_SCORE;
  }
  return score;
}

/**
 * 표를 가장 많이 받은 **사람**(citizen·spy). reveal 화면의 "가장 의심받은 사람"용.
 *
 * 시그니처에 voterId가 없다 — 어떤 표를 셀지(사람 표만인지 전부인지)는 호출자가
 * 걸러서 넘긴다. 동수면 id 사전순으로 앞선 쪽을 준다(순수 함수라 결과가 흔들리면
 * 안 된다). 사람에게 간 표가 하나도 없으면 null.
 */
export function mostSuspectedHuman(
  votes: { targetId: string }[],
  roles: Record<string, Role>,
): string | null {
  const counts = new Map<string, number>();
  for (const v of votes) {
    const role = roles[v.targetId];
    if (role !== 'citizen' && role !== 'spy') continue;
    counts.set(v.targetId, (counts.get(v.targetId) ?? 0) + 1);
  }

  let best: string | null = null;
  let bestCount = 0;
  for (const [id, n] of [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (n > bestCount) {
      best = id;
      bestCount = n;
    }
  }
  return best;
}
