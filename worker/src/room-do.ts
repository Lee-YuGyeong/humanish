/**
 * 방 하나 = Durable Object 하나. 소유: A
 *
 * idFromName(room_id)가 같으면 어디서 접속해도 같은 인스턴스로 모인다.
 * "같은 방"이 별도 저장소 없이 성립하고, 방 스코프(I10)가 **구조적으로** 지켜진다 —
 * 다른 방의 이벤트는 애초에 이 인스턴스에 도달하지 않는다.
 *
 * ┌─ 상태를 어디에 두는가 ─────────────────────────────────────────────────────┐
 * │ 소켓 attachment │ 사람의 현재 좌표·좌석    │ hibernation 견딤, 끊기면 소멸   │
 * │ ctx.storage     │ 봇 좌표 · 방 메타 캐시   │ 영속                            │
 * │ 인스턴스 필드   │ 채팅 rate-limit, 타이머  │ 잃어도 무해 (evict 시 초기화)   │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 틱 루프에 대하여 ─────────────────────────────────────────────────────────┐
 * │ 순수 릴레이 서버라면 setInterval을 두지 않는 게 맞다(DO가 안 자면 과금이 는다). │
 * │ 그런데 우리는 **봇 아바타를 서버가 조종**하기로 했고(bots.ts 머리말),          │
 * │ 봇 좌표는 사람과 같은 10Hz 스트림으로 나가야 한다(I1). 그래서 시뮬레이션 틱이   │
 * │ 필요하다. 대신 조건을 좁힌다:                                                │
 * │   · 사람이 1명 이상 접속해 있고 · 봇이 1기 이상일 때만 돈다                   │
 * │   · 마지막 사람이 나가면 즉시 멈춘다 → 빈 방은 평소처럼 잠든다                │
 * │   · evict로 타이머가 날아가도 30초 알람과 다음 수신 메시지가 되살린다          │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

import {
  BOT_CHAIN_CHANCE,
  BOT_CHAIN_MAX,
  BOT_DEFENSE_SILENCE_CHANCE,
  BOT_EMIT_JITTER_MS,
  BOT_JOIN_REACT_CHANCE,
  BOT_LEAVE_REACT_CHANCE,
  BOT_PERSIST_MS,
  BOT_SILENCE_CHANCE,
  BOT_TICK_MS,
  BOT_VOTE_CHANGE_CHANCE,
  BOT_VOTE_MAX_FRAC,
  BOT_VOTE_MIN_FRAC,
  CHAT_HISTORY_MAX,
  CHAT_MAX_LEN,
  CHAT_MIN_INTERVAL_MS,
  GAME_MSG_MIN_INTERVAL_MS,
  GATHER_DEADLINE_MS,
  GATHER_ROUND_BACKSTOP_MS,
  LOUNGE_TYPE_MAX_MS,
  MAX_GAME_MESSAGE_LEN,
  MAX_WS_MESSAGE_LEN,
  MOVE_MIN_INTERVAL_MS,
  PROTOCOL_VERSION,
  SOCKET_TIMEOUT_MS,
  SWEEP_ALARM_MS,
  VOTE_PROGRESS_INTERVAL_MS,
  WORLD_INTRO_MS,
  WORLD_SEAT_SLOTS,
  isChatLocked,
  mayMove,
  mayChat,
  shouldGather,
} from '../../lib/mp/constants';
import type { ErrorCode, PlayerSnapshot, RoundPhase, S2CMessage } from '../../lib/mp/protocol';
import { verifyTicket } from '../../lib/mp/ticket';
import { isC2SMessage, parseMove, parseVerdict, parseVote } from '../../lib/mp/validate';
import {
  botSnapshot,
  cancelSpeech,
  createBot,
  gatherBot,
  haltBot,
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
  spawnFor,
  stepBot,
  takeSpeech,
  toPose,
  type BotPose,
  type BotState,
} from './bots';
import {
  abortRound,
  castVerdict,
  castVote,
  eliminatedId,
  haveAllVoted,
  humanRole,
  pickActors,
  revealSnapshot,
  roundSnapshot,
  startRound,
  stepRound,
  voteProgress,
  type RoundState,
} from './roundtable';
import { gateCounts, gateStartsAt, stepGate, type GateState } from './gate';
import { postMatchReport } from './match-report';
import { fetchRoomMeta, type RoomMeta } from './room-meta';
import { fetchAgentLines, type ChatLine } from './world-agent';
import type { Env } from './bindings';

const KEY_META = 'meta';
const KEY_BOTS = 'bots';
const KEY_EMPTY_AT = 'emptyAt';
const KEY_ROUND = 'round';
const KEY_GATE = 'gate';
/** 게이트가 열릴 때 미리 뽑은 연기자 명단 (카드 선공개). 판이 열리면 지운다 */
const KEY_PENDING_ACTORS = 'pendingActors';

/**
 * 판이 이만큼 뒤처져 있으면 따라잡지 않고 **끝낸다** (ms).
 *
 * ┌─ 사람이 전부 나가면 판을 어떻게 하나 ─────────────────────────────────────┐
 * │ 마지막 사람이 나가면 stopSim 으로 틱이 멈추고 판이 그 자리에 얼어붙는다.    │
 * │ 그 상태로 며칠 뒤 누가 들어와 판이 이어지면 안 된다 —                      │
 * │  · 판정을 내릴 사람들이 이미 없다. 남의 판결을 낯선 사람이 이어받는 셈이다. │
 * │  · reveal 은 **정체를 공개하는 유일한 메시지**다 (I1의 예외). 그 판을 함께  │
 * │    보지 않은 사람에게 정체를 보여 줄 이유가 없다.                          │
 * │ 그래서 abortRound 로 ended 로만 끝낸다 — reveal 을 내지 않는다.            │
 * │                                                                          │
 * │ ★ 그런데 즉시 끝내면 안 된다. 새로고침은 "나감 → 들어옴"이라 한 명짜리 방은  │
 * │   매 새로고침마다 판이 죽는다. 45초를 준다 — 새로고침은 덮고, 진짜로 자리를  │
 * │   뜬 판은 못 덮는 길이다.                                                  │
 * │                                                                          │
 * │ ★ 판이 도는 동안에는 **봇이 0기여도 틱이 돈다**(startSim 참고). 그래서 이   │
 * │   문턱에 걸리는 경우는 사실상 "사람이 전부 나갔던 판" 하나뿐이다.           │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
const ROUND_ABANDON_MS = 45_000;

/**
 * 지목된 봇에게 던지는 최후변론 질문. LLM 맥락의 [지금 답할 질문]으로 들어간다
 * (app/api/internal/world-agent → lib/agent/generate.ts의 setting:'game' 분기).
 */
const DEFENSE_PROMPT = '너를 AI라고 지목했다. 마지막으로 할 말은?';

/**
 * 최후변론을 읽고 치기 시작하기까지 (ms). **readDelayMs()를 쓰지 않는다** —
 * 저쪽은 딴짓 분기가 최대 16초라 20초짜리 defense 창을 통째로 넘길 수 있고,
 * 그러면 upgradeSpeech의 예산(MIN_AGENT_BUDGET_MS)에도 걸려 LLM을 아예 안 부른다.
 * 지목당한 사람이 폰을 보다 말고 답하지는 않는다 — 짧은 게 오히려 자연스럽다.
 */
const DEFENSE_READ_MIN_MS = 700;
const DEFENSE_READ_MAX_MS = 2_500;

/**
 * ★ 임시 (2026-08-06): 봇 발화에 얹히는 **우리 쪽 지연을 전부 0으로** 만든다.
 *   남는 건 LLM 왕복뿐이고, 그게 지금 재려는 값이다.
 *
 * 끄는 것 — 읽는 시간 · 치는 시간 · 지터 · 최후변론 뜸(위 상수) · 뒷줄 사이 간격 ·
 * 틱 격자 대기(BOT_TICK_MS) · 좌석별 송신 위상(emitAsBot). LLM 답은 도착하는 즉시
 * 나간다 (게임 방도 라운지의 지각 경로를 탄다).
 *
 * ★ 스위치는 **이 파일에만** 둔다. bots.ts 안으로 넣어 지연 함수를 직접 0으로
 *   만들었더니 그 함수들을 지키는 I1 검사 12개가 한꺼번에 죽었다 (npm test).
 *   위장 규칙 자체는 그대로 두고 **부르는 자리에서** 건너뛴다 — 그래야 스위치를
 *   false 로 되돌렸을 때 규칙이 멀쩡하다는 게 검사로 증명된 상태다.
 *
 * 풀 문구 폴백은 그동안 죽는다 — 자리에 문구를 미리 채우면 같은 답이 두 번 나간다.
 * I1 위장(즉답 = 봇 신호)도 같이 꺼지므로 **측정이 끝나면 false 로 되돌린다.**
 */
const DISGUISE_OFF = true;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * 봇이 낸 표의 예약. **BotState에 담지 않는다.**
 *
 * ★ 근거: ensureMeta는 좌석 명단이 바뀌면 봇을 다시 만드는데(createBot이 speechSeq까지
 *   0으로 되돌린다), 예약을 BotState에 두면 **누가 접속한 순간 전 봇의 표가 사라진다.**
 *   이미 낸 봇이 또 내거나(중복), 예약이 사라져 영영 안 낸다 — 후자는 "투표 안 한 자리
 *   = 봇"이라 I1 정면 위반이다. 그래서 좌석 id를 키로 DO가 따로 들고, 판과 함께 굽는다.
 */
interface BotVotePlan {
  /** 이 시각에 표를 넣는다 (epoch ms) */
  at: number;
  targetId: string;
  cast: boolean;
  /** 표를 한 번 바꿀 시각. 안 바꾸면 null */
  changeAt: number | null;
  changeTargetId: string | null;
  changed: boolean;
}

interface BotVerdictPlan {
  at: number;
  guilty: boolean;
  cast: boolean;
}

/** 판 하나를 통째로 굽는 모양. 전부 구조화 복제 가능한 값이다. */
interface StoredRound {
  round: RoundState;
  botVotes: Record<string, BotVotePlan>;
  botVerdicts: Record<string, BotVerdictPlan>;
}

/** 방 메타(좌석 명단) 캐시 수명. 이보다 자주 사람이 들어오면 pid 미발견 시 강제 갱신된다. */
const META_TTL_MS = 60_000;

/**
 * **아직 시작되지 않은 방**의 짧은 캐시 수명 (ms).
 *
 * `startedAt`(rooms.world_started_at)은 null → 값으로 딱 한 번 넘어가고, 그 순간
 * 이 방에 집결 게이트가 생긴다. 60초 캐시를 그대로 두면 그 전환을 최대 1분 늦게
 * 보는데, 인트로가 63초짜리(카운트다운 20 + 영상 43)라 **게이트가 생기기 전에 판이
 * 열려 버린다** — 시작 직전에 누가 이 방의 월드에 서 있었을 때 그렇게 된다.
 * 값이 정해진 뒤로는(startedAt != null) 다시 평소 수명으로 돌아간다.
 */
const META_START_TTL_MS = 10_000;

/**
 * 이만큼도 안 남았으면 LLM을 아예 부르지 않는다 (ms). 게임 방 전용 —
 * 왕복이 이 안에 끝날 리 없으므로, 부르면 남의 지갑만 쓰고 결과는 버려진다.
 * 월드 AI 방은 늦은 답도 말하므로 이 문턱을 안 본다 (upgradeSpeech 참고).
 */
const MIN_AGENT_BUDGET_MS = 900;

/**
 * 월드 AI 방에서 LLM을 기다려 주는 상한 (ms). 예약 시각(speakAt)에 매이지 않는다 —
 * 풀 문구가 없는 방이라 자리를 놓친 답은 버리면 그냥 침묵인데, 사용자 결정은
 * "어색한 풀 문구 < 침묵 < 늦은 진짜 답"이다. 월드 AI 의 LLM 컷 10초
 * (world-agent 가 deadline_ms 로 늘린다 — 게임 방은 8초 그대로, SPEC §12.3)
 * + self-fetch 왕복 여유.
 */
const COMPANION_AGENT_TIMEOUT_MS = 12_000;

interface CachedMeta extends RoomMeta {
  fetchedAt: number;
  /**
   * 이 DO가 맡은 방. HTTP 경로에서만 알 수 있는 값이라 여기 같이 구워 둔다 —
   * evict 뒤에는 fetch()를 다시 안 타고 webSocketMessage로 되살아나므로,
   * 안 구워 두면 그 뒤로 봇 반응(upgradeSpeech)이 조용히 멈춘다.
   */
  roomId: string;
}

export class RoomDO {
  private meta: CachedMeta | null = null;
  private bots: BotState[] | null = null;
  private simTimer: number | null = null;
  private lastTickAt = 0;
  private lastPersistAt = 0;
  /** 소켓별 마지막 채팅 시각. 잃어도 무해하므로 storage에 넣지 않는다. */
  private lastChatAt = new WeakMap<WebSocket, number>();
  /** 소켓별 마지막 이동 시각. 위와 같은 이유로 메모리에만 둔다. */
  private lastMoveAt = new WeakMap<WebSocket, number>();
  /** 소켓별 마지막 게임 메시지(vote·verdict·intro_done) 시각. 자원 보호용 (L1). */
  private lastGameMsgAt = new WeakMap<WebSocket, number>();
  /**
   * 좌석별 **마지막으로 알려진 자세.** 소켓이 끊겨도 명부에서 그 자리가 사라지지
   * 않게 하는 값이다 (seatSnapshots 의 상자 — I1).
   *
   * 메모리에만 둔다. evict 로 날아가면 그 좌석이 스폰 자리로 돌아갈 뿐인데,
   * 그건 봇도 마찬가지고(BotPose 는 5초마다만 굽는다) 사람이 재접속해도 같은 일이
   * 일어난다 — 자리 단위 차이가 아니다.
   */
  private lastPose = new Map<string, PlayerSnapshot>();
  /**
   * 봇 좌석별 **송신 위상 오프셋** (ms, 0~BOT_EMIT_JITTER_MS).
   *
   * ★ I1 (BOT_EMIT_JITTER_MS 의 상자): 이게 없으면 봇 N기의 player_moved 가 같은
   *   이벤트 루프 턴에 나가 **같은 배치로 도착**한다. 도착 시각으로 클러스터링하면
   *   봇 집합이 통째로 갈린다. 좌석마다 고정이라 사람의 안정적인 송신 위상과 닮는다.
   */
  private emitPhase = new Map<string, number>();
  /**
   * 최근 채팅. 사람·봇 것을 같이 담는다 (id로 나중에 가른다).
   *
   * 월드 채팅은 저장하지 않으므로(SPEC §6.1의 messages와 별개다) 이게 유일한 기록이고,
   * evict로 날아가도 무해하다 — 비면 "방금 나온 문구 피하기"만 못 할 뿐이다.
   * LLM이 붙으면(3단계) 여기가 그대로 대화 맥락이 된다.
   */
  private chatLog: { id: string; nickname: string; text: string }[] = [];
  /**
   * 사람이 마지막으로 말한 뒤로 봇이 봇에게 몇 번 대꾸했나 (maybeChain).
   * 사람이 한마디 하면 0으로 돌아간다. 잃어도 무해하므로 메모리에만 둔다.
   */
  private botChainHops = 0;

