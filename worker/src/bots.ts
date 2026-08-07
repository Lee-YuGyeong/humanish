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
  BOT_GATHER_RADIUS,
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
  BOT_RUN_CHANCE,
  BOT_RUN_SPEED_MAX,
  BOT_RUN_SPEED_MIN,
  BOT_SPEED_MAX,
  BOT_SPEED_MIN,
  BOT_TYPE_CHARS_MAX,
  BOT_TYPE_CHARS_MIN,
  GRAVITY,
  JUMP_SPEED,
  MOVE_THROTTLE_MS,
  SPEAK_JITTER_MS,
  WALK_SPEED,
  WORLD,
} from '../../lib/mp/constants';
import type { AnimState, PlayerSnapshot } from '../../lib/mp/protocol';
import { SPAWN_CENTER, spawnFor } from '../../lib/mp/spawn';
// 가구는 클라이언트만 아는 게 아니다 — 좌표를 만드는 건 서버라, 서버가 같은 가구를
// 보지 않으면 봇이 소파를 뚫고 지나간다. 데이터·판정은 lib/mp/collide.ts 하나뿐이다.
import { STEP_UP, groundHeightAt, isBlocked, resolveCollisions } from '../../lib/mp/collide';
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
 * ┌─ ★ 봇도 사람과 **같은 STEP_UP 을 쓴다** (I1) ─────────────────────────────┐
 * │ 여기 예전에 `BOT_STEP_UP = 0` 이 있었고, 주석은 "봇이 가구에 안 올라가는 건 │
 * │ 원래 정한 바"라고 그 차이를 수용하고 있었다. **I1 앞에서는 성립하지 않는다.**│
 * │                                                                          │
 * │ 사람은 낮은 탁자를 걸어서 넘고 그 위에 선다. 봇은 낮은 턱도 못 넘고 발 높이가 │
 * │ 언제나 0이었다. 그래서 규칙이 하나 섰다 — **가구 위에 서 있으면 사람 확정,   │
 * │ 낮은 턱을 그냥 넘어가면 사람 확정.** 총 자리·AI 수가 공개(§15-3)라 사람이     │
 * │ 몇 자리만 확정돼도 소거법으로 봇이 드러난다.                                │
 * │                                                                          │
 * │ 원래 이걸 0으로 둔 이유("y 를 같이 안 올리면 탁자를 뚫고 걷는다")는 진짜      │
 * │ 문제였는데, 답은 **y 를 같이 올리는 것**이다 — 사람 클라이언트(LocalRig)가    │
 * │ 하는 그대로 groundHeightAt 으로 발밑을 묻는다. 아래 stepBot 의 수직 처리는    │
 * │ world-scene.tsx 의 그것과 같은 순서·같은 상수여야 한다.                      │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