  /**
   * 진행 중인 판. **단계가 바뀔 때마다 storage에 굽는다** (매 틱 아니다 — 100ms마다
   * 쓰면 그게 곧 과금이다). null이면 아직 안 열렸거나 아직 storage에서 안 읽었다.
   */
  private round: RoundState | null = null;
  /** storage를 한 번은 봤는가. 없는 키를 매번 읽지 않으려는 표시일 뿐이다. */
  private roundLoaded = false;
  private botVotes: Record<string, BotVotePlan> = {};
  private botVerdicts: Record<string, BotVerdictPlan> = {};
  /** 마지막으로 내보낸 vote_progress의 voted 값. -1이면 아직 안 보냈다. */
  private progressSent = -1;
  private progressAt = 0;

  /** 집결 게이트. null 이면 아직 storage 에서 안 읽었다 (GateState 의 상자). */
  private gate: GateState | null = null;
  private gateLoaded = false;
  /** 마지막으로 내보낸 gate 의 present 값. -1이면 아직 안 보냈다 (같은 값 재전송 방지). */
  private gateSent = -1;
  /**
   * 게이트가 열릴 때 미리 뽑아 나눠준 연기자 명단 — **카드 선공개** (사용자 결정
   * 2026-08-06: 역할 카드는 전원 집결 + 카운트다운 시작 순간에 뜬다). 판이 열리면
   * startRound 가 이 명단을 그대로 이어받고(presetActorIds) 여기는 비워진다 —
   * 두 번 뽑으면 카드와 판의 역할이 갈린다.
   */
  private pendingActors: string[] | null = null;
  private pendingActorsLoaded = false;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    // 플랫폼이 대신 pong을 돌려준다 → 하트비트가 DO를 깨우지 않는다.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /* ─────────────────────────────── HTTP ─────────────────────────────── */

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // index.ts가 /rooms/<uuid>/(ws|info) 형태만 넘긴다. 소문자로 맞춘다 —
    // 티켓의 rid는 DB가 준 소문자 uuid라 대소문자가 다르면 unauthorized가 된다.
    const roomId = (url.pathname.split('/')[2] ?? '').toLowerCase();