const BOT_STEP_UP = STEP_UP;

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
  /** 발 높이. 0이 바닥이고 점프·가구 위에서만 >0이다 (사람과 같다) */
  y: number;
  /** 수직 속도 (m/s). 발이 땅에 붙어 있으면 0 */
  vy: number;
  /**
   * 발이 땅(또는 가구 윗면)에 붙어 있는가.
   * 사람 클라이언트(LocalRig)의 같은 이름 필드와 **같은 규칙**으로 굴린다 —
   * 발판 밖으로 걸어 나가면 false 가 되고 떨어진다. 여기가 갈리면 봇만
   * 허공을 걷거나 봇만 탁자를 뚫는다 (I1).
   */
  grounded: boolean;
  heading: number;
  anim: AnimState;

  /** 현재 목적지 */
  tx: number;
  tz: number;
  /** 이 시각까지는 서 있는다 (epoch ms) */
  waitUntil: number;
  speed: number;
  /**
   * 이번 목적지를 **달려서** 가는가. speed 와 짝이고 목적지마다 다시 뽑는다 (pickGait).
   *
   * ★ 속도로 역산하지 않고 따로 들고 있는다. anim 은 발이 실제로 얼마나 갔는지가
   *   아니라 "지금 달리는 중인가"로 정해야 하기 때문이다 — 가구에 눌려 느려진
   *   달리기가 walk 로 보이면, 사람 쪽(Shift 를 누르면 무조건 run)과 규칙이 갈린다.
   */
  running: boolean;

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

  /**
   * **주제에 답할 차례를 아직 안 쓴 speak 창의 마감** (epoch ms). 빚이 없으면 0.
   *
   * ┌─ 왜 필요한가 (신고: "주제 대신 옆사람 말에만 답한다") ─────────────────────┐
   * │ speak 창에서 봇은 자리를 잡고 LLM 답을 기다린다. 그 사이에 사람이 채팅을    │
   * │ 치면 대꾸 예약이 걸리고, 그 예약이 **speechSeq 를 올려서** 날아오던 주제     │
   * │ 답을 무효로 만든다 (upgradeSpeech 의 seq 검사). 그러면 화면에는 주제를 씹고 │
   * │ 잡담에만 답하는 자리가 남는다 — 다 같이 주제에 답하는 45초에 그 자리만.     │
   * │                                                                          │
   * │ 그래서 **빚을 갚기 전에는 대꾸 후보에서 뺀다** (pickResponder). 주제 답이   │
   * │ 실제로 나가면 0 으로 지운다 (room-do 의 botSpoke) — 그 뒤로는 같은 창에서도 │
   * │ 평소처럼 사람 말을 받는다.                                                 │
   * │                                                                          │
   * │ ★ 값이 **창의 마감 시각**이라 스스로 만료된다. LLM 이 끝내 안 와서 한마디도 │
   * │   못 한 창이어도 다음 단계까지 끌고 가지 않는다.                            │
   * │ ★ 침묵하기로 뽑힌 라운드는 애초에 0 이다 (primeForTopic 의 speak=false) —   │
   * │   할 말이 없는데 대꾸까지 막으면 그 창이 통째로 조용해진다.                  │
   * └──────────────────────────────────────────────────────────────────────────┘
   */
  topicDue: number;

  /**
   * **지금 LLM 답을 기다리는 중인가.** 기다리는 동안에는 새 발화 자리를 잡지 않는다.
   *
   * ┌─ 왜 (신고: "앞에 한마디 하고 안 한다" — 사용자가 원인까지 짚었다) ──────────┐
   * │ upgradeSpeech 는 부르기 전 speechSeq 를 기억해 뒀다가 답이 왔을 때 그 번호가 │
   * │ 그대로일 때만 쓴다 (묵은 답이 엉뚱한 말에 얹히는 걸 막는 장치다). 그런데     │
   * │ **사람이 한 줄 칠 때마다 새 자리가 잡히고 그때마다 seq 가 오른다.**          │
   * │ 답이 오는 데 4~20초가 걸리므로, 그 사이에 누가 한 줄만 쳐도 만들던 답이      │
   * │ 통째로 버려진다. 사람이 조를수록("말좀해봐") 더 조용해지는 구조였다.         │
   * │                                                                          │
   * │ 쿨다운(20초)이 있을 때는 그게 우연히 이 문제를 가려 주고 있었다 — 그 시간    │
   * │ 동안 자리를 다시 안 잡으니 첫 답이 살아남았다. 쿨다운을 0 으로 내리자        │
   * │ (BOT_REACT_CHANCE 의 상자) 가려져 있던 게 그대로 드러났다.                  │
   * │                                                                          │
   * │ 그래서 **대꾸를 만드는 동안은 새 요청을 받지 않는다.** 사람도 답을 치는       │
   * │ 중에 상대가 한 줄 더 보내면 치던 걸 마저 보내지, 지우고 다시 시작하지 않는다. │
   * │                                                                          │
   * │ ★ 잠기는 시간은 요청 하나의 수명뿐이다(보통 4초, 최대 컷). 쿨다운처럼 답한   │
   * │   **뒤에** 잠그는 게 아니라 답하는 **동안만** 잠근다 — 그래서 "몇 초 동안    │
   * │   통째로 벙어리"인 구간이 생기지 않는다.                                    │
   * │ ★ 최후변론·판결처럼 판이 시키는 발화는 이 자물쇠를 보지 않는다. 그건 대꾸가  │
   * │   아니라 차례라, 만들던 잡담을 버리고 그쪽을 하는 게 맞다.                   │
   * └──────────────────────────────────────────────────────────────────────────┘
   */
  pending: boolean;

  /**
   * 이 인물이 이 방에서 **지어낸 사실**의 명단 ("사는 곳: 인천 서구").
   *
   * ┌─ 왜 좌표와 달리 저장하는가 ───────────────────────────────────────────────┐
   * │ BotPose 머리말은 "나머지는 다시 뽑아도 티가 안 난다"고 했다. 여기는 정반대다  │
   * │ — 다시 뽑으면 **사는 곳이 바뀐다.** 대화 기록이 밀려나서가 아니라 매 턴이     │
   * │ 독립이라, 같은 걸 두 번만 물어도 다른 답이 나온다 (lib/agent/facts.ts 실측).  │
   * │ 심문자가 노리는 게 정확히 그 지점이라 이건 DO가 자도 살아남아야 한다.        │
   * └──────────────────────────────────────────────────────────────────────────┘
   *
   * ★ 워커는 이 내용을 **읽지도 합치지도 않는다.** 오리진에 그대로 보내고,
   *   돌려받은 전체 명단으로 갈아 끼운다 (world-agent.ts의 AgentLine.facts).
   */
  facts: string[];

  /** 목적지까지 남은 거리의 최근 최소값. 안 줄면 가구에 막힌 것이다 */
  bestDist: number;
  /** bestDist 가 마지막으로 갱신된 시각 (epoch ms) */
  progressAt: number;
  /** 마지막으로 실제로 움직인 시각 (epoch ms). 가구에 정면으로 눌렸는지 본다 */
  blockedAt: number;
}

/**
 * 저장·복원용. 좌표는 다시 뽑아도 티가 안 나지만 **facts는 아니다** —
 * 다시 뽑으면 사는 곳이 바뀌고, 그게 곧 봇 표식이다 (BotState.facts).
 */