    if (url.pathname.endsWith('/info')) {
      return this.info(roomId);
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('websocket 업그레이드가 아니다', { status: 400 });
    }
    return this.upgrade(request, url, roomId);
  }

  /**
   * 로비용 요약. **접속자 수를 내보내지 않는다** —
   * 사람 수를 알면 정원에서 빼서 봇 수가 나오고, 그건 I1 위반이다.
   * 좌석은 봇이 채우므로 occupied는 사실상 항상 정원과 같다.
   */
  private async info(roomId: string): Promise<Response> {
    const meta = await this.ensureMeta(roomId, false);
    const body = meta
      ? { capacity: meta.capacity, occupied: meta.seats.length, phase: meta.phase }
      : { capacity: 0, occupied: 0, phase: null };
    return Response.json(body, {
      headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
    });
  }

  /* ─────────────────────────────── 입장 ─────────────────────────────── */

  /**
   * 업그레이드 시점에 전부 판정한다. join 메시지를 따로 두지 않는 이유는
   * "인증 안 된 소켓이 잠깐 열려 있는" 구간을 없애기 위해서다.
   * 순서가 곧 방어선이다: 버전 → 티켓 → 방 → 좌석 → 정원 → 중복 소켓.
   */
  private async upgrade(request: Request, url: URL, roomId: string): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const reject = (code: ErrorCode): Response => {
      // accept 전에 끊는다. 이유를 한 줄 알려주고 닫아야 클라이언트가 재시도를 판단한다.
      server.accept();
      server.send(JSON.stringify({ t: 'error', code } satisfies S2CMessage));
      server.close(4000, code);
      return new Response(null, { status: 101, webSocket: client });
    };

    // ① 프로토콜 버전
    if (Number(url.searchParams.get('v')) !== PROTOCOL_VERSION) {
      return reject('version_mismatch');
    }

    // ② 티켓 — 닉네임·좌석은 여기서 서명된 값만 쓴다. 클라이언트가 보낸 값은 보지 않는다.
    const ticket = await verifyTicket(
      url.searchParams.get('t') ?? '',
      this.env.WORLD_SHARED_SECRET,
      Math.floor(Date.now() / 1000),
    );
    if (!ticket || ticket.rid !== roomId) return reject('unauthorized');

    // ②′ 판이 도는 동안에는 새 얼굴을 받지 않는다 (2026-08-05 결정 — 첫 주제부터 판 끝까지).
    //    판 명단(seatIds — 시작 시점에 동결)에 있는 사람의 재접속은 통과한다. 새로고침이
    //    막히면 안 되니까. ★ 반드시 ③(명부 갱신)보다 먼저다 — 거절할 사람 때문에
    //    ensureMeta(force)가 판 중간에 명부를 다시 읽으면, 그 사람의 DB 좌석이 유령
    //    아바타로 나타나고 월드 AI 가 판 중간에 이사한다 (ensureMeta 의 판-동결 상자).
    await this.ensureRound();
    if (this.round && !this.round.done && !this.round.seatIds.includes(ticket.pid)) {
      return reject('round_in_progress');
    }

    // ③ 방 메타. 티켓의 pid가 명단에 없으면 방금 들어온 사람일 수 있으니 한 번 갱신한다.
    let meta = await this.ensureMeta(roomId, false);
    if (meta && !meta.seats.some((s) => s.id === ticket.pid)) {
      meta = await this.ensureMeta(roomId, true);
    }
    if (!meta) return reject('room_unavailable');

    // ④ 좌석 확인. 봇 자리로는 들어올 수 없다 — 티켓을 위조해도 여기서 걸린다.
    const seat = meta.seats.find((s) => s.id === ticket.pid);
    if (!seat || seat.is_bot) return reject('unauthorized');

    // ⑤ 정원. 좌석은 DB가 배정하므로 보통 걸리지 않지만, 안 걸어두면 터질 때 조용히 터진다.
    if (this.ctx.getWebSockets().length >= meta.capacity) return reject('room_full');

    // ⑥ 같은 사람의 기존 소켓 정리 (중복 탭 · 새로고침 잔재).
    //    안 지우면 새로고침할 때마다 유령이 한 명씩 는다.
    //    ★ 여기서도 player_left 를 내지 않는다 — 같은 좌석이 곧바로 다시 들어오므로
    //      명부에서 지웠다 넣으면 그 깜빡임이 곧 "사람이 새로고침했다" 는 신호다 (I1).
    for (const other of this.ctx.getWebSockets()) {
      const s = other.deserializeAttachment() as PlayerSnapshot | null;
      if (s?.id === ticket.pid) other.close(4002, 'superseded');
    }

    // ⑦ 상태 구성 → accept → 명부 교환
    // 좌석 원은 **정원이 아니라 WORLD_SEAT_SLOTS 로** 나눈다 — 사람이 8자리를 다
    // 채우면 AI 가 9번에 서기 때문이다 (lib/mp/constants.ts 의 상자).
    const start = spawnFor(ticket.seat, WORLD_SEAT_SLOTS);
    const snapshot: PlayerSnapshot = {
      id: ticket.pid,
      seat: ticket.seat,
      nickname: ticket.nick,
      maskId: ticket.mask,
      x: start.x,
      z: start.z,
      y: 0, // 바닥에서 시작한다. 공중 스폰은 없다
      heading: 0,
      anim: 'idle',
    };

    // 봇을 먼저 세운다 — 명부(seatSnapshots)가 봇 좌표를 읽어야 한다.
    await this.ensureBots(meta);
    // ★ accept 전에 모아야 한다. 뒤에 모으면 이 소켓이 humanSnapshots 에 섞여
    //   자기 자신이 명부에 두 번 들어간다.
    const roster = this.seatSnapshots(meta, snapshot);

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(snapshot);

    this.send(server, { t: 'welcome', selfId: snapshot.id, players: roster });

    // ★ `player_joined` 를 여기서 **보내지 않는다** (I1 — seatSnapshots 의 상자).
    //   이 좌석은 이미 방 전원의 명부에 들어 있다(그들도 좌석 명단으로 welcome 을
    //   받았다). 접속할 때마다 이벤트를 내면 **사람에게만** 나는 이벤트가 되고,
    //   거기 한 번이라도 등장한 id 는 사람 확정이다. 새로고침 한 번이면 아웃된다.
    //   명부가 실제로 늘어나는 경우(좌석 추가)는 ensureMeta 가 사람·봇 구분 없이 낸다.

    // 판이 돌고 있으면 **지금 단계를 이 소켓 하나에** 알려 준다. 안 보내면 판 중간에
    // 들어온 사람의 화면이 'idle'로 멈춘 채 4분을 서 있는다.
    // ★ revealSnapshot 은 여기서 **절대** 부르지 않는다 — 정체를 실어 나르는 메시지는
    //   그것 하나뿐이고(I1의 유일한 예외), 판을 함께 보지 않은 사람에게 결말만 던져
    //   줄 이유가 없다. roundSnapshot 은 nomineeId·spotlightId 를 단계로 막아 준다.
    await this.ensureRound();
    if (this.round) {
      this.send(server, { t: 'round', ...roundSnapshot(this.round) });
      // 자기 역할은 재접속 때도 다시 알려준다 — 새로고침하면 로컬엔 아무것도 없다.
      // humanRole 은 봇·판 밖 좌석이면 null 이라 여기서 보낼 게 없다 (§18.2).
      const role = humanRole(this.round, snapshot.id);
      if (role) this.send(server, { t: 'role', role });
    } else {
      // 게이트는 열렸는데 판은 아직인 구간(카운트다운·인트로)의 접속 — 미리 뽑아 둔
      // 역할을 준다. 마감으로 열려 늦게 온 사람과 새로고침한 사람이 여기로 온다.
      await this.ensurePendingActors();
      const role = this.earlyRole(snapshot.id);
      if (role) this.send(server, { t: 'role', role });
    }

    /*
     * 집결 게이트 — 이 좌석의 도착을 명단에 넣고, 다 모였으면 연다.
     * ★ 방송이 안 나갔으면 이 소켓에만 따로 보낸다. 방송은 값이 바뀔 때만 나가므로
     *   (이미 도착했던 좌석의 재접속·게이트가 이미 열린 방), 안 보내면 새로고침한
     *   사람의 화면이 대기 상태로 굳는다 — 판 중간 입장자에게 round 를 개별로
     *   보내는 것과 같은 이유다.
     */
    if (!(await this.maybeOpenGate(Date.now()))) {
      const gate = this.gateSnapshot();
      if (gate) this.send(server, gate);
    }

    await this.ctx.storage.delete(KEY_EMPTY_AT);
    await this.ensureAlarm();
    this.startSim();

    // 누가 들어왔다 — 라운지라면 봇 하나가 아는 척할 수 있다. 사람은 문이 열리면
    // 웬만하면 한마디 한다 (BOT_JOIN_REACT_CHANCE).
    // ★ startSim 뒤라야 한다. 틱이 안 돌면 예약해 둔 말을 꺼낼 사람이 없다.
    this.reactToEvent(Date.now(), `${snapshot.nickname} 들어옴`, BOT_JOIN_REACT_CHANCE);

    return new Response(null, { status: 101, webSocket: client });
  }

  /* ─────────────────────────── WebSocket 수신 ─────────────────────────── */

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > MAX_WS_MESSAGE_LEN) return;
    // 상한에 걸려 버릴 때는 로그를 남긴다. 조용한 드롭은 원인 찾는 데 하루가 걸린다.
    if (message.length > MAX_GAME_MESSAGE_LEN) {
      console.warn(`[room] 메시지가 너무 크다 (${message.length}B). 버린다`);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (!isC2SMessage(parsed)) return;

    const snap = ws.deserializeAttachment() as PlayerSnapshot | null;
    if (!snap) return;

    // evict로 시뮬레이션이 죽어 있었다면 여기서 되살아난다.
    await this.reviveIfNeeded();

    switch (parsed.t) {
      case 'move': {
        // 한 소켓이 이동을 쏟아부으면 DO가 방 전원에게 N배로 증폭해 뿌린다.
        // 클라이언트의 10Hz 약속을 믿지 않고 서버가 바닥을 깐다 (MOVE_MIN_INTERVAL_MS).
        const nowMs = Date.now();
        if (nowMs - (this.lastMoveAt.get(ws) ?? 0) < MOVE_MIN_INTERVAL_MS) return;
        this.lastMoveAt.set(ws, nowMs);

        // 처형된 자리는 더 안 움직인다. **역방향 누출을 막는 줄이다** (I1):
        // 봇이 처형되면 서버가 조종을 멈추는데, 사람이 처형됐을 때만 아바타가
        // 계속 꿈틀대면 "쓰러진 뒤에도 움직인 자리 = 사람"이 된다.
        if (this.round && eliminatedId(this.round) === snap.id) return;

        // ★★ 이동이 잠긴 단계에서는 사람 좌표도 받지 않는다 (I1 — mayMove 의 상자).
        //    클라도 같은 함수로 입력을 막지만, **거기서만 막으면 소켓으로 우회된다** —
        //    그리고 봇은 이 구간에서 단 한 패킷도 안 내므로, 우회한 한 사람 때문에
        //    나머지 전원이 소거법으로 갈린다.
        //    잠금 전환 순간의 인플라이트 패킷도 여기서 같이 잘린다.
        //
        // ★ defense 는 지목된 자리 하나만 막는다. 지목된 봇도 haltBot 으로 똑같이
        //   서므로(tick) 그 자리의 정체는 여전히 안 갈린다.
        if (!mayMove(this.phase(), snap.id === (this.round?.nomineeId ?? null))) return;

        const move = parseMove(parsed);
        if (!move) return; // NaN 하나가 통과하면 모든 클라의 보간이 영구히 깨진다

        snap.x = move.x;
        snap.z = move.z;
        snap.y = move.y;
        snap.heading = move.heading;
        snap.anim = move.anim;
        // 새로 들어오는 사람의 welcome에 반영되도록 attachment를 갱신한다.
        ws.serializeAttachment(snap);

        this.broadcast(
          {
            t: 'player_moved',
            id: snap.id,
            x: snap.x,
            z: snap.z,
            y: snap.y,
            heading: snap.heading,
            anim: snap.anim,
          },
          ws,
        );
        return;
      }

      case 'chat': {
        const raw = (parsed as { text?: unknown }).text;
        if (typeof raw !== 'string') return;
        const text = raw.trim().slice(0, CHAT_MAX_LEN);
        if (!text) return;

        // ★★ 말이 잠긴 단계에서는 사람 채팅도 거절한다 (I1 — mayChat 의 상자).
        //    이 구간에서 봇의 발화 확률은 **정확히 0** 이다(botsMayChat · hushBots).
        //    확률적 잡음이 없으므로 사람이 한 줄만 쳐도 그 자리가 사람으로 확정되고,
        //    총 자리·AI 수가 공개라 소거법으로 나머지가 따라 갈린다.
        //    클라 UI 도 같은 함수로 막지만 그건 편의고, 방어선은 여기다.
        //    ★ 지금 잠기는 단계는 reveal 하나다 — defense 에 이어 vote·verdict 도
        //      열었다 (2026-08-07, 사용자 지시). 여는 방식은 언제나 같다: 목록에서
        //      빼서 **봇과 사람을 동시에** 연다. 한쪽만 열면 그게 곧 I1 누출이다.
        if (!mayChat(this.phase(), snap.id === this.round?.nomineeId)) return;

        const now = Date.now();
        if (now - (this.lastChatAt.get(ws) ?? 0) < CHAT_MIN_INTERVAL_MS) return;
        this.lastChatAt.set(ws, now);

        // 닉네임·시각은 서버 값만 쓴다. 본인도 포함해 보낸다 —
        // 낙관적 로컬 에코를 하면 내 화면과 남의 화면에서 순서가 달라진다.
        this.broadcast({ t: 'chat', id: snap.id, nickname: snap.nickname, text, ts: now });
        this.rememberChat(snap.id, snap.nickname, text);

        // 사람이 말했으니 봇→봇 연쇄를 처음으로 되돌린다. 이 값이 하는 일은
        // "봇들끼리 몇 마디까지 주고받아도 되나"를 세는 것뿐이다 (maybeChain).
        this.botChainHops = 0;

        // 봇 하나가 대꾸할 수도 있다. **연쇄의 시작은 언제나 사람 발화다** —
        // 봇 발화에 붙는 대꾸는 maybeChain이 상한을 세면서 따로 건다.
        this.reactToHuman(now, text);
        return;
      }

      case 'intro_done': {
        // 첫 신호에만 판이 열린다. 나머지는 maybeStartRound가 그냥 돌아선다 —
        // 여러 사람이 제각기 보내고, 그중 누가 먼저인지는 아무 의미가 없다.
        if (!this.allowGameMessage(ws)) return;
        await this.ensureRound();
        await this.maybeStartRound(Date.now());
        return;
      }

      case 'vote': {
        if (!this.allowGameMessage(ws)) return;
        const s = this.round;
        if (!s) return;
        const v = parseVote(parsed);
        if (!v) return;
        // ★ 투표자는 **소켓에서** 되찾은 snap.id 다. 클라가 보낸 id는 애초에 받지 않는다
        //   (프로토콜 규칙 4) — 받으면 남의 이름으로 찍을 수 있다.
        // 거절돼도 아무것도 돌려주지 않는다. 에러를 내려주면 "왜 거절됐는지"가
        // 단계·좌석 정보로 새고, 자기 자신 투표 거부 여부까지 관측된다 (I1).
        castVote(s, snap.id, v.targetId, Date.now());
        // 진행 카운터는 여기서 즉시 쏘지 않는다 — VOTE_PROGRESS_INTERVAL_MS 참고.
        // 사람 표만 즉시 나가면 봇 표(틱 배차)와 도착 시각으로 갈린다.
        return;
      }

      case 'verdict': {
        if (!this.allowGameMessage(ws)) return;
        const s = this.round;
        if (!s) return;
        const v = parseVerdict(parsed);
        if (!v) return;
        castVerdict(s, snap.id, v.guilty, Date.now());
        return;
      }

      case 'rematch': {
        // 한 판 더 — **끝난 판에서만**. intro_done 과 같은 "첫 신호만" 규칙이다:
        // 첫 rematch 가 판을 비우고 새로 열면, 나머지는 round 가 살아 있어
        // maybeStartRound 첫 줄에서 그냥 돌아선다.
        if (!this.allowGameMessage(ws)) return;
        if (!this.round?.done) return;
        this.round = null;
        // 저장본도 지운다 — 새 판이 어떤 이유로 못 열리면(좌석 0) DO 재기동 때
        // 끝난 판이 되살아나 rematch 가 영영 막힌다.
        await this.ctx.storage.delete(KEY_ROUND);
        await this.maybeStartRound(Date.now());
        return;
      }

      default:
        return; // 전방 호환. 모르는 타입은 무시한다
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.handleLeave(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.handleLeave(ws);
  }

  private async handleLeave(ws: WebSocket): Promise<void> {
    const snap = ws.deserializeAttachment() as PlayerSnapshot | null;
    // ★ `player_left` 를 **보내지 않는다** (I1 — seatSnapshots 의 상자).
    //   이 이벤트는 사람에게만 났다. 봇은 영원히 안 나가므로, 4분짜리 판에서
    //   한 번이라도 여기 등장한 id 는 그대로 사람 확정이었다. 대신 마지막 자세를
    //   기억해 두고 아바타는 명부에 남긴다 — 가만히 서 있는 사람과 구분되지 않는다.
    //   좌석이 실제로 없어지는 경우만 ensureMeta 가 사람·봇 구분 없이 낸다.
    if (snap) this.lastPose.set(snap.id, snap);

    if (this.humanCount() === 0) {
      this.stopSim();
      await this.ctx.storage.put(KEY_EMPTY_AT, Date.now());
      await this.persistBots();
      // 판은 여기서 얼어붙는다 — **끝내지 않는다.** 새로고침은 "나감 → 들어옴"이라
      // 한 명짜리 방은 매 새로고침마다 판이 죽어 버린다. 실제 종료 판정은
      // 다시 누가 들어와 틱이 돌 때 driveRound 가 한다 (ROUND_ABANDON_MS 의 상자).
      await this.saveRound();
      return; // 아무도 안 남았으면 들을 사람도 없다
    }

    // 아직 사람이 남아 있다. 나간 걸 두고 한마디 할 수도 있다 — 들어올 때보다 드물다.
    // 새로고침은 여기(4002 superseded)와 입장이 잇달아 오는데, 쿨다운에 걸려
    // 둘 중 하나만 나간다. 그게 사람이 보는 모습에 가깝다.
    if (snap) this.reactToEvent(Date.now(), `${snap.nickname} 나감`, BOT_LEAVE_REACT_CHANCE);
  }

  /* ─────────────────────────────── 알람 ─────────────────────────────── */

  /**
   * DO의 알람 슬롯은 **하나뿐이다.** 주기 작업을 전부 여기서 처리하고 다음 알람을 다시 잡는다.
   *  ① 유령 소켓 청소 (half-open은 close 이벤트가 오지 않는다)
   *  ② evict로 죽은 시뮬레이션 복구
   *  ③ 사람이 없으면 알람 체인을 **끝낸다** — 재예약하면 빈 DO가 영원히 깨어나 과금된다
   */
  async alarm(): Promise<void> {
    const now = Date.now();

    for (const ws of this.ctx.getWebSockets()) {
      const last = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      // ping을 한 번도 안 보낸 소켓(테스트 스크립트 등)은 건드리지 않는다.
      if (last !== null && now - last.getTime() > SOCKET_TIMEOUT_MS) {
        await this.handleLeave(ws);
        ws.close(4001, 'heartbeat_timeout');
      }
    }

    if (this.humanCount() === 0) {
      this.stopSim();
      await this.persistBots();
      return; // 체인 종료
    }

    await this.reviveIfNeeded();

    // 라운지에서는 명부를 주기적으로 따라잡는다 (META_TTL 이 과호출을 막는다).
    // 월드 AI 는 방이 생기고 잠시 뒤에 합류하므로(lib/server/world-ai.ts 지연 합류),
    // **접속 이벤트가 없어도** 새 좌석을 집어와야 한다 — 혼자 서 있는 방장 화면에
    // AI 가 걸어 들어오는 경로가 이 알람뿐이다. 판이 도는 동안은 ensureMeta
    // 첫머리의 판-동결이 알아서 거른다.
    if (this.meta) {
      await this.ensureMeta(this.meta.roomId, false);
      // 봇이 0기 → 1기가 된 방은 틱 타이머가 여기서 처음 돈다 (startSim 조건).
      this.startSim();
    }

    /*
     * 집결 게이트의 **시간 축은 여기 하나뿐이다.** 틱(startSim)은 봇이 0기이고 판도
     * 없는 방 — 즉 사람만 모인 방 — 에서 아예 안 도므로 상한을 못 건다.
     *  ① 상한(GATHER_DEADLINE_MS): 안 들어온 사람이 있어도 연다
     *  ② 백스톱: 게이트는 열렸는데 아무도 intro_done 을 못 보낸 방을 연다
     */
    await this.maybeOpenGate(now);
    await this.maybeBackstopRound(now);

    await this.persistBots();
    await this.ctx.storage.setAlarm(this.nextAlarmAt(now));
  }

  /**
   * 다음 알람 시각. 평소엔 30초 뒤지만 **판이 도는 동안에는 다음 단계 마감에 맞춘다.**
   *
   * 판이 도는 방은 봇이 0기여도 틱 타이머가 돌지만(startSim), evict 로 그 타이머가
   * 죽으면 다음 알람까지 아무도 판을 굴리지 않는다. 30초를 통째로 흘려보내면
   * 30초짜리 투표가 60초가 된다 — 단계 길이가 흔들리는 건 그 자체로 I1 위험이다(§5.3).
   */
  private nextAlarmAt(now: number): number {
    const sweep = now + SWEEP_ALARM_MS;
    // 최소 1초 — 마감이 이미 지났어도 알람이 폭주하지 않게 바닥을 깐다.
    const soon = (at: number): number => Math.min(sweep, Math.max(now + 1_000, at + 100));

    const s = this.round;
    if (s && !s.done) return soon(s.phaseEndsAt);

    /*
     * 판이 없는 방이라도 게이트가 걸려 있으면 **시간에 맞춰 깨어나야 한다.**
     * 30초 스윕에만 기대면 상한이 최대 30초 늦게 걸리고, 그동안 방 전원이
     * 아무 설명 없는 대기 화면을 본다.
     */
    if (this.gateRequired() && !this.round) {
      const openedAt = this.gate?.openedAt ?? null;
      const at =
        openedAt === null
          ? (this.meta?.startedAt ?? now) + GATHER_DEADLINE_MS
          : openedAt + WORLD_INTRO_MS + GATHER_ROUND_BACKSTOP_MS;
      // ★ 지난 시각이면 스윕으로 돌아간다. `now + 1초`를 계속 돌려주면 판이 못 열리는
      //   방(좌석 0 · 한 판 더가 실패한 방)에서 알람이 초당 한 번씩 영원히 깨어난다.
      if (at > now) return soon(at);
    }
    return sweep;
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_ALARM_MS);
    }
  }

  /* ─────────────────────────── 봇 시뮬레이션 ─────────────────────────── */

  private startSim(): void {
    if (this.simTimer !== null) return;
    // ★ "봇이 1기 이상"이 아니라 **"봇이 있거나 판이 돌고 있다"** 이다.
    //   판 진행(driveRound)이 이 틱에 얹혀 있는데 예전 조건 그대로 두면,
    //   봇이 0기인 방 — 즉 사람만 모여서 테스트하기 제일 쉬운 방 — 에서 타이머가
    //   아예 안 돌아 판이 topic 에서 영원히 멈춘다.
    //   덤으로 판이 도는 동안 DO가 잠들지 않는다: 투표 중에는 아무도 안 움직여서
    //   (포인터락이 풀려 있다) 깨울 메시지조차 없다.
    if ((!this.bots || this.bots.length === 0) && !this.roundActive()) return;
    if (this.humanCount() === 0) return;

    this.lastTickAt = Date.now();
    this.simTimer = setInterval(() => {
      void this.tick();
    }, BOT_TICK_MS) as unknown as number;
  }

  private stopSim(): void {
    if (this.simTimer === null) return;
    clearInterval(this.simTimer);
    this.simTimer = null;
  }

  /** evict 후 첫 이벤트에서 메타·봇·판·타이머를 되살린다. */
  private async reviveIfNeeded(): Promise<void> {
    if (this.simTimer !== null) return;
    if (this.humanCount() === 0) return;

    const meta = this.meta ?? (await this.loadMeta());
    if (!meta) return;
    await this.ensureBots(meta);
    await this.ensureRound();
    await this.ensureGate();
    this.startSim();
  }

  private tick(): void {
    const now = Date.now();
    const dt = Math.min((now - this.lastTickAt) / 1000, 0.5);
    this.lastTickAt = now;

    const bots = this.bots ?? [];
    if (this.humanCount() === 0 || (bots.length === 0 && !this.roundActive())) {
      this.stopSim();
      return;
    }

    // ★ 봇보다 먼저 굴린다. 단계가 이 틱에 바뀌면 그 결정(봇 표 예약·변론 예약·
    //   발 묶기)이 같은 틱의 봇 루프에 곧바로 반영돼야 한다.
    this.driveRound(now);

    // 투표·판결·공개 화면이 뜨는 동안에는 봇도 그 자리에 선다 (haltBot의 상자 — I1).
    // ★ defense 는 좌석마다 다르다 — 지목된 자리만 서고 나머지 봇은 걷는다.
    //   그래서 여기서 한 번에 정하지 못하고 루프 안에서 봇마다 묻는다 (mayMove).
    const nomineeId = this.round?.nomineeId ?? null;
    const phase = this.phase();
    // 중앙 스크린에 읽을 것이 떠 있는 단계에서만 목적지를 테이블 주변으로 좁힌다.
    // 주제를 읽으러 모인 사람들 사이에서 혼자 창고 구석으로 걸어가면 그게 곧 표식이다
    // (randomPoint, I1). **반대로 freechat 에서는 사람이 흩어지므로 봇도 푼다** —
    // 단계 목록은 lib/mp/constants.ts 의 BOT_GATHER_PHASES 하나뿐이다.
    const gather = shouldGather(phase);

    for (const bot of bots) {
      // ① 말할 때가 됐으면 **예약만** 한다. 여기서 바로 broadcast하면 걸어가면서
      //    말풍선이 뜬다 — 사람은 타이핑 중 발이 묶이므로 그게 곧 봇 표식이다 (I1).
      //    stepBot보다 먼저 걸어야 같은 틱에 발이 묶인다.
      //    스스로 꺼내는 말이라 읽는 시간은 없다 — 읽을 게 없으니 바로 친다.
      //
      // ★ 직전 발화가 봇 것이면 얹지 않는다 — LLM이 대화를 이어 쓰다가 **자기가
      //   던진 질문에 자기가 답하는** 그림이 된다 (실측 — 사용자 결정으로 금지).
      //   shouldChat이 nextChatAt을 이미 미뤘으므로 이번 차례만 쉰다. 사람 발화가
      //   끼면 다음 차례에 다시 말한다 (shouldChat 의 mayInitiate 상자).
      //
      //   판정은 자기 것이 아니라 **어느 봇이든**이다 (humanSpokeLast). 자기만 보면
      //   봇 둘이 서로의 발화를 핑퐁으로 받아 끝없이 주고받는다. 루프 안에서 매번
      //   다시 보므로, 앞 봇이 이 틱에 말했으면(③) 뒤 봇은 막힌다.
      //
      // ★ speak 페이즈에서는 mayInitiate 를 묻지 않는다. 저 규칙("마지막 발화가 봇이면
      //   쉰다")은 **대화를 받는** 자리를 위한 것인데, speak 은 전원이 같은 주제에
      //   각자 답하는 창이라 남이 먼저 답했다고 내 답이 막히면 안 된다. 막아 두면
      //   먼저 말한 자리만 답하고 나머지가 통째로 조용해진다 — 그게 곧 덩어리다 (I1).
      //
      // ★ botsMayChat 을 **shouldChat 뒤에** 본다. 앞에 두면 말 못 하는 단계 동안
      //   nextChatAt 이 안 밀려서, 투표가 끝나는 순간 밀린 타이머가 **전 봇에서 한꺼번에
      //   터진다** — 그 동시 발화가 곧 명단이다 (I1). shouldChat 은 막히든 말든 다음
      //   시각을 다시 잡아 준다(그 함수의 상자).
      const speakWindow = this.speakTopic();
      const wantsChat = shouldChat(bot, now, speakWindow !== null || this.humanSpokeLast());
      if (wantsChat && this.botsMayChat()) {
        // 라운지는 위장 지연 없이 LLM 이 오는 대로 말한다 (scheduleInstantSpeech 상자).
        // 로비 방은 풀이 비어 있어 null이 온다 — 자리만 잡히고 문구는 LLM이 채운다.
        if (DISGUISE_OFF || this.isLounge()) scheduleInstantSpeech(bot, now);
        else scheduleSpeech(bot, pickLine(this.botLines(), this.recentTexts()), now);
        // ★ 스스로 꺼내는 말도 LLM 을 태운다. 안 태우면 이 자리는 아무 말도 못 한다
        //   (예전에는 평생 풀 문구만 말했고, 사용자가 본 게 정확히 그거였다).
        //   trigger 는 없다(답할 상대가 없으니 흐름에 끼어드는 게 맞다).
        //
        // ★ 단 speak 페이즈에서는 **지금 주제**를 trigger 로 싣는다. 그래야 LLM 맥락의
        //   [지금 답할 질문] 분기를 타고 그 주제에 답한다. 안 실으면 SPEC §17.2가
        //   기록한 사고가 그대로 재현된다 — "배터리 몇 퍼센트야?"에 "어제랑 비슷했던
        //   것 같아". 첫 질문 한 번으로 봇이 전부 갈렸다.
        //   LLM이 없는 방은 풀 문구가 그대로 나간다(폴백 유지).
        void this.upgradeSpeech(bot, bot.speechSeq, speakWindow);
      }

      // ② 굴린다. 예약이 걸려 있으면 stepBot이 세워 둔다.
      //    투표 화면이 떠 있는 동안에는 굴리지 않고 세운다 — 사람은 포인터락이 풀려
      //    한 발짝도 못 움직이는 구간이다 (haltBot, I1).
      //
      // ★ defense 에서는 **지목된 봇만** 선다. 사람 쪽도 똑같이 지목된 한 명만
      //   묶이므로(world-scene.tsx 의 mayMove) 나머지는 양쪽 다 걷는다.
      //   여기를 `still` 하나로 되돌려 전 봇을 세우면, 걸어다니는 사람들 사이에서
      //   **봇만 20초간 얼어붙어** 이 단계가 통째로 봇 판별기가 된다.
      const still = !mayMove(phase, bot.id === nomineeId);
      const moved = still ? haltBot(bot, now, dt) : stepBot(bot, now, dt, gather);
      if (moved) {
        // ★ this.broadcast 가 아니라 emitAsBot 이다 (I1 — BOT_EMIT_JITTER_MS).
        //   여기서 바로 보내면 봇 전원의 좌표가 **같은 이벤트 루프 턴**에 나가
        //   같은 배치로 도착한다. 도착 시각만 찍어도 봇 집합이 갈린다.
        this.emitAsBot(bot.id, {
          t: 'player_moved',
          id: bot.id,
          x: bot.x,
          z: bot.z,
          y: bot.y,
          heading: bot.heading,
          anim: bot.anim,
        });
      }

      // ③ 서 있는 시간이 끝났으면 그때 말한다. 이 틱의 stepBot은 이미 idle로 굴렸다.
      //    뒷줄이 있으면 takeSpeech가 이미 이어 예약했다 — 그래서 tail을 넘기지 않는다.
      const said = takeSpeech(bot, now);
      if (said !== null) this.botSpoke(bot, said, now);
    }

    if (now - this.lastPersistAt > BOT_PERSIST_MS) {
      this.lastPersistAt = now;
      void this.persistBots();
    }
  }

  /**
   * 사람이 한마디 했다 — 봇 하나가 대꾸할 수도 있다 (안 할 수도 있다).
   * 고르는 규칙과 그 이유는 bots.ts의 pickResponder에 있다.
   */
  private reactToHuman(now: number, trigger: string): void {
    const bots = this.bots;
    if (!bots || bots.length === 0) return;
    // 말이 잠긴 단계(지금은 reveal 하나)에서는 대꾸하지 않는다 — 거기선 사람도
    // 채팅을 못 친다. 목록은 CHAT_LOCKED_PHASES 하나뿐이다 (mayChat).
    if (!this.botsMayChat()) return;

    // 답할 거리가 없는 말("ㅋㅋ", "ㅇㅇ")에는 자리를 잡지 않는다 (bots.ts의 hasContent).
    // 여기서 안 막으면 풀 문구든 LLM 답이든 동문서답으로 나간다 — 잡은 자리는 반드시 채워지므로
    // 걸러야 할 곳은 말을 만드는 쪽이 아니라 **자리를 잡는 이 지점**이다.
    if (!hasContent(trigger)) return;

    const bot = pickResponder(bots, now, this.meta?.companionMode === true);
    if (!bot) return;

    // 라운지는 읽는 시간도 치는 시간도 없다 — LLM 이 오는 대로 바로 말한다
    // (scheduleInstantSpeech 상자). 판이 도는 방은 읽는 시간을 준다 — 0이면
    // 사람이 말한 그 순간 멈추는 아바타가 생긴다 (I1).
    if (DISGUISE_OFF || this.isLounge()) scheduleInstantSpeech(bot, now);
    else scheduleSpeech(bot, pickLine(this.botLines(), this.recentTexts()), now, readDelayMs());

    // 자리는 잡혔다. LLM이 speakAt 전에 오면 그 자리가 채워지고, 못 오면 잠깐 서 있다
    // 그냥 지나간다 — 어느 쪽이든 서 있는 시간은 같다 (bots.ts의 speechHeld).
    void this.upgradeSpeech(bot, bot.speechSeq, trigger);
  }

  /**
   * 사람이 들어오거나 나갔다 — 봇 하나가 아는 척할 수도 있다.
   *
   * ┌─ 왜 라운지에서만 하는가 ───────────────────────────────────────────────────┐
   * │ 게임 방에서 누가 새로고침한 걸 두고 "어 왔네" 하면, 그건 사람이 아니라       │
   * │ **접속 로그를 보는 자리**다. 게임 화면에는 입·퇴장이 보이지도 않는다.        │
   * │ 반대로 라운지는 문이 열리면 사람도 웬만하면 한마디 한다 — 아무 반응이 없는   │
   * │ 쪽이 더 이상하다.                                                          │
   * └──────────────────────────────────────────────────────────────────────────┘
   *
   * 사건은 발화가 아니라서 trigger가 아니라 event로 넘어간다 (generate.ts의
   * worldEvent 분기). [방금 너한테 온 말]로 주면 모델이 그 문장에 대꾸한다 —
   * "익명3 들어옴" → "그러게 들어왔네".
   */
  private reactToEvent(now: number, event: string, chance: number): void {
    if (this.meta?.companionMode !== true) return;
    const bots = this.bots;
    if (!bots || bots.length === 0) return;

    const bot = pickResponder(bots, now, true, chance);
    if (!bot) return;

    // 라운지는 즉시(자리를 잡을 뿐 서지 않으니 "문 열리는 순간 멈춤"도 없다),
    // 판 도중(퇴장 사건)은 읽는 시간을 준다 — 그 순간 멈추면 그게 표식이다 (I1).
    if (DISGUISE_OFF || this.isLounge()) scheduleInstantSpeech(bot, now);
    else scheduleSpeech(bot, null, now, readDelayMs());
    void this.upgradeSpeech(bot, bot.speechSeq, null, event);
  }

  /**
   * 봇이 실제로 한마디 했다 — 내보내고 · 기록하고 · 다른 봇이 받을지 본다.
   *
   * 두 경로가 여기로 모인다: 제 시각에 꺼낸 말(tick ③)과 자리를 놓치고 늦게 온
   * 답(upgradeSpeech). 방에 보이는 결과는 같아야 한다 — 한쪽에만 연쇄가 붙으면
   * "늦게 말한 자리만 대화가 이어지는" 편차가 생기고, 그건 자리 단위 신호다 (I1).
   */
  private botSpoke(bot: BotState, text: string, ts: number, tail: string | null = null): void {
    // ★ 발화도 좌표와 **같은 위상**으로 흘린다 (I1 — BOT_EMIT_JITTER_MS).
    //   틱에서 꺼낸 말은 100ms 격자 위에 정확히 얹혀 나가는데, 사람 채팅은 소켓
    //   수신 즉시라 아무 격자에도 안 맞는다. "봇 이동 배치와 같은 프레임에 온 채팅"
    //   은 id 가 붙어 있으므로 그 한 줄로 그 자리가 봇 확정이다.
    this.emitAsBot(bot.id, { t: 'chat', id: bot.id, nickname: bot.nickname, text, ts });
    this.rememberChat(bot.id, bot.nickname, text);
    // 뒷줄은 앞 줄 바로 뒤에 잇는다 — 사람은 한 생각을 두 번에 나눠 친다.
    // (tick 경로에서는 takeSpeech가 이미 걸어 뒀으므로 여기 tail은 null이다.)
    //
    // ★ 측정 중에는 치는 시간 없이 곧바로 잇는다 (DISGUISE_OFF). 여기 남은 타이핑
    //   시간이 위장 지연 중 제일 길어서(1.3~4초), 안 끄면 "두 번째 줄만 한참 뒤에
    //   뜨는" 모양이 그대로 남는다. maxTypeMs 0 이라 speakAt 이 곧 지금이고, 다음
    //   틱이 그대로 꺼내 간다.
    if (tail) {
      if (DISGUISE_OFF) scheduleArrivedSpeech(bot, tail, null, ts, 0);
      else scheduleSpeech(bot, tail, ts);
    }
    this.maybeChain(bot, text, ts);
  }

  /**
   * 봇 말을 **다른 봇**이 받는다. 안 받을 때가 더 많다 (BOT_CHAIN_CHANCE).
   *
   * ┌─ 왜 열었나 (I1) ──────────────────────────────────────────────────────────┐
   * │ 봇은 사람 말에만 반응했다. 그러면 봇이 여럿인 방에서 **사람끼리는 말을 주고  │
   * │ 받는데 어떤 자리들은 서로에게 한마디도 안 하는** 그림이 된다. 그 자리들이    │
   * │ 한 덩어리로 묶여 보인다.                                                   │
   * └──────────────────────────────────────────────────────────────────────────┘
   *
   * ┌─ 끝없이 도는 건 무엇으로 막나 ─────────────────────────────────────────────┐
   * │ 확률이 아니라 **연쇄 상한**이다 (BOT_CHAIN_MAX). 확률로만 막으면 아무리 낮게 │
   * │ 잡아도 언젠가는 길게 이어지고, 그 동안 사람이 낄 자리가 없다. 사람이 한마디  │
   * │ 하면 0으로 돌아간다 (webSocketMessage의 'chat').                            │
   * │                                                                            │
   * │ ★ 말한 당사자를 뺀다. 안 빼면 자기 말에 자기가 답한다 — 자발 발화에서 이미   │
   * │   한 번 겪은 증상이다 (humanSpokeLast).                                     │
   * │ ★ 뒷줄이 남았으면(speechHeld) 건너뛴다. 앞 줄만 보고 대꾸를 만들면 아직      │
   * │   나오지도 않은 말에 답이 걸린다.                                          │
   * └──────────────────────────────────────────────────────────────────────────┘
   *
   * 라운지의 월드 AI 는 지연 합류로 하나씩 늘어난다(lib/server/world-ai.ts의
   * joinDelayMs — 빈 좌석을 정원까지 채운다). 둘 미만인 동안은 여기서 바로 돌아선다.
   */
  private maybeChain(speaker: BotState, text: string, now: number): void {
    const bots = this.bots;
    if (!bots || bots.length < 2) return;
    if (!this.botsMayChat()) return; // 위와 같다 — 사람이 못 치는 구간에서는 봇도 안 친다
    if (speaker.speechHeld) return;
    if (this.botChainHops >= BOT_CHAIN_MAX) return;
    // 사람 발화와 같은 규칙이다 — 봇이 "ㅋㅋ"만 했으면 거기 붙일 대꾸도 없다.
    if (!hasContent(text)) return;

    const bot = pickResponder(
      bots.filter((b) => b !== speaker),
      now,
      this.meta?.companionMode === true,
      BOT_CHAIN_CHANCE,
    );
    if (!bot) return;

    this.botChainHops += 1;
    // 봇→봇 연쇄도 같은 규칙이다 — 라운지는 즉시, 판 도중은 위장 지연.
    if (DISGUISE_OFF || this.isLounge()) scheduleInstantSpeech(bot, now);
    else scheduleSpeech(bot, pickLine(this.botLines(), this.recentTexts()), now, readDelayMs());
    void this.upgradeSpeech(bot, bot.speechSeq, text);
  }

  /**
   * 잡아 둔 발화 자리를 LLM 반응으로 채운다 (SPEC §12.3의 폴백 패턴).
   *
   * ★ speakAt은 건드리지 않는다 — 발화 타이밍이 LLM 성공/실패와 무관해야 한다 (I1).
   *   게임 방에서 실패·지연이면 아무 일도 일어나지 않는다 — 봇은 제 시각까지 서 있다
   *   말없이 간다.
   *
   * 게임 방의 예산은 **speakAt까지 남은 시간**이다. 그 뒤에 온 답은 이미 말한 뒤라
   * 버려지므로 더 기다릴 이유가 없다. 남은 시간이 얼마 없으면 아예 부르지 않는다.
   *
   * ★ 월드 AI 방(companionMode)은 다르다 — 자리를 놓친 답을 버리면 그냥 침묵이다
   *   (풀 문구가 없으니까). 사용자 결정: **어색한 풀 문구 < 침묵 < 늦은 진짜 답.**
   *   그래서 예산이 모자라도 부르고, 자리를 놓친 답은 그 시점에 바로 말한다.
   *   숨길 게임이 없는 방이라 지각이 자리 신호가 될 걱정도 없다.
   */
  private async upgradeSpeech(
    bot: BotState,
    seq: number,
    /** 반응이면 그 발화 — 사람 것일 수도, 다른 봇 것일 수도 있다(maybeChain). 혼잣말이면 null. */
    trigger: string | null,
    /** 발화가 아니라 **사건**에 대한 반응일 때 ("익명3 들어옴"). trigger와 같이 오지 않는다. */
    event: string | null = null,
  ): Promise<void> {
    const roomId = this.meta?.roomId;
    if (!roomId) return;
    // ★ DISGUISE_OFF 동안은 게임 방도 companion 취급 — 예산 문턱 없이 LLM 을 부르고,
    //   자리를 놓친 답도 도착하는 대로 말한다 (아래 지각 경로).
    const companion = DISGUISE_OFF || this.meta?.companionMode === true;

    const budget = bot.speakAt - Date.now();
    if (!companion && budget < MIN_AGENT_BUDGET_MS) return;

    const lines = await fetchAgentLines(
      this.env,
      roomId,
      [bot.id],
      this.chatContext(),
      trigger,
      event,
      { [bot.id]: bot.facts },
      companion ? Math.max(budget, COMPANION_AGENT_TIMEOUT_MS) : budget,
    );
    const line = lines.find((l) => l.player_id === bot.id);
    if (!line?.text) return;

    /*
     * ★ 지어낸 설정은 **그 말이 실제로 나갈 때만** 기억한다 (lib/agent/facts.ts).
     *   아래 두 갈래는 둘 다 발화가 나가는 길이다. 그 어느 쪽도 못 타고 함수가
     *   끝나면(자리를 놓친 게임 방) 이 사실은 버려진다 — 봇이 한 적 없는 말을
     *   했다고 기억하면 다음 턴에 앞뒤가 안 맞는다.
     *
     *   돌려받은 건 합쳐진 전체 명단이라 그대로 갈아 끼운다. undefined 는
     *   "구 오리진이라 안 왔다"는 뜻이므로 기존 명단을 지우지 않는다.
     */
    const remember = (): void => {
      if (line.facts) bot.facts = line.facts;
    };

    // tail 은 LLM 이 두 줄을 냈을 때의 뒷줄이다 — 앞 줄이 실제로 나간 뒤에
    // takeSpeech 가 이어 예약한다.
    if (replaceSpeech(bot, seq, line.text, Date.now(), line.tail ?? null)) {
      remember();
      return;
    }

    // 자리를 놓친 답. 게임 방이면 버린다 (위 머리말). 월드 AI 방은 **seq가 그대로일
    // 때만** 말한다 — 다음 예약이 이미 걸렸으면(seq 불일치) 그 예약의 LLM이
    // 이 맥락을 대신 안다.
    //
    // ★ 도착 즉시 broadcast 하지 않는다 — 걸으면서 말하는 아바타가 된다. 잠깐
    //   멈춰 서서 치고 내보낸다 (scheduleArrivedSpeech 상자, 사용자 결정 2026-08-05).
    //   라운지는 짧게(LOUNGE_TYPE_MAX_MS) 세우고, 판이 도는 방의 지각 답은 상한
    //   없이 사람 속도로 친다. 뒷줄(tail)은 takeSpeech 가 앞 줄을 내보내면서 이어
    //   예약한다 — 늦은 판에서만 한 줄로 끝나면 안 된다.
    if (companion && bot.speechSeq === seq) {
      remember();
      /*
       * ★ 틱(BOT_TICK_MS, 100ms)은 **안 걷어낸다.** 측정 중에도 그렇다.
       *   여기서 바로 broadcast 하도록 고쳐 봤는데, 그러면 자리를 잡지 않으니 봇이
       *   **걸으면서 말한다** — 2026-08-05 에 사용자가 보고 물린 그 모양 그대로다
       *   (scheduleArrivedSpeech 의 상자). 워커 검사도 그 자리에서 걸린다
       *   ("봇이 'walk' 상태로 말했다", npm run world:smoke).
       *   버는 건 최대 100ms 인데 잃는 건 그거라 남겨 둔다.
       */
      scheduleArrivedSpeech(
        bot,
        line.text,
        line.tail ?? null,
        Date.now(),
        DISGUISE_OFF ? 0 : this.isLounge() ? LOUNGE_TYPE_MAX_MS : Infinity,
      );
    }
  }

  /**
   * 최근 대화를 맥락 모양으로 바꾼다. **사람 발화와 봇 발화를 구분해서 보낸다** —
   * 말투 관측(observeStyle)이 봇 풀 문구를 배우면 봇끼리 서로 닮아간다.
   * is_bot은 여기서 밖으로 나가지만 받는 쪽이 서버(Next)다 — world-room과 같은 예외다.
   */
  private chatContext(): ChatLine[] {
    const botIds = new Set((this.meta?.seats ?? []).filter((s) => s.is_bot).map((s) => s.id));
    return this.chatLog.map((c) => ({
      nickname: c.nickname,
      text: c.text,
      human: !botIds.has(c.id),
    }));
  }

  /**
   * 봇이 쓸 문구 풀. **비어 있는 게 정상이다.**
   *
   * 게임이 도는 방만 DB의 bot_line_pool을 받아 온다 (/api/internal/world-room).
   * 로비 방(월드 AI)에는 풀이 없고 — 하드코딩 문구를 없앴다 — 할 말은 전부 LLM에서
   * 온다. 여기 코드로 된 대비책을 다시 두지 않는다 (bots.ts 끝의 주석).
   */
  private botLines(): readonly string[] {
    return this.meta?.botLines ?? [];
  }

  /** 채팅 한 줄 기록. 앞에서 버려 최근 CHAT_HISTORY_MAX줄만 남긴다. */
  private rememberChat(id: string, nickname: string, text: string): void {
    this.chatLog.push({ id, nickname, text });
    if (this.chatLog.length > CHAT_HISTORY_MAX) {
      this.chatLog.splice(0, this.chatLog.length - CHAT_HISTORY_MAX);
    }
  }

  private recentTexts(): string[] {
    return this.chatLog.map((c) => c.text);
  }

  /**
   * 마지막으로 말한 게 사람인가. 봇이 스스로 말을 꺼내도 되는지의 판정이다
   * (shouldChat 의 mayInitiate — 혼자 떠들고 혼자 대답하는 걸 막는다).
   *
   * 기록이 비었으면 true — 아무도 말한 적 없는 방에서 첫 한마디는 걸어도 된다.
   * **어느 봇이든** 봇이 마지막이면 false다. 자기 자신만 보면 봇 둘이 서로의
   * 발화를 핑퐁으로 받아 영원히 주고받는다.
   *
   * ★ maybeChain(봇→봇 대꾸)과 헷갈리지 말 것. 저쪽은 **상대의 말을 받는** 길이라
   *   상한(BOT_CHAIN_MAX)을 세고 사람 발화에서 초기화된다. 여기는 **혼잣말**을
   *   여는 길이고, 그건 여전히 사람이 말한 뒤에만 열린다 — 자기가 던진 질문에
   *   자기가 답하는 그림을 막는 게 이 함수의 전부다.
   */
  private humanSpokeLast(): boolean {
    const last = this.chatLog[this.chatLog.length - 1];
    if (!last) return true;
    return !(this.meta?.seats ?? []).some((s) => s.is_bot && s.id === last.id);
  }

  private async ensureBots(meta: CachedMeta): Promise<BotState[]> {
    if (this.bots) return this.bots;

    const poses = ((await this.ctx.storage.get<BotPose[]>(KEY_BOTS)) ?? []).reduce(
      (acc, p) => acc.set(p.id, p),
      new Map<string, BotPose>(),
    );
    const now = Date.now();

    this.bots = meta.seats
      .filter((s) => s.is_bot)
      .map((s) =>
        createBot(
          { id: s.id, seat: s.seat, nickname: s.nickname, maskId: s.mask_id },
          WORLD_SEAT_SLOTS,
          now,
          poses.get(s.id),
        ),
      );
    return this.bots;
  }

  private async persistBots(): Promise<void> {
    if (!this.bots || this.bots.length === 0) return;
    await this.ctx.storage.put(KEY_BOTS, this.bots.map(toPose));
  }

  /* ────────────────────────── 라운드테이블 (한 판) ────────────────────────── */

  private roundActive(): boolean {
    return this.round !== null && !this.round.done;
  }

  /**
   * 라운지 상태인가 — 월드 AI 방이고 **판이 돌지 않는다.**
   *
   * 발화의 위장 지연(읽기·타이핑)을 걷어내는 조건이다 (bots.ts 의
   * scheduleInstantSpeech, 사용자 결정 2026-08-05). companionMode 만 보면 안 된다 —
   * 월드 AI 방에서도 판은 돌고(maybeStartRound 는 meta.seats 그대로 연다), 라운지의
   * 아바타가 그대로 판의 좌석이 되므로 판 도중에는 위장이 다시 켜져야 한다 (I1).
   */
  private isLounge(): boolean {
    return this.meta?.companionMode === true && !this.roundActive();
  }

  private phase(): RoundPhase {
    return this.round?.phase ?? 'idle';
  }

  /** 지금이 speak 페이즈면 그 주제, 아니면 null. 봇 발화의 trigger 로 쓴다. */
  private speakTopic(): string | null {
    const s = this.round;
    return s && s.phase === 'speak' ? s.topic : null;
  }


  /**
   * 봇이 **스스로** 말을 꺼내도 되는 단계인가.
   * 판이 없는 방(라운지)은 'idle'이라 늘 참이다 — 저긴 숨길 게 없다.
   * 최후변론은 여기를 거치지 않는다 (scheduleBotDefense 가 따로 예약한다).
   *
   * ★ 사람 채팅도 **같은 함수**로 막힌다 (webSocketMessage 의 'chat').
   *   한쪽만 막으면 그 구간의 발화가 통째로 한쪽 진영 것이 된다 (I1).
   * ★ isNominee 를 false 로 넘긴다 — 최후변론은 이 길이 아니라 scheduleBotDefense 다.
   *   여기를 열면 지목된 봇이 변론과 혼잣말을 둘 다 하게 된다.
   */
  private botsMayChat(): boolean {
    return mayChat(this.phase(), false);
  }

  /** 이 판의 좌석에 실제로 앉아 있는 봇들. 판 도중에 생긴 봇 좌석은 끼지 않는다. */
  private roundBots(): BotState[] {
    const s = this.round;
    if (!s || !this.bots) return [];
    return this.bots.filter((b) => s.seatIds.includes(b.id));
  }

  /**
   * 지금 **소켓이 살아 있는** 사람 좌석. vote 조기 종료 임계다 (haveAllVoted).
   * 나간 사람의 자리는 남지만 그 사람은 영영 표를 안 내므로, 넣으면 조건이 참이
   * 되지 않아 매번 30초를 꽉 채운다 (SPEC §18.6).
   */
  private connectedHumanSeats(): string[] {
    const s = this.round;
    if (!s) return [];
    const humans = new Set(s.humanIds);
    return this.humanSnapshots()
      .map((p) => p.id)
      .filter((id) => humans.has(id));
  }

  /* ─────────────────────────── 집결 게이트 ─────────────────────────── */

  private async ensureGate(): Promise<void> {
    if (this.gate || this.gateLoaded) return;
    this.gateLoaded = true;
    const stored = await this.ctx.storage.get<GateState>(KEY_GATE);
    if (stored) this.gate = { arrived: stored.arrived ?? [], openedAt: stored.openedAt ?? null };
  }

  /**
   * 이 방에 게이트를 거는가 — **방장이 대기방에서 시작을 누른 방만이다.**
   *
   * /world 로 직접 들어와 서 있는 라운지에는 걸지 않는다. 거기엔 "이 판을 함께
   * 시작할 명단"이라는 게 없어서, 기다릴 대상을 정하면 브라우저를 닫고 간 좌석
   * 때문에 매번 상한(GATHER_DEADLINE_MS)까지 멈춘다.
   * ★ companionMode 로 가르면 안 된다 — 시작한 방도 true 다 (room-meta 의 startedAt).
   */
  private gateRequired(): boolean {
    return this.meta?.startedAt != null;
  }

  /** 판을 열어도 되는가. 게이트가 없는 방은 언제나 참이다. */
  private gateOpen(): boolean {
    if (!this.gateRequired()) return true;
    return this.gate?.openedAt != null;
  }

  /** 사람 좌석 id. 게이트의 분모다 — **좌석 자체는 밖으로 나가지 않는다** (I1). */
  private humanSeatIds(): string[] {
    return (this.meta?.seats ?? []).filter((s) => !s.is_bot).map((s) => s.id);
  }

  private gateSnapshot(): Extract<S2CMessage, { t: 'gate' }> | null {
    if (!this.gateRequired()) return null;
    const { present, total } = gateCounts(this.gate, this.humanSeatIds());
    return { t: 'gate', present, total, startsAt: gateStartsAt(this.gate, WORLD_INTRO_MS) };
  }

  /**
   * 도착 명단을 갱신하고, 다 모였으면(또는 상한이 지났으면) 게이트를 연다.
   * 판정은 전부 gate.ts 의 순수 함수가 한다 — 여기는 값을 물어다 주고 굽기만 한다.
   *
   * 부르는 곳은 둘이다 — 입장(도착)과 알람(상한).
   * **나갈 때는 부르지 않는다.** 한 번 열린 게이트는 닫지 않고(stepGate 의 상자),
   * 도착 명단도 줄지 않으므로 부를 이유가 없다.
   *
   * @returns 방에 실제로 알렸는가. 입장 경로가 이걸 보고 **중복 전송을 건너뛴다.**
   */
  private async maybeOpenGate(now: number): Promise<boolean> {
    if (!this.gateRequired()) return false;
    await this.ensureGate();
    if (this.gate?.openedAt != null) return false; // 열린 게이트는 다시 닫지 않는다

    const before = this.gate;
    this.gate = stepGate(
      before,
      this.humanSeatIds(),
      this.humanSnapshots().map((p) => p.id),
      this.meta?.startedAt ?? now,
      GATHER_DEADLINE_MS,
      now,
    );

    if (this.gate.openedAt !== null || this.gate.arrived.length !== (before?.arrived.length ?? 0)) {
      await this.ctx.storage.put(KEY_GATE, this.gate);
      // 알람이 잡혀 있어야 상한이 실제로 걸린다 — 대기 중에는 마감에 맞춰 당긴다.
      await this.ctx.storage.setAlarm(this.nextAlarmAt(now));
    }
    // 이 호출에서 **막 열렸다** — 전원 집결, 카운트다운 시작. 역할 카드가 뜨는 순간이다.
    if (before?.openedAt == null && this.gate.openedAt !== null) {
      await this.dealEarlyRoles();
    }
    return this.broadcastGate();
  }

  /**
   * 게이트가 열리는 순간 역할을 미리 뽑아 **각자에게만** 보낸다 (카드 선공개).
   *
   * ★ 반드시 소켓 단위 send 다 — broadcast 에 실으면 연기자 명단이 방 전체에 샌다
   *   (sendRoles 와 같은 규칙, protocol.ts 의 t:'role' 상자).
   * ★ 명단은 storage 에 굽는다. 카운트다운·인트로 사이에 DO 가 쉬었다 깨거나
   *   누가 새로고침해도 **같은 명단**을 다시 읽어야 한다.
   * ★ 마감(GATHER_DEADLINE_MS)으로 열려 아직 안 온 사람이 있으면, 그 사람 몫은
   *   접속 인사(welcome 경로)가 이 명단을 읽어 보낸다.
   */
  private async dealEarlyRoles(): Promise<void> {
    const meta = this.meta;
    if (!meta) return;
    await this.ensurePendingActors();
    if (!this.pendingActors) {
      const humanIds = meta.seats.filter((s) => !s.is_bot).map((s) => s.id);
      this.pendingActors = pickActors(humanIds, Math.random);
      await this.ctx.storage.put(KEY_PENDING_ACTORS, this.pendingActors);
    }
    for (const ws of this.ctx.getWebSockets()) {
      const snap = ws.deserializeAttachment() as PlayerSnapshot | null;
      if (!snap) continue;
      const role = this.earlyRole(snap.id);
      if (role) this.send(ws, { t: 'role', role });
    }
  }

  private async ensurePendingActors(): Promise<void> {
    if (this.pendingActorsLoaded) return;
    this.pendingActorsLoaded = true;
    this.pendingActors = (await this.ctx.storage.get<string[]>(KEY_PENDING_ACTORS)) ?? null;
  }

  /** 미리 뽑은 명단에서의 이 좌석 역할. 명단이 없으면(라운지·판 열림 전) null */
  private earlyRole(id: string): 'citizen' | 'actor' | null {
    if (!this.pendingActors) return null;
    return this.pendingActors.includes(id) ? 'actor' : 'citizen';
  }

  /**
   * 게이트 현황을 방에 알린다. **숫자 둘 + 시각 하나뿐이다** (protocol.ts 의 t:'gate').
   * 바뀐 게 없으면 보내지 않는다 — 같은 값을 계속 흘리면 그 주기가 다시 신호가 된다.
   */
  private broadcastGate(): boolean {
    const msg = this.gateSnapshot();
    if (!msg) return false;
    if (msg.startsAt === null && msg.present === this.gateSent) return false;
    this.gateSent = msg.present;
    this.broadcast(msg);
    return true;
  }

  /**
   * 게이트는 열렸는데 **아무도 `intro_done` 을 못 보낸** 방을 서버가 연다.
   * 정상 경로는 여전히 intro_done 이다 (GATHER_ROUND_BACKSTOP_MS 의 상자).
   */
  private async maybeBackstopRound(now: number): Promise<void> {
    if (!this.gateRequired()) return;
    await this.ensureGate();
    const openedAt = this.gate?.openedAt;
    if (openedAt == null) return;
    if (now < openedAt + WORLD_INTRO_MS + GATHER_ROUND_BACKSTOP_MS) return;
    await this.ensureRound();
    if (this.round) return; // 이미 열렸거나 끝난 판이다 — rematch 말고는 되살리지 않는다
    await this.maybeStartRound(now);
  }

  private async ensureRound(): Promise<void> {
    if (this.round || this.roundLoaded) return;
    this.roundLoaded = true;
    const stored = await this.ctx.storage.get<StoredRound>(KEY_ROUND);
    if (!stored?.round) return;
    // 연기자(actorIds)·전적 키(matchId)가 생기기 전에 구운 판 방어 —
    // 없으면 연기자 0명 · 전적 없는 판으로 읽는다.
    this.round = {
      ...stored.round,
      actorIds: stored.round.actorIds ?? [],
      matchId: stored.round.matchId ?? null,
      // 재투표 카운터가 생기기 전에 구운 판 방어 — 없으면 0(아직 재투표 안 함)으로 읽는다.
      revoteCount: stored.round.revoteCount ?? 0,
    };
    this.botVotes = stored.botVotes ?? {};
    this.botVerdicts = stored.botVerdicts ?? {};
  }

  /** 판을 굽는다. **단계가 바뀐 틱에만** 부른다 — 100ms마다 쓰면 그게 곧 과금이다. */
  private async saveRound(): Promise<void> {
    const s = this.round;
    if (!s) return;
    await this.ctx.storage.put(KEY_ROUND, {
      round: s,
      botVotes: this.botVotes,
      botVerdicts: this.botVerdicts,
    } satisfies StoredRound);
  }

  /**
   * 판을 연다. `intro_done` 첫 신호에만 실제로 열리고, 두 번째부터는 그냥 돌아선다.
   * **끝난 판도 여기서는 다시 시작하지 않는다** (this.round 가 남아 있으므로 첫 줄에서
   * 걸린다) — 되살리는 길은 `rematch` 하나뿐이고, 그쪽이 round 를 비운 뒤 다시 부른다.
   */
  private async maybeStartRound(now: number): Promise<void> {
    if (this.round) return;
    /*
     * ★ 집결 게이트가 열리기 전에는 열지 않는다 (GateState 의 상자).
     *   `intro_done` 은 클라이언트의 video 이벤트라, 예전에는 **제일 먼저 뜬 사람
     *   하나**가 방 전체의 판을 열었다 — 늦게 뜬 사람은 자기 인트로 위에 주제가
     *   겹친 채로 판에 들어왔다 (warehouse.tsx 의 "판이 열리면 상영을 끊는다" 상자).
     */
    await this.ensureGate();
    if (!this.gateOpen()) return;
    const meta = this.meta;
    // ★ 메타가 없으면 열지 않는다. 좌석 명단 없이는 사람과 봇을 가를 수 없고,
    //   그러면 "승패를 정하는 표는 사람 표만 센다"(SPEC §18.3)가 통째로 무너진다.
    //   봇 표까지 세면 판정이 주사위가 된다.
    if (!meta) return;

    const seatIds = meta.seats.map((s) => s.id);
    const humanIds = meta.seats.filter((s) => !s.is_bot).map((s) => s.id);
    // 전적 키는 판이 열리는 이 자리에서 발급한다 (RoundState.matchId 의 상자).
    // 연기자는 게이트가 열릴 때 이미 뽑아 카드로 나눠줬으면 그 명단을 그대로 쓴다.
    await this.ensurePendingActors();
    const round = startRound(
      seatIds,
      humanIds,
      now,
      Math.random,
      crypto.randomUUID(),
      this.pendingActors,
    );
    if (!round) return;
    // 명단은 판으로 넘어갔다 — 「한 판 더」는 새로 뽑아야 하므로 여기서 비운다.
    this.pendingActors = null;
    await this.ctx.storage.delete(KEY_PENDING_ACTORS);

    this.round = round;
    this.botVotes = {};
    this.botVerdicts = {};
    this.progressSent = -1;
    this.progressAt = 0;
    // 판이 열렸다 — 걸어가던 창고 구석 목적지를 버리고 테이블 쪽으로 다시 잡는다.
    // 안 하면 첫 주제가 뜨는 동안 봇만 화면을 등지고 걸어 나간다 (gatherBot, I1).
    for (const bot of this.roundBots()) gatherBot(bot, now);
    this.broadcastRound();
    this.sendRoles();
    await this.saveRound();
    this.startSim();
  }

  /**
   * 각자에게 **자기 역할만** 보낸다 (§18.2 — 연기자끼리도 서로 모른다).
   *
   * ★ 반드시 소켓 단위 send 다. broadcast 에 실으면 그 순간 연기자 명단이 방 전체에
   *   새고, 그게 곧 게임의 끝이다 (protocol.ts 의 t:'role' 상자).
   * ★ round 브로드캐스트 **뒤에** 부른다 — 클라이언트가 topic 에서 지난 판 역할을
   *   지운 다음 새 역할을 받는 순서가 돼야 한다 (roundtable-store 의 applyRound).
   */
  private sendRoles(): void {
    const s = this.round;
    if (!s || s.done) return;
    for (const ws of this.ctx.getWebSockets()) {
      const snap = ws.deserializeAttachment() as PlayerSnapshot | null;
      if (!snap) continue;
      const role = humanRole(s, snap.id);
      if (role) this.send(ws, { t: 'role', role });
    }
  }

  /**
   * 판을 한 틱 굴린다. tick() 맨 앞에서 부른다.
   *
   * 순서가 곧 규칙이다:
   *  ① 너무 뒤처진 판은 따라잡지 않고 끝낸다 (ROUND_ABANDON_MS 의 상자)
   *  ② 예약된 봇 표를 반영한다 — **마감을 당기기 전에** 넣어야 castVote 가 받아 준다
   *  ③ 접속 중인 사람이 전부 냈으면 vote 마감을 당긴다
   *  ④ 한 단계 굴린다. 부수효과(브로드캐스트·예약·저장)는 **넘어간 그 틱에만**
   */
  private driveRound(now: number): void {
    const s = this.round;
    if (!s || s.done) return;

    if (now - s.phaseEndsAt > ROUND_ABANDON_MS) {
      abortRound(s, now);
      this.broadcastRound();
      void this.saveRound();
      return;
    }

    this.driveBotPlans(now);
    this.maybeCloseVote(now);

    if (stepRound(s, now)) {
      this.onPhaseEnter(now);
      void this.saveRound();
      return;
    }
    this.pumpVoteProgress(now);
  }

  /**
   * 단계가 막 바뀌었다. 이 틱에만 불린다.
   *
   * ★ 브로드캐스트 순서: round → eliminated → reveal.
   *   클라이언트가 reveal 단계로 들어간 뒤에 아바타가 쓰러지고, 그다음 결과가 뜬다.
   */
  private onPhaseEnter(now: number): void {
    const s = this.round;
    if (!s) return;

    this.progressSent = -1;
    this.progressAt = 0;

    // ★ 말이 잠기는 단계로 들어왔으면 **예약된 발화를 전부 끊는다** (cancelSpeech).
    //   경계를 넘어온 말은 사람이 입력을 못 하는 구간에서 터지고, 그러면
    //   "단계가 바뀐 뒤에도 말하는 자리 = 봇"이 된다 (I1).
    //   ★ vote 만이 아니라 CHAT_LOCKED_PHASES **전부**다. 단계 목록은
    //     lib/mp/constants.ts 한 곳에만 적는다.
    if (isChatLocked(s.phase)) this.hushBots();

    switch (s.phase) {
      case 'speak':
        this.primeBotsForSpeak(now);
        break;
      case 'vote':
        this.planBotVotes(now);
        break;
      case 'defense':
        this.scheduleBotDefense(now);
        break;
      case 'verdict':
        this.planBotVerdicts(now);
        break;
      default:
        break;
    }

    this.broadcastRound();

    if (s.phase === 'reveal') {
      const dead = eliminatedId(s);
      if (dead) this.broadcast({ t: 'eliminated', id: dead });
      // ★★ 정체가 밖으로 나가는 **유일한 지점**이다 (I1의 예외).
      //    revealSnapshot 은 phase 가 reveal/ended 이고 판정이 끝났을 때만 값을 준다.
      //    이 반환값을 다른 메시지에 재사용하지 마라.
      const reveal = revealSnapshot(s);
      if (reveal) this.broadcast({ t: 'reveal', ...reveal });
      // 전적. 기다리지 않는다 — reveal 은 게임의 마지막 장면이고 기록은 곁다리다.
      void this.reportMatch(s);
    }
  }

  /**
   * 끝난 판을 전적으로 보낸다 (SPEC §15-2-결정). reveal 진입 틱에 **한 번** 불린다 —
   * onPhaseEnter 는 전환 틱에만 돌고, DO 가 죽었다 살아나도 phase 는 이미 reveal 이라
   * 다시 안 들어온다. 그래도 겹치면 DB 기본키 (matchId, user_id) 가 무시한다.
   */
  private async reportMatch(s: RoundState): Promise<void> {
    // matchId 없는 판 = 이 필드가 생기기 전에 구운 판 (배포 경계). 조용히 넘어간다.
    if (!s.matchId || !s.winner || !this.meta) return;
    // 사람 2명 미만 판은 안 적는다 — 혼자 봇만 지목하며 전적을 만드는 걸 막는
    // 기존 규칙 그대로다 (lib/server/match.ts 의 MIN_HUMANS_FOR_RECORD, 그쪽이
    // 한 번 더 거르고 DB check 가 세 번째 겹이다). 여기서 거르는 건 왕복 절약이다.
    if (s.humanIds.length < 2) return;

    await postMatchReport(this.env, {
      matchId: s.matchId,
      roomId: this.meta.roomId,
      winner: s.winner,
      // 판 시작 시점 명단(동결)의 사람 좌석만. 봇은 계정이 없어 적을 곳이 없다.
      seats: s.humanIds.map((id) => ({
        id,
        role: s.actorIds.includes(id) ? ('actor' as const) : ('citizen' as const),
      })),
    });
  }

  private broadcastRound(): void {
    const s = this.round;
    if (!s) return;
    this.broadcast({ t: 'round', ...roundSnapshot(s) });
  }

  /**
   * 투표 진행 현황. **숫자 둘뿐이고, 고정 배차로 나간다.**
   *
   * ┌─ ★ 표가 들어올 때마다 즉시 쏘면 안 된다 (I1) ──────────────────────────┐
   * │ 봇의 서버발 이벤트는 전부 100ms 봇 틱 위에 실려 나가고(봇 이동 배치와 같은 │
   * │ 프레임), 사람 표는 소켓 수신 즉시 나간다. 즉시 중계하면 네트워크 탭에서    │
   * │ "봇 이동 배치와 같은 프레임에 도착한 progress 증가"를 골라낼 수 있다.      │
   * │ 1초 배차에 실으면 사람 표와 봇 표가 같은 봉투에 담겨 구분이 사라진다.       │
   * │ (SPEC §6.1이 Realtime Broadcast를 버리고 폴링을 택한 것과 같은 근거다.)    │
   * └──────────────────────────────────────────────────────────────────────┘
   *
   * 값이 안 바뀌었으면 아예 보내지 않는다 — 1초마다 같은 숫자가 오가면 그 자체가 소음이다.
   */
  private pumpVoteProgress(now: number): void {
    const s = this.round;
    if (!s || (s.phase !== 'vote' && s.phase !== 'verdict')) return;
    if (now - this.progressAt < VOTE_PROGRESS_INTERVAL_MS) return;
    this.progressAt = now;

    const p = voteProgress(s);
    if (p.voted === this.progressSent) return;
    this.progressSent = p.voted;
    this.broadcast({ t: 'vote_progress', voted: p.voted, total: p.total });
  }

  /**
   * 조기 종료. **vote 에만 있다** (SPEC §5.1, I5 — verdict·speak 에는 넣지 마라,
   * lib/mp/constants.ts 의 단계 길이 상자 3번 참고).
   *
   * 새지 않는 근거: 좌석 수도 AI 수도 공개이므로(§15-3) 사람 수 H도 공개다. 종료 시점의
   * progress 가 H 근방이라는 건 모두가 이미 아는 수를 다시 보여 줄 뿐이고, 종료 **시각**은
   * 오직 사람들의 클릭으로 정해진다 — 봇 쪽 정보가 시간 축에 실리지 않는다.
   * 단 **progress 에 좌석 정보를 실으면 그 순간 즉사한다** ("안 낸 자리 = 봇" 확정).
   */
  private maybeCloseVote(now: number): void {
    const s = this.round;
    if (!s || s.phase !== 'vote' || now >= s.phaseEndsAt) return;
    if (!haveAllVoted(s, this.connectedHumanSeats())) return;

    // ★ 남은 봇 표를 **먼저** 넣는다. 마감을 당기고 나면 castVote 가 거절하고,
    //   그러면 reveal 의 votes[] 에 "표를 안 낸 자리"가 남는다. 그 판은 어차피 정체가
    //   공개되지만, **다음 판**에 "조기 종료 때 표가 잘리는 자리 = 봇"이라는 메타가
    //   남는다 (§18.6 다시 하기 — 같은 방 · 같은 사람). 여기서 지운다.
    for (const [id, plan] of Object.entries(this.botVotes)) {
      if (plan.cast) continue;
      castVote(s, id, plan.targetId, now);
      plan.cast = true;
    }
    s.phaseEndsAt = now; // 이 틱의 stepRound 가 곧바로 넘긴다
  }

  /** speak 창이 열렸다 — 봇들의 발화 시각을 창 안으로 당긴다 (primeForTopic 의 상자). */
  private primeBotsForSpeak(now: number): void {
    const s = this.round;
    if (!s) return;
    const win = Math.max(0, s.phaseEndsAt - now);
    for (const bot of this.roundBots()) {
      // 침묵 추첨은 **좌석마다 · 라운드마다 독립**이다 (BOT_SILENCE_CHANCE).
      primeForTopic(bot, now, win, Math.random() >= BOT_SILENCE_CHANCE);
    }
  }

  private hushBots(): void {
    for (const bot of this.bots ?? []) cancelSpeech(bot);
  }

  /**
   * 봇의 표를 **미리 정하고 시각만 흩뿌린다** (BOT_VOTE_*_FRAC 의 상자).
   *
   * ┌─ ★ 왜 즉시 투표가 I1 위반인가 ──────────────────────────────────────────┐
   * │ 페이즈가 열린 그 순간 표를 넣으면 vote_progress 가 0 → (봇 수)로 **튄다.**  │
   * │ 봇이 몇인지는 어차피 공개지만(§15-3), "판 시작 0.1초에 들어온 표"라는       │
   * │ **타이밍 패턴**은 공개 대상이 아니다. 몇 판만 보면 그 계단이 몇 명분인지가   │
   * │ 읽히고, 조기 종료와 겹치면 남은 미제출 좌석 수까지 확정된다.                │
   * │ 그래서 표는 여기서 정하되(생성), 반영은 예약 시각에 한다(driveBotPlans) —   │
   * │ SPEC §5.3의 visible_at 패턴과 같은 구조다.                                │
   * └────────────────────────────────────────────────────────────────────────┘
   *
   * 자기 자신은 찍지 않는다 — 뽑을 때 빼고, castVote 가 한 번 더 거부한다.
   * 사람은 마감까지 표를 바꾸므로 봇도 가끔 바꾼다 (BOT_VOTE_CHANGE_CHANCE).
   */
  private planBotVotes(now: number): void {
    const s = this.round;
    if (!s) return;
    this.botVotes = {};
    const win = Math.max(0, s.phaseEndsAt - now);

    for (const bot of this.roundBots()) {
      const targetId = this.pickVoteTarget(bot.id, s.seatIds, null);
      if (!targetId) continue;

      // 좌석마다 독립 추첨이다. 인덱스로 스태거(base + i·Δ)하면 간격이 규칙적이 되어
      // **간격 자체가 신호**가 된다 (§18.5가 침묵 임계에 대해 경고한 것과 같다).
      const at = now + win * rand(BOT_VOTE_MIN_FRAC, BOT_VOTE_MAX_FRAC);

      let changeAt: number | null = null;
      let changeTargetId: string | null = null;
      if (Math.random() < BOT_VOTE_CHANGE_CHANCE) {
        changeTargetId = this.pickVoteTarget(bot.id, s.seatIds, targetId);
        if (changeTargetId !== null) changeAt = at + (s.phaseEndsAt - at) * rand(0.2, 0.85);
      }

      this.botVotes[bot.id] = { at, targetId, cast: false, changeAt, changeTargetId, changed: false };
    }
  }

  /**
   * 생사 재투표도 같은 규칙이다 — 미리 정하고 시각만 흩뿌린다.
   * **지목된 봇 본인은 빠진다** (기권). castVerdict 가 한 번 더 거부한다.
   * 찬반은 대략 반반이다 — 봇이 늘 찬성(또는 늘 반대)이면 그 자리들이 한 덩어리가 된다.
   */
  private planBotVerdicts(now: number): void {
    const s = this.round;
    if (!s) return;
    this.botVerdicts = {};
    const win = Math.max(0, s.phaseEndsAt - now);

    for (const bot of this.roundBots()) {
      if (bot.id === s.nomineeId) continue;
      this.botVerdicts[bot.id] = {
        at: now + win * rand(BOT_VOTE_MIN_FRAC, BOT_VOTE_MAX_FRAC),
        guilty: Math.random() < 0.5,
        cast: false,
      };
    }
  }

  /** 예약 시각이 지난 봇 표를 실제로 넣는다. 한 번 넣은 예약은 다시 보지 않는다. */
  private driveBotPlans(now: number): void {
    const s = this.round;
    if (!s) return;

    if (s.phase === 'vote') {
      for (const [id, plan] of Object.entries(this.botVotes)) {
        if (!plan.cast && now >= plan.at) {
          castVote(s, id, plan.targetId, now);
          plan.cast = true;
        }
        if (
          plan.cast &&
          !plan.changed &&
          plan.changeAt !== null &&
          plan.changeTargetId !== null &&
          now >= plan.changeAt
        ) {
          castVote(s, id, plan.changeTargetId, now);
          plan.changed = true;
        }
      }
      return;
    }

    if (s.phase === 'verdict') {
      for (const [id, plan] of Object.entries(this.botVerdicts)) {
        if (plan.cast || now < plan.at) continue;
        castVerdict(s, id, plan.guilty, now);
        plan.cast = true;
      }
    }
  }

  /**
   * 봇이 누구를 찍을까. 자기 자신과 `avoid`(방금 찍었던 자리)는 뺀다.
   *
   * ★ 균등 무작위로 두지 않는다. reveal 이 votes[] 를 전부 공개하므로, 몇 판만 하면
   *   **"자유대화에서 아무도 의심하지 않은 자리를 찍은 표 = AI"** 라는 메타가 학습된다
   *   (§18.6 다시 하기에서 살아 돌아온다). 그래서 채팅에서 이름이 오르내린 자리에
   *   가중치를 준다 — 사람도 의심받은 사람을 찍는다.
   *   맥락은 chatLog 하나뿐이고, 그건 이미 갖고 있다.
   */
  private pickVoteTarget(voterId: string, seatIds: string[], avoid: string | null): string | null {
    const cands = seatIds.filter((id) => id !== voterId && id !== avoid);
    if (cands.length === 0) return null;

    const heat = new Map<string, number>();
    for (const line of this.chatLog) {
      for (const seat of this.meta?.seats ?? []) {
        if (seat.id === voterId) continue;
        if (line.text.includes(seat.nickname)) heat.set(seat.id, (heat.get(seat.id) ?? 0) + 1);
      }
    }

    // 언급 한 번마다 가중치 +2, 상한 4회. 상한이 없으면 한 번 도마에 오른 자리를
    // **전 봇이 몰아서** 찍고, 그 만장일치가 다시 표식이 된다.
    const weights = cands.map((id) => 1 + Math.min(heat.get(id) ?? 0, 4) * 2);
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = Math.random() * total;
    for (let i = 0; i < cands.length; i += 1) {
      roll -= weights[i];
      if (roll <= 0) return cands[i];
    }
    return cands[cands.length - 1];
  }

  /**
   * 지목된 자리가 봇이면 최후변론을 한 번 예약한다. 사람이면 아무것도 하지 않는다.
   *
   * ★ 15% 확률로 침묵한다 (BOT_DEFENSE_SILENCE_CHANCE): "변론 안 하면 봇"도
   *   "꼭 변론하면 봇"도 둘 다 신호라 양쪽을 다 열어 둔다.
   * ★ defense 는 지목된 자리가 사람이든 봇이든 **20초를 꽉 채운다.** 여기서 뭘 하든
   *   단계 길이는 안 바뀐다 — 그게 §5.3의 대칭이다.
   */
  private scheduleBotDefense(now: number): void {
    const s = this.round;
    if (!s?.nomineeId) return;
    const bot = (this.bots ?? []).find((b) => b.id === s.nomineeId);
    if (!bot) return;
    if (Math.random() < BOT_DEFENSE_SILENCE_CHANCE) return;

    if (DISGUISE_OFF) scheduleInstantSpeech(bot, now);
    else
      scheduleSpeech(
        bot,
        pickLine(this.botLines(), this.recentTexts()),
        now,
        rand(DEFENSE_READ_MIN_MS, DEFENSE_READ_MAX_MS),
      );
    void this.upgradeSpeech(bot, bot.speechSeq, DEFENSE_PROMPT);
  }

  /* ─────────────────────────────── 방 메타 ─────────────────────────────── */

  private async loadMeta(): Promise<CachedMeta | null> {
    const cached = await this.ctx.storage.get<CachedMeta>(KEY_META);
    if (cached) this.meta = cached;
    return this.meta;
  }

  private async ensureMeta(roomId: string, force: boolean): Promise<CachedMeta | null> {
    const now = Date.now();
    if (!this.meta) await this.loadMeta();

    // ┌─ 판이 도는 동안에는 명부를 다시 읽지 않는다 (upgrade ②′ 의 짝) ────────────┐
    // │ 판의 좌석은 어차피 얼어 있다(RoundState.seatIds). 그런데 명부만 갱신되면    │
    // │ 판 밖에서 DB 에 앉은 사람(입장은 round_in_progress 로 거절된다)이 유령      │
    // │ 아바타로 나타나고, 그 좌석이 밀어낸 월드 AI 가 판 중간에 이사한다 —         │
    // │ 판에 있던 아바타가 눈앞에서 사라지는 게 그 증상이다. 판이 끝나면 다음       │
    // │ 조회가 한꺼번에 따라잡고, 이동은 player_left/joined 로 정상 방송된다.       │
    // └────────────────────────────────────────────────────────────────────────────┘
    if (this.round && !this.round.done && this.meta) return this.meta;

    // 시작 전 방은 짧게 잡는다 — 게이트가 생기는 순간을 놓치면 안 된다 (상수의 상자).
    const ttl = this.meta?.startedAt == null ? META_START_TTL_MS : META_TTL_MS;
    if (!force && this.meta && now - this.meta.fetchedAt < ttl) return this.meta;

    const fresh = await fetchRoomMeta(this.env, roomId);
    if (!fresh) return this.meta; // Next가 잠깐 죽어도 캐시로 버틴다

    // 좌석 명단이 바뀌었다 (사람이 들어왔거나, 게임이 시작돼 봇이 생겼다).
    //
    // ┌─ ★ 전부 다시 만들지 않는다 — 예전엔 여기가 `this.bots = null` 이었다 ─────┐
    // │ createBot 은 waitUntil·nextChatAt·speechSeq 를 전부 새로 뽑는다. 그래서    │
    // │ 누가 접속한 그 순간 **모든 봇이 동시에 멈춰 서고(최대 7초), 그 뒤 25초간   │
    // │ 한 마디도 못 한다.** 사람들은 계속 떠드는데 조용해진 자리들이 한 덩어리로  │
    // │ 묶인다 — 입장 한 번에 명단이 드러난다 (I1). createBot 주석이 "전부 동시에  │
    // │ 출발하면 들킨다"고 적어 둔 그 상황이 **입장마다** 재현되고 있었다.         │
    // │ 그래서 없어진 자리만 지우고 새로 생긴 자리만 만든다. 남은 봇은 안 건드린다.│
    // └──────────────────────────────────────────────────────────────────────────┘
    //
    // ★ 진행 중인 판(this.round)은 **좌석이 바뀌어도 버리지 않는다.** 판의 좌석·사람
    //   명단은 startRound 시점에 얼어붙어 있고(RoundState.seatIds) 집계는 그것만 본다 —
    //   늦게 들어온 사람의 표는 castVote 가 거절하므로 분모가 흔들리지 않는다.
    //   여기서 판을 지우면 4분을 달려 온 투표가 "누가 새로고침했다"는 이유로 사라진다.
    const prev = this.meta;
    const before = prev?.seats.map((s) => s.id).join(',') ?? '';
    const after = fresh.seats.map((s) => s.id).join(',');
    if (before !== after && this.bots) {
      const botSeats = fresh.seats.filter((s) => s.is_bot);
      const alive = new Set(botSeats.map((s) => s.id));
      const kept = this.bots.filter((b) => alive.has(b.id));
      const known = new Set(kept.map((b) => b.id));
      for (const s of botSeats) {
        if (known.has(s.id)) continue;
        kept.push(
          createBot(
            { id: s.id, seat: s.seat, nickname: s.nickname, maskId: s.mask_id },
            WORLD_SEAT_SLOTS,
            now,
          ),
        );
      }
      this.bots = kept.sort((a, b) => a.seat - b.seat);
    }

    this.meta = { ...fresh, fetchedAt: now, roomId };
    await this.ctx.storage.put(KEY_META, this.meta);

    // ┌─ 명부가 실제로 바뀐 경우 (I1 — seatSnapshots 의 상자) ────────────────────┐
    // │ player_joined · player_left 는 이제 **좌석 명단의 변화**만 뜻한다. 접속·   │
    // │ 퇴장이 아니다 — 그건 사람에게만 나는 이벤트라 그 자체가 명단이었다.        │
    // │ 여기서는 사람 좌석이든 봇 좌석이든 **똑같이** 낸다. 게임이 시작돼 봇이     │
    // │ 생기는 순간이 대표적인데, 예전엔 그 좌석이 아무 예고 없이 player_moved 만  │
    // │ 보냈다 — "명부에 없던 id 가 움직이면 봇 확정"이었고, 덤으로 그 아바타는    │
    // │ 재접속 전까지 화면에 아예 안 보였다(클라가 모르는 id 의 move 를 버린다).   │
    // │                                                                          │
    // │ prev 가 없으면(첫 조회·storage 유실) 아무것도 내지 않는다. 비교 대상이     │
    // │ 없으므로 전 좌석이 "새로 생긴" 것으로 보여 명부가 통째로 다시 나간다.      │
    // └──────────────────────────────────────────────────────────────────────────┘
    if (prev && before !== after) {
      const gone = new Set(fresh.seats.map((s) => s.id));
      for (const s of prev.seats) {
        if (!gone.has(s.id)) {
          this.broadcast({ t: 'player_left', id: s.id });
          this.lastPose.delete(s.id);
          this.emitPhase.delete(s.id);
        }
      }
      const known = new Set(prev.seats.map((s) => s.id));
      for (const p of this.seatSnapshots(this.meta)) {
        if (!known.has(p.id)) this.broadcast({ t: 'player_joined', player: p });
      }
    }

    return this.meta;
  }

  /* ─────────────────────────────── 유틸 ─────────────────────────────── */

  private humanCount(): number {
    return this.ctx.getWebSockets().length;
  }

  /**
   * 게임 메시지(vote · verdict · intro_done)를 받아 줄 때인가 — **자원 보호만** 한다.
   *
   * ★ 거절해도 아무것도 돌려주지 않는다. 이유를 내려주면 그게 곧 단계·좌석 정보다 (I1).
   *   위조는 여기서 막는 게 아니다 — voter 는 소켓 attachment 에서 되찾고, 판정은
   *   castVote/castVerdict 가 한다.
   */
  private allowGameMessage(ws: WebSocket): boolean {
    const now = Date.now();
    if (now - (this.lastGameMsgAt.get(ws) ?? 0) < GAME_MSG_MIN_INTERVAL_MS) return false;
    this.lastGameMsgAt.set(ws, now);
    return true;
  }

  private humanSnapshots(): PlayerSnapshot[] {
    const out: PlayerSnapshot[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as PlayerSnapshot | null;
      if (s) out.push(s);
    }
    return out;
  }

  /**
   * 방의 **명부** — 좌석 명단 전부를 사람·봇 구분 없이 한 배열로.
   *
   * ┌─ ★★ I1 — 이 저장소에서 제일 크게 샜던 자리 ──────────────────────────────┐
   * │ 예전 welcome 은 `접속 중인 사람들 + 봇 전부` 였다. 그래서 **방에 제일 먼저 │
   * │ 들어가면 앞부분이 통째로 비고, players[] 가 그대로 봇 명단**이었다.        │
   * │ 좌석순 정렬은 아무 방어도 되지 않았다 — 개수가 답이었으니까.               │
   * │ 두 번째로 들어온 사람도 마찬가지다: 받은 명부에서 뒤이어 오는 사람들을      │
   * │ 빼면 명단이 완성된다.                                                     │
   * │                                                                          │
   * │ 그래서 명부의 뜻을 **소켓 상태에서 좌석 명단으로** 바꿨다. 접속했는지는     │
   * │ 명부에 나타나지 않는다. 미접속 사람은 마지막으로 알려진 자세로(없으면       │
   * │ 스폰 자리에) 서 있고, 그건 "가만히 서 있는 사람"과 구분되지 않는다.        │
   * │                                                                          │
   * │ ★ 봇 좌석과 사람 좌석이 **같은 모양**으로 나가야 한다. 봇에게만 있는 필드도, │
   * │   사람에게만 있는 기본값도 두지 마라 — 그 자체가 답이 된다.               │
   * │ ★ 배열은 좌석순이다. 사람 먼저·봇 먼저로 모으면 순서가 곧 명단이다.        │
   * └──────────────────────────────────────────────────────────────────────────┘
   *
   * @param self 아직 accept 되지 않은 이 소켓의 스냅샷. 있으면 그 좌석에 얹는다 —
   *             입장 시점에는 humanSnapshots 에 아직 안 잡히기 때문이다.
   */
  private seatSnapshots(meta: CachedMeta, self?: PlayerSnapshot): PlayerSnapshot[] {
    const live = new Map<string, PlayerSnapshot>();
    for (const s of this.humanSnapshots()) live.set(s.id, s);
    if (self) live.set(self.id, self);
    const botById = new Map((this.bots ?? []).map((b) => [b.id, b]));

    return meta.seats
      .map((seat): PlayerSnapshot => {
        const bot = botById.get(seat.id);
        if (bot) return botSnapshot(bot);
        // 사람 좌석: 접속 중이면 지금 자세, 아니면 마지막으로 본 자세, 그것도
        // 없으면 스폰 자리. 봇도 접속 전에는 정확히 같은 스폰 자리에 서 있다.
        const known = live.get(seat.id) ?? this.lastPose.get(seat.id);
        if (known) return known;
        const start = spawnFor(seat.seat, WORLD_SEAT_SLOTS);
        return {
          id: seat.id,
          seat: seat.seat,
          nickname: seat.nickname,
          maskId: seat.mask_id,
          x: start.x,
          z: start.z,
          y: 0,
          heading: 0,
          anim: 'idle',
        };
      })
      .sort((a, b) => a.seat - b.seat);
  }

  private send(ws: WebSocket, msg: S2CMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // 이미 닫힌 소켓. close 이벤트가 곧 온다
    }
  }

  /**
   * 봇 좌석에서 나가는 이벤트를 **봇 틱 격자에서 떼어** 내보낸다 (I1).
   *
   * 좌석마다 0~BOT_EMIT_JITTER_MS 중 하나를 뽑아 **고정으로** 쓴다. 매번 새로 뽑으면
   * 송신 간격이 덜덜 떨려서 그게 다시 신호다 — 사람의 위상은 rAF 에 물려 안정적이다.
   * setTimeout 이라 별개의 이벤트 루프 턴으로 밀려 나가고, 그게 이 함수의 전부다.
   *
   * DO 가 evict 되어 대기 중이던 타이머가 날아가면 그 한 샘플은 사라진다 — 다음 틱이
   * 다시 보내므로 무해하다(사람 패킷이 하나 유실된 것과 구분되지 않는다).
   */
  private emitAsBot(botId: string, msg: S2CMessage): void {
    // 측정 중에는 위상도 0이다 (DISGUISE_OFF). 최대 80ms 지만 이 파일에 남은
    // 마지막 인위적 지연이라, 남겨두면 "0으로 줄였다"가 사실이 아니게 된다.
    if (DISGUISE_OFF) {
      this.broadcast(msg);
      return;
    }
    let phase = this.emitPhase.get(botId);
    if (phase === undefined) {
      phase = Math.random() * BOT_EMIT_JITTER_MS;
      this.emitPhase.set(botId, phase);
    }
    setTimeout(() => this.broadcast(msg), phase);
  }

  private broadcast(msg: S2CMessage, exclude?: WebSocket): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      try {
        ws.send(payload);
      } catch {
        // 위와 같다
      }
    }
  }
}