export interface BotPose {
  id: string;
  x: number;
  z: number;
  heading: number;
  /** 없을 수 있다 — 이 필드가 생기기 전에 저장된 방이 그렇다. */
  facts?: string[];
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * 설 수 있는 자리 하나. **가구 안은 피한다** —
 * 가구 안을 목적지로 잡으면 봇이 그 앞에서 영원히 비빈다.
 *
 * ┌─ ★ gather — 판이 도는 동안에는 테이블 주변에서만 뽑는다 (I1) ─────────────┐
 * │ 주제는 중앙 스크린에 뜬다. 사람은 그걸 읽어야 하니 테이블 근처에 모여 그쪽을 │
 * │ 본다. 그런데 이 함수는 **월드 전체 균등 추첨**이었다 — topic 6초 + speak 45초 │
 * │ 짜리 라운드가 둘이니 102초 동안, 주제가 떠 있는데 혼자 창고 구석으로 걸어가는 │
 * │ 자리가 생긴다. devtools 도 자동화도 필요 없다. 두 라운드면 눈으로 갈린다.    │
 * │                                                                          │
 * │ 그래서 판이 도는 동안에는 반경을 좁힌다. 균등 추첨(√r)이라 가장자리에 몰리지  │
 * │ 않고, 반경 안에서도 계속 서성이므로 "전원이 테이블에 붙어 선" 그림은 안 된다. │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
function randomPoint(gather: boolean): { x: number; z: number } {
  const clampX = (v: number) =>
    Math.min(Math.max(v, WORLD.minX + EDGE_INSET), WORLD.maxX - EDGE_INSET);
  const clampZ = (v: number) =>
    Math.min(Math.max(v, WORLD.minZ + EDGE_INSET), WORLD.maxZ - EDGE_INSET);

  let p = { x: 0, z: 0 };
  for (let i = 0; i < TARGET_TRIES; i += 1) {
    if (gather) {
      // √r 을 쓰는 이유: 그냥 r 을 균등으로 뽑으면 원 중심에 몰린다(넓이가 r² 이므로).
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * BOT_GATHER_RADIUS;
      p = {
        x: clampX(SPAWN_CENTER.x + Math.cos(a) * r),
        z: clampZ(SPAWN_CENTER.z + Math.sin(a) * r),
      };
    } else {
      p = {
        x: rand(WORLD.minX + EDGE_INSET, WORLD.maxX - EDGE_INSET),
        z: rand(WORLD.minZ + EDGE_INSET, WORLD.maxZ - EDGE_INSET),
      };
    }
    if (!isBlocked(p.x, p.z, 0, BOT_STEP_UP)) return p;
  }
  return p; // 다 막혔다면(있을 수 없다) 그냥 간다 — 아래 막힘 판정이 곧 다시 잡는다
}

// 시작 위치는 lib/mp/spawn.ts 하나로 정한다. 사람(room-do.ts·클라이언트)도 같은 함수를
// 쓴다 — 봇만 다른 자리에서 시작하면 그것부터 표식이 된다 (I1).
export { spawnFor };

/**
 * @param slots 좌석 원을 몇 등분하는가. **방 정원이 아니라 WORLD_SEAT_SLOTS 다** —
 *              사람과 봇이 같은 값을 써야 자리가 겹치지 않는다 (lib/mp/constants.ts).
 */
export function createBot(
  seed: { id: string; seat: number; nickname: string; maskId: string },
  slots: number,
  now: number,
  pose?: BotPose,
): BotState {
  const raw = pose ?? { ...spawnFor(seed.seat, slots), heading: 0 };
  // 좌석 원(spawnFor)이 가구와 겹칠 수 있고, 저장된 좌표는 가구를 옮기기 전 것일 수 있다.
  // 가구 안에서 시작하면 첫 틱에 튕겨 나가는 게 보인다 — 여기서 미리 밀어낸다.
  const pushed = resolveCollisions(raw.x, raw.z, 0, BOT_STEP_UP);
  // 밀어내도 안 풀리는 쐐기(소파 두 개 사이 구석)일 수 있다. 그러면 빈자리를 새로 뽑는다.
  const free = isBlocked(pushed.x, pushed.z, 0, BOT_STEP_UP) ? randomPoint(false) : pushed;
  const start = { ...raw, x: free.x, z: free.z };
  const target = randomPoint(false);
  const bot: BotState = {
    ...seed,
    x: start.x,
    z: start.z,
    y: 0,
    vy: 0,
    heading: start.heading,
    anim: 'idle',
    grounded: true,
    tx: target.x,
    tz: target.z,
    // 전부 동시에 출발하면 그 순간 8명이 똑같이 움직여서 바로 들킨다. 흩뿌린다.
    waitUntil: now + rand(0, BOT_IDLE_MAX_MS),
    // 아래 pickGait 이 곧바로 덮어쓴다 (객체가 있어야 부를 수 있어서 자리만 잡아 둔다).
    running: false,
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
    topicDue: 0,
    pending: false,
    // 저장된 방이면 이어받는다. 새 방이면 아직 아무것도 안 지어냈다.
    facts: pose?.facts ?? [],
    bestDist: Infinity,
    progressAt: now,
    blockedAt: now,
  };
  // 첫 걸음도 걷기/달리기를 뽑는다 — 전원이 걸어서 출발하면 그 첫 몇 초가 통째로
  // 대칭을 깬다(사람은 처음부터 달리는 사람이 섞인다).
  pickGait(bot);
  return bot;
}

/**
 * 지금 걸어가던 목적지를 버리고 새로 잡는다. **판이 열리는 순간** 호출부가 부른다.
 *
 * ★ I1 — 안 부르면, 판이 시작되기 전에 잡아 둔 "창고 구석" 목적지가 그대로 살아서
 *   봇이 첫 주제가 뜨는 10초 동안 화면을 등지고 걸어 나간다. 사람은 그때 스크린을
 *   보고 있다(스폰이 애초에 스크린 쪽을 향한다 — world-scene 의 LocalRig).
 *   그 10초가 라운드마다 반복되면 눈으로 갈린다.
 */
export function gatherBot(bot: BotState, now: number): void {
  retarget(bot, now, true);
}

/**
 * 이번 걸음을 걷기로 갈지 달리기로 갈지 정한다. **목적지를 새로 잡을 때마다** 부른다.
 *
 * ★ 좌석에 고정하지 않는다 (BOT_RUN_CHANCE 의 주석, I1) — "늘 걷는 자리"가 생기면
 *   그 성향이 곧 좌석 지문이다. 속도까지 같이 뽑아야 걸음걸이와 anim 이 안 갈린다.
 */
function pickGait(bot: BotState): void {
  bot.running = Math.random() < BOT_RUN_CHANCE;
  bot.speed = bot.running
    ? rand(BOT_RUN_SPEED_MIN, BOT_RUN_SPEED_MAX)
    : rand(BOT_SPEED_MIN, BOT_SPEED_MAX);
}

/** 다음 목적지를 잡고 막힘 판정을 초기화한다. */
function retarget(bot: BotState, now: number, gather: boolean): void {
  const next = randomPoint(gather);
  bot.tx = next.x;
  bot.tz = next.z;
  bot.bestDist = Infinity;
  bot.progressAt = now;
  bot.blockedAt = now;
}

/**
 * 원하는 방향으로 서서히 돈다. 사람이 마우스를 홱 돌리는 것보다 느려야 자연스럽다.
 * atan2(dx, dz) 는 three.js 의 y회전과 축이 맞는다 (app/world/avatar.tsx 의 정면 축 주석).
 *
 * ┌─ ★ 빠를수록 빨리 돈다 (2026-08-07 — 달리기를 넣으면서) ────────────────────┐
 * │ TURN_RATE 는 고정값이었다. 걷기(1.7~2.9m/s)에서는 그걸로 충분했는데,        │
 * │ 달리기(4.2~5.6m/s)가 생기자 **몸이 옆으로 미끄러졌다** — 목적지에 닿아       │
 * │ 방향을 크게 꺾는 순간 속도 방향은 즉시 바뀌는데 몸은 3.4rad/s 로 따라가서,   │
 * │ 180° 를 도는 0.92초 동안 5m 를 옆걸음·뒷걸음으로 갔다. 무빙워크처럼 보인다. │
 * │ (「옆걸음」 검사가 이걸 잡았다 — 40회 중 4회. 검사가 옳았다.)               │
 * │                                                                          │
 * │ 그래서 **1미터를 가는 동안 도는 각도**를 걸음걸이와 무관하게 맞춘다. 이게    │
 * │ 저 검사가 실제로 재는 값이기도 하다("가는 쪽을 보고 있는가"는 시간이 아니라  │
 * │ 거리의 문제다). 걷기에서는 배율이 1 이라 예전 값 그대로다.                  │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
function turnToward(bot: BotState, want: number, dt: number): void {
  let diff = ((want - bot.heading + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  const maxTurn = TURN_RATE * Math.max(1, bot.speed / WALK_SPEED) * dt;
  bot.heading += Math.max(-maxTurn, Math.min(maxTurn, diff));
}

/**
 * 한 틱 굴린다. dt는 초 단위.
 *
 * 반환값이 true면 "이번 틱에 내보낼 만큼 변했다"는 뜻이다. 판정 기준은
 * 사람 클라이언트(LocalAvatar)와 **같아야 한다** — 값이 변했고, 마지막 송신에서
 * MOVE_THROTTLE_MS가 지났을 때.
 */
export function stepBot(
  bot: BotState,
  now: number,
  dt: number,
  /**
   * 판이 도는 동안인가 — 목적지를 라운드테이블 주변으로 좁힌다 (randomPoint 의 상자, I1).
   * 판이 없는 방(라운지)에서는 false 라 예전처럼 창고 전체를 돌아다닌다.
   */
  gather = false,
): boolean {
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
      // 도착 — 잠깐 서 있다가 다음 목적지로. 걸음걸이(걷기/달리기+속도)도 다시 뽑는다.
      retarget(bot, now, gather);
      bot.waitUntil = now + rand(BOT_IDLE_MIN_MS, BOT_IDLE_MAX_MS);
      pickGait(bot);
      bot.anim = 'idle';
    } else if (dist >= bot.bestDist - PROGRESS_EPS && now - bot.progressAt > STUCK_MS) {
      // 몇 초째 가까워지지 못했다 = 가구에 막혔다. 사람은 못 가는 데를 계속 밀지 않는다.
      retarget(bot, now, gather);
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
      // ★ 사람(LocalRig)과 **같은 함수·같은 인자**를 쓴다. 여기만 다르면 봇이 가구를
      //   뚫거나(느슨하면) 봇만 낮은 탁자를 못 넘는다(빡빡하면). 후자가 곧 I1 누출이다 —
      //   예전엔 발 높이를 0으로 고정하고 stepUp 을 0으로 뒀는데, 그래서 **가구 위에
      //   선 아바타 = 사람 확정**이 됐다. 지금은 실제 발 높이(bot.y)로 본다.
      const moved = resolveCollisions(
        bot.x + (dx / dist) * step,
        bot.z + (dz / dist) * step,
        bot.y,
        BOT_STEP_UP,
      );
      // ★ 밀어냈는데도 아직 가구 안이면 **그 자리로 가지 않는다.**
      //   소파 두 개가 ㄱ 자로 놓인 구석처럼, A 에서 밀면 B 안이고 B 에서 밀면 A 안인
      //   쐐기가 있다. 거기는 몇 번을 밀어도 안 풀린다 — 들어가지 않는 게 유일한 답이다.
      if (!isBlocked(moved.x, moved.z, bot.y, BOT_STEP_UP)) {
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
        if (now - bot.blockedAt > BLOCKED_MS) retarget(bot, now, gather);
      } else {
        bot.blockedAt = now;
        // ★ 실제로 간 거리가 아니라 **이번 걸음의 걸음걸이**로 고른다 (BotState.running).
        //   사람 쪽도 Shift 를 누르고 있으면 가구에 끼어 못 가도 anim='run' 이다
        //   (world-scene.tsx 의 LocalRig) — 여기서 규칙이 갈리면 그게 곧 표식이다.
        bot.anim = bot.running ? 'run' : 'walk';
        // ★ 목적지가 아니라 **실제로 간 방향**으로 돈다. 가구를 따라 미끄러지는 동안
        //   목적지를 보고 있으면 옆걸음·뒷걸음처럼 보인다. 사람은 가는 쪽을 본다.
        turnToward(bot, Math.atan2(mx, mz), dt);
      }
    }
  }

  /*
   * ┌─ ★★ 끼었으면 빠져나온다. **사람 클라와 같은 한 줄이다** ────────────────────┐
   * │ world-scene.tsx 의 LocalRig 는 매 프레임 `resolveColliders(pos, pos.y)` 로   │
   * │ **지금 서 있는 자리**를 밀어낸다. 봇에는 그게 없었다 — 위 걷기 블록은 *후보*  │
   * │ 자리만 보고, 막히면 **안 움직이는 것**이 전부다. 그래서 일단 가구 밀어내기    │
   * │ 범위(hw+PLAYER_R) 안에 들어가면 나올 길이 없다: 거기서 만드는 후보 자리도     │
   * │ 전부 막혀 있으니 영원히 얼어붙는다.                                          │
   * │                                                                            │
   * │ 들어가는 길은 실제로 있다 — 소파 위에 올라섰다가 **가장자리 밖으로 걸어       │
   * │ 나오는** 순간이다. 발이 떨어지는 동안 발 높이가 윗면 밑으로 내려가는데, 그때  │
   * │ 몸은 아직 밀어내기 범위 안이다. (BOT_JUMP_* 를 당겨 점프가 잦아지자           │
   * │ 적대적 픽스처 300판 중 3판이 그렇게 갇혔다 — 2026-08-07 실측.)               │
   * │                                                                            │
   * │ ★ 그래도 위의 `isBlocked` 가드는 **남긴다.** 저건 "쐐기(A에서 밀면 B 안,      │
   * │   B에서 밀면 A 안)에 제 발로 걸어 들어가지 않는다"는 예방이고, 이건 이미      │
   * │   들어간 뒤의 탈출구다. 둘은 다른 일을 한다 — 하나로 합치려 들지 말 것.       │
   * │                                                                            │
   * │ ★ I1 — 사람이 매 프레임 하는 일을 봇도 하게 만드는 변경이다. 봇에만 넣으면    │
   * │   비대칭이 아니라 **대칭 복구**다. 반대로 여기를 빼면 "가구 옆에서 굳는       │
   * │   아바타 = 봇" 이 된다.                                                     │
   * └──────────────────────────────────────────────────────────────────────────┘
   */
  const free = resolveCollisions(bot.x, bot.z, bot.y, BOT_STEP_UP);
  bot.x = free.x;
  bot.z = free.z;

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
 * 수직 한 틱. 사람 클라이언트(LocalRig)의 수직 블록과 **같은 상수·같은 순서**다 —
 * 중력이 다르면 체공 시간이 달라지고, 발밑을 다르게 물으면 한쪽만 가구에 올라선다.
 * 그 차이는 전부 자리 단위 신호다 (I1).
 *
 * 순서가 곧 규칙이다: 발밑이 무엇인지 먼저 묻고(바닥 0 또는 가구 윗면) → 발판 밖으로
 * 걸어 나갔으면 떨어뜨리고 → 땅에 있으면 그 높이에 붙인다.
 *
 * allowNew가 false면 **새로 뛰지만 않는다** — 공중이었으면 착지까지 굴린다.
 * 타이핑 중에 공중에서 얼어붙으면 그게 곧 봇 표식이다 (I1).
 */
function stepJump(bot: BotState, now: number, dt: number, allowNew: boolean): void {
  // 발밑. fromY 를 지금 발 높이로 주면 "옆을 걷다 갑자기 소파 위로 순간이동"이 안 난다.
  const ground = groundHeightAt(bot.x, bot.z, bot.y);

  if (bot.grounded && allowNew && now >= bot.nextJumpAt) {
    bot.nextJumpAt = now + rand(BOT_JUMP_MIN_MS, BOT_JUMP_MAX_MS);
    bot.vy = JUMP_SPEED;
    bot.grounded = false;
  }

  // 발판 밖으로 걸어 나갔다. 뛰지 않았으니 초기 속도는 0이다.
  if (bot.grounded && bot.y > ground + 0.02) bot.grounded = false;

  if (bot.grounded) {
    bot.y = ground;
    bot.vy = 0;
    return;
  }

  bot.vy -= GRAVITY * dt;
  bot.y += bot.vy * dt;
  if (bot.vy <= 0 && bot.y <= ground) {
    bot.y = ground;
    bot.vy = 0;
    bot.grounded = true;
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
 * 주제가 떴다 — 이 창(speak) 안에서 한 번 말하도록 발화 시각을 **당긴다**.
 *
 * ┌─ 왜 shouldChat 만으로는 안 되나 (I1) ─────────────────────────────────────┐
 * │ 자발 발화 간격은 25~75초다 (BOT_CHAT_*). speak 창은 45초라, 그대로 두면     │
 * │ **말 안 하고 지나가는 봇이 절반쯤 생긴다.** 사람은 다 같이 답하라고 주제를   │
 * │ 띄운 45초라 웬만하면 한마디씩 한다 — 그 창에서 조용한 자리가 한 덩어리로     │
 * │ 묶이면 그게 곧 명단이다.                                                   │
 * │                                                                          │
 * │ ★ 그렇다고 **전원이 반드시 말하게 하면 정반대로 샌다** (SPEC §18.5):        │
 * │   사람은 AFK·패스가 흔해서 빈 답을 만든다. 봇이 매 라운드 100% 답하면        │
 * │   "두 라운드 다 답한 자리 = 봇", 뒤집어 "빈 답 = 사람 확정"이 된다.          │
 * │   그래서 speak=false(침묵)를 좌석마다 · 라운드마다 **독립으로** 뽑아 넘긴다  │
 * │   (호출부의 BOT_SILENCE_CHANCE). 같은 봇이 늘 걸러도, 늘 답해도 표식이다.   │
 * │                                                                          │
 * │ ★ 좌석 인덱스로 스태거하지 않는다 — 간격이 규칙적이면 간격 자체가 신호다.    │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ ★ 상한을 0.62 → 0.85 로 올렸다 (I1) ────────────────────────────────────┐
 * │ 0.62 는 "말이 다음 단계로 넘어가서 터지는 것"을 막으려고 잡은 값이었다.      │
 * │ 그런데 45초 창에서 **치기 시작**하는 시각이 최대 27.9초라, 타이핑(8~34자) +   │
 * │ 지터를 더해도 대략 35초 전에는 반드시 끝난다. 즉 **창의 뒤 38%에는 봇의 주제  │
 * │ 답이 절대 오지 않았다.** 그 구간에 자발 발화가 나온 자리는 사람 쪽으로 크게   │
 * │ 기울고, 두 라운드 누적이면 좌석 두엇이 확정된다. 경계 넘김을 막으려고 분포를   │
 * │ 잘랐더니 **분포 자체가 신호**가 된 셈이다.                                   │
 * │                                                                            │
 * │ 경계 넘김은 분포가 아니라 **경계에서 끊어서** 막는다 — speak 다음은 topic 이나 │
 * │ freechat 이고 둘 다 사람도 말할 수 있는 단계라 조금 넘어가도 표식이 아니다.    │
 * │ 진짜 위험한 건 말이 잠기는 단계(CHAT_LOCKED_PHASES)로 넘어가는 것인데, 거기는  │
 * │ room-do 의 hushBots 가 진입 훅에서 통째로 끊는다.                            │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
/*
 * ┌─ ★ 0.12~0.85 → 0.02~0.45 (2026-08-07) ────────────────────────────────────┐
 * │ 위 두 상자는 전부 **자리를 잡는 시각**을 이야기했다. 그때는 자리를 잡고 나서  │
 * │ 말이 나가기까지가 위장 지연(치는 시간 1~3초)뿐이라 둘이 거의 같았다.          │
 * │                                                                            │
 * │ 지금 화면에 보이는 시각은 그게 아니다 — **자리 잡은 시각 + 모델 시간**이다.   │
 * │ 0.85 로 두면 38초에 물어보고 45초 창 밖에서 답이 오는데, 그건 다음 주제가     │
 * │ 이미 떠 있는 화면이라 동문서답이거나, 남은 시간 클램프에 걸려 아예 안 물어본다 │
 * │ (upgradeSpeech) — **창의 뒤쪽이 통째로 침묵**이 된다. 사용자가 본 게 그거다.  │
 * │                                                                            │
 * │ 그래서 물어보는 창을 **모델 시간만큼 앞으로 당긴다.** 지금 실측 중앙값이 4초  │
 * │ 대라(스트리밍 + max_tokens 140 으로 고친 뒤) 2.2~28초에 물어보면 답이 6~36초에 │
 * │ 나가 창 전체에 퍼진다. 두 상자가 지키려던 "분포가 신호가 되면 안 된다"는       │
 * │ 오히려 이쪽이 낫다 — 바뀐 건 규칙이 아니라 **지연의 정체**다.                 │
 * │                                                                            │
 * │ ★ 모델이나 컷을 손대면 여기도 같이 본다. 규칙은 하나다:                       │
 * │   **(창 × MAX_FRAC) + 모델 지연 ≲ 창.** 지연이 커지면 좁히고, 줄면 넓힌다.    │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
/*
 * ┌─ ★ 0.45 로 당겨 봤다가 **되돌렸다** (2026-08-07, 실측) ────────────────────┐
 * │ 위 상자의 규칙(`(창 × MAX_FRAC) + 모델 지연 ≲ 창`)에 지금 실측 지연을        │
 * │ 넣으면 0.62 는 이미 깨져 있다 — 45×0.62 + 17 = 45.0 으로 중앙값이 정확히     │
 * │ 창 끝이고, 단계 클램프까지 겹치면 예산이 15초라 중앙값이 못 들어간다.        │
 * │ 그래서 0.45 로 당겼는데, **판을 돌려 보니 오히려 나빠졌다** (발화 6건 →      │
 * │ 3건 · 2건, 두 창 다 침묵).                                                 │
 * │                                                                            │
 * │ 이유는 이 규칙이 안 보던 쪽에 있다. 물어보는 순간 `bot.pending` 이 켜지고,   │
 * │ 그동안 이 봇은 **사람 말 대꾸 후보에서 빠진다** (pickResponder 의 `!pending`). │
 * │ 모델이 15~25초를 쓰는 지금, 5초에 물어보면 5~30초가 통째로 «귀 먹은 구간»이  │
 * │ 된다 — 창 앞쪽은 사람이 제일 활발하게 떠드는 때다. 늦게 물어보면 그 구간이   │
 * │ 창 뒤로 밀려서, 앞쪽 대꾸를 살린다.                                        │
 * │                                                                            │
 * │ 즉 지연이 창에 비해 커지면 **바꿔야 할 것은 물어보는 시각이 아니다.** 규칙의 │
 * │ 전제(모델 시간이 창 안에 들어간다)가 깨진 상황이라, 여기서 얻을 게 없다.     │
 * │ 실제로 회수되는 자리는 예산이 단계에 안 묶이는 라운지·freechat 쪽이었다      │
 * │ (room-do 의 COMPANION_AGENT_TIMEOUT_MS · budget_ms 배선).                  │
 * │                                                                            │
 * │ ★ 다시 당기려거든 **pending 이 대꾸를 막는 구조부터** 손봐야 한다. 그 전에는 │
 * │   이 값만 바꾸면 반드시 위 결과가 재현된다.                                 │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
const TOPIC_SPEAK_MIN_FRAC = 0.05;
const TOPIC_SPEAK_MAX_FRAC = 0.62;

export function primeForTopic(bot: BotState, now: number, windowMs: number, speak: boolean): void {
  if (!speak) {
    // 이 라운드는 건너뛴다. 창 **밖으로** 밀어 둔다 — 그냥 두면 25~75초 타이머가
    // 우연히 창 안에서 터져서, 침묵하기로 한 자리가 말해 버린다.
    bot.nextChatAt = Math.max(bot.nextChatAt, now + windowMs + 1_000);
    // 할 말이 없는 창이다. 대꾸까지 막으면 그 45초가 통째로 조용해진다 (topicDue).
    bot.topicDue = 0;
    return;
  }
  bot.nextChatAt = now + rand(TOPIC_SPEAK_MIN_FRAC * windowMs, TOPIC_SPEAK_MAX_FRAC * windowMs);
  // 이 창이 닫히기 전에 주제에 답해야 한다. 그때까지는 사람 말 대꾸에 자리를
  // 내주지 않는다 — 그 예약이 주제 답을 덮어쓴다 (BotState.topicDue 의 상자).
  bot.topicDue = now + windowMs;
}

/**
 * 봇을 그 자리에 세운다. 걸음도 점프도 새로 시작하지 않는다.
 * 반환값의 뜻은 stepBot과 같다 — true면 이번 틱에 player_moved를 내보내라.
 *
 * ┌─ ★ 왜 필요한가 (I1 — 이번 판에서 제일 크게 샐 뻔한 자리) ──────────────────┐
 * │ 투표·변론·판결 화면이 뜨는 동안 사람은 **포인터락이 풀려 한 발짝도 못 움직인다** │
 * │ (마우스를 UI에 써야 하니까). 그때 봇만 서버 틱으로 계속 걸어 다니면          │
 * │ **30초 만에 전 좌석이 갈린다.** 봇도 같이 세운다.                            │
 * │                                                                            │
 * │ 공중이었으면 착지까지는 굴린다 — 허공에서 얼어붙는 것도 똑같이 표식이다      │
 * │ (stepJump의 allowNew 주석과 같은 이유).                                     │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
export function haltBot(bot: BotState, now: number, dt: number): boolean {
  bot.anim = 'idle';
  stepJump(bot, now, dt, false);

  const changed =
    bot.anim !== bot.sentAnim ||
    Math.abs(bot.y - bot.sentY) > 0.001 ||
    Math.abs(bot.x - bot.sentX) > 0.001 ||
    Math.abs(bot.z - bot.sentZ) > 0.001;

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
 * 잡아 둔 발화 자리를 **말하지 않고** 놓아준다. 단계 경계에서 부른다.
 *
 * ★ 근거 (I1): freechat 끝에 예약된 말은 읽는 시간 + 치는 시간이 붙어 vote 창으로
 *   넘어가 터진다. 그 순간 사람은 투표 패널 때문에 입력이 막혀 있으므로,
 *   "단계가 바뀐 뒤에도 말하는 자리 = 봇"이 된다.
 */
export function cancelSpeech(bot: BotState): void {
  if (!bot.speechHeld) return;
  bot.speechHeld = false;
  bot.pendingText = null;
  bot.pendingTail = null;
  // seq를 올려 둔다 — 이 자리를 노리던 LLM 응답이 뒤늦게 와서 다음 예약을 덮어쓰면 안 된다.
  bot.speechSeq += 1;
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
 * 라운지 전용 — 자리를 잡되 **읽는 시간도 치는 시간도 없다.**
 *
 * ┌─ 왜 (사용자 결정 2026-08-05: "의도적으로 느리게 한 부분 일단 빼자") ────────┐
 * │ 위장 지연(읽기 1.2~4초 + 타이핑 1.3~2.8초 + 지터)과 LLM 지연은 겹쳐 돌아서   │
 * │ 체감은 둘 중 큰 쪽이다. LLM 이 이미 2~8초라, 위장까지 얹으면 라운지의 AI 는   │
 * │ 말 걸어도 한참 늦게 답하는 상대가 된다 — 판이 없는 방에서는 빠른 쪽이 낫다.   │
 * │                                                                            │
 * │ speakAt 을 now 로 두므로 replaceSpeech(now < speakAt)는 항상 거절되고,       │
 * │ LLM 답은 upgradeSpeech 의 지각 경로(companion)를 타고 scheduleArrivedSpeech  │
 * │ 로 **도착하자마자 잠깐 서서 치고** 나간다. 기다리는 동안 자리는 다음 틱에     │
 * │ 비어서 봇은 하던 대로 걷는다 — 서는 건 답이 온 다음이다.                     │
 * │                                                                            │
 * │ ★ 판이 도는 동안에는 부르지 않는다 (호출부 room-do 의 isLounge). 사람은      │
 * │   서서 치는데 봇만 걸으면서 즉답하면 그 자리가 바로 갈리고(I1), 라운지의      │
 * │   아바타가 그대로 판의 좌석이 되므로 판이 열리면 위장이 다시 켜져야 한다.     │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
export function scheduleInstantSpeech(bot: BotState, now: number): void {
  bot.speechHeld = true;
  bot.pendingText = null;
  bot.pendingTail = null;
  bot.typeAt = now;
  bot.speakAt = now;
  bot.speechSeq += 1;
}

/**
 * **도착한** 답을 잠깐 서서 치고 내보낸다 — scheduleInstantSpeech 의 짝이다.
 * upgradeSpeech 의 지각 경로가 부른다 (자리를 이미 놓친 companion 답).
 *
 * ┌─ 왜 즉시 내보내지 않는가 (사용자 결정 2026-08-05 2차) ─────────────────────┐
 * │ 지각 답을 도착 즉시 broadcast 했더니 **걸으면서 말하는** 아바타가 됐다.       │
 * │ 사람은 치는 동안 발이 묶이므로(composing) 말풍선은 항상 멈춘 아바타 위에      │
 * │ 뜬다 — 그 모양만은 유지한다. 기다림은 빼되 멈춤은 남긴다.                    │
 * │                                                                          │
 * │ 시간은 scheduleTail 과 같은 공식(진짜 문구의 타이핑 시간 + 지터)인데,        │
 * │ maxTypeMs 로 누를 수 있다 — 라운지는 속도가 우선이라 LOUNGE_TYPE_MAX_MS      │
 * │ (1.5초)로 짧게 세우고, 판이 도는 방의 지각 답은 상한 없이 사람 속도로 친다.   │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ★ seq 를 올린다 — 이 자리는 문구가 확정됐으므로 묵은 LLM 응답이 덮으면 안 된다
 *   (scheduleTail 과 같은 이유).
 */
export function scheduleArrivedSpeech(
  bot: BotState,
  text: string,
  tail: string | null,
  now: number,
  maxTypeMs = Infinity,
): void {
  bot.speechHeld = true;
  bot.pendingText = text;
  bot.pendingTail = tail;
  bot.typeAt = now;
  const type = typingDelayMs(text) + Math.floor(Math.random() * SPEAK_JITTER_MS);
  bot.speakAt = now + Math.min(type, maxTypeMs);
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
 * 이 발화에 대꾸할 **알맹이가 있는가.**
 *
 * ┌─ 왜 필요한가 (신고: "ㅋㅋ 했는데 저도요. 라고 답한다") ────────────────────┐
 * │ "ㅋㅋ"·"ㅇㅇ"·"ㅠㅠ"·"!!"에는 답할 내용이 없다. 그런데 대꾸 경로는 사람이     │
 * │ 말하기만 하면 그 문장을 그대로 [지금 답할 질문]으로 실어 보냈고, 모델은      │
 * │ 무에서 문장을 지어내야 하니 엉뚱한 말이 나왔다. 실측 4/4: "ㅋㅋ" → "안녕하세요."│
 * │                                                                          │
 * │ ★ 웃음에 웃음으로 받게 하지 않는다. 사람도 "ㅋㅋ"에는 그냥 아무 말 안 하는   │
 * │   쪽이 흔하다. 그래서 여기서는 **대꾸 자리를 아예 안 잡는다.**               │
 * │   확률 게이트를 없앤 뒤로(BOT_REACT_CHANCE) 이 문지기가 유일한 거르개다 —    │
 * │   여기서 안 막으면 "ㅋㅋ" 한 줄마다 봇이 문장을 지어낸다.                    │
 * │                                                                          │
 * │ 판정 기준은 **완성형 음절이 하나라도 있는가**다. 자모("ㅋ")·기호·이모지만    │
 * │ 남으면 알맹이가 없다. "ㅋㅋ 왜"는 '왜'가 있어 통과한다 — 웃음이 섞였다고      │
 * │ 막으면 진짜 질문을 씹는다.                                                 │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
export function hasContent(text: string): boolean {
  // 한글 완성형 · 영문 · 숫자 중 하나라도 있으면 답할 거리가 있다고 본다.
  // 자모 단독(ㄱ-ㆎ)은 일부러 뺐다 — 그게 "ㅋㅋ"·"ㅇㅇ"이다.
  return /[가-힣a-zA-Z0-9]/.test(text);
}

/**
 * 사람이 한마디 했다. 대꾸할 봇을 **하나만** 고른다. 아무도 안 고를 수도 있다.
 *
 * ★ 둘 이상이 같은 말에 반응하면 그 둘이 한 번에 묶인다 → **하나만** 고른다 (I1).
 *   "항상 반응하면 그 자리가 봇이다"로 확률을 걸던 규칙은 없앴다 —
 *   조용한 자리가 훨씬 먼저 갈린다 (BOT_REACT_CHANCE 의 상자).
 *
 * 고른 봇은 자발 발화 시각을 미룬다 — 방금 대꾸한 봇이 몇 초 뒤에 혼잣말까지 하면
 * 그 자리만 유난히 말이 많아진다.
 *
 * ★ **말한 당사자를 빼는 건 호출부의 몫이다.** 여기 온 배열에서 고를 뿐이라,
 *   봇 발화에 대꾸를 붙일 때 말한 봇을 안 걸러내면 자기 말에 자기가 답한다
 *   (room-do.ts의 maybeChain). 봇→봇 연쇄를 몇 번까지 허용할지도 거기서 센다 —
 *   이 함수는 한 번의 선택만 안다.
 */
export function pickResponder(
  bots: BotState[],
  now: number,
  /**
   * 게임이 안 돌아가는 방(월드 AI만 있는 방)인가.
   * **지금은 두 무대의 값이 같다** — 갈래는 되돌릴 자리로 남아 있다
   * (COMPANION_REACT_CHANCE 의 상자).
   */
  companionMode = false,
  /**
   * 반응 확률을 갈아끼운다. 사람 발화가 아닌 자리(봇 발화·입퇴장)가 쓴다 —
   * 여기서 안 받으면 호출부가 주사위를 한 번 더 굴리게 되고, 그러면 실제 확률이
   * 두 값의 곱이 돼서 상수만 봐서는 알 수 없어진다.
   */
  chanceOverride?: number,
): BotState | null {
  const chance = chanceOverride ?? (companionMode ? COMPANION_REACT_CHANCE : BOT_REACT_CHANCE);
  const cooldown = companionMode ? COMPANION_REACT_COOLDOWN_MS : BOT_REACT_COOLDOWN_MS;

  /*
   * ★ **주제에 답할 차례를 아직 안 쓴 봇은 빼 둔다** (topicDue).
   *   speak 창에서 LLM 답을 기다리는 동안 사람이 채팅을 치면, 그 대꾸 예약이
   *   seq 를 올려서 **날아오던 주제 답을 무효로** 만든다 (upgradeSpeech 의 seq 검사).
   *   그러면 화면에는 "주제는 씹고 옆사람 말에만 답하는 자리"가 남는다.
   *   판이 주제를 띄운 창이니 주제가 먼저다 — 답하고 나면 그 창에서도 평소처럼 받는다.
   */
  const eligible = bots.filter(
    // pending — 만들던 답을 새 요청이 덮어써서 버려지는 걸 막는다 (BotState.pending).
    (b) => !b.speechHeld && !b.pending && now >= b.nextReactAt && now >= b.topicDue,
  );
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
  // facts를 빼먹으면 DO가 잘 때마다 인물의 설정이 리셋된다 — 좌표와 달리 티가 난다.
  return { id: bot.id, x: bot.x, z: bot.z, heading: bot.heading, facts: bot.facts };
}

/*
 * 예전에 여기 FALLBACK_LINES(8줄)가 있었다. 방 메타를 못 받았을 때의 "최소 대비책"이었는데,
 * 실제로는 그게 월드에서 제일 자주 들리는 말이 됐다 — 맥락 없는 같은 문장이 돌아서
 * 그 자체가 봇 티였다. 되살리지 않는다. 할 말이 없으면 말하지 않는 쪽이 낫다
 * (scheduleSpeech 주석의 상자).
 */
