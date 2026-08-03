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
  BOT_PERSIST_MS,
  BOT_TICK_MS,
  CHAT_HISTORY_MAX,
  CHAT_MAX_LEN,
  CHAT_MIN_INTERVAL_MS,
  MAX_GAME_MESSAGE_LEN,
  MAX_WS_MESSAGE_LEN,
  MOVE_MIN_INTERVAL_MS,
  PROTOCOL_VERSION,
  SOCKET_TIMEOUT_MS,
  SWEEP_ALARM_MS,
} from '../../lib/mp/constants';
import type { ErrorCode, PlayerSnapshot, S2CMessage } from '../../lib/mp/protocol';
import { verifyTicket } from '../../lib/mp/ticket';
import { isC2SMessage, parseMove } from '../../lib/mp/validate';
import {
  botSnapshot,
  createBot,
  pickLine,
  pickResponder,
  readDelayMs,
  replaceSpeech,
  scheduleSpeech,
  shouldChat,
  spawnFor,
  stepBot,
  takeSpeech,
  toPose,
  type BotPose,
  type BotState,
} from './bots';
import { fetchRoomMeta, type RoomMeta } from './room-meta';
import { fetchAgentLines, type ChatLine } from './world-agent';
import type { Env } from './bindings';

const KEY_META = 'meta';
const KEY_BOTS = 'bots';
const KEY_EMPTY_AT = 'emptyAt';

/** 방 메타(좌석 명단) 캐시 수명. 이보다 자주 사람이 들어오면 pid 미발견 시 강제 갱신된다. */
const META_TTL_MS = 60_000;

/**
 * 이만큼도 안 남았으면 LLM을 아예 부르지 않는다 (ms). 게임 방 전용 —
 * 왕복이 이 안에 끝날 리 없으므로, 부르면 남의 지갑만 쓰고 결과는 버려진다.
 * 월드 AI 방은 늦은 답도 말하므로 이 문턱을 안 본다 (upgradeSpeech 참고).
 */
const MIN_AGENT_BUDGET_MS = 900;

/**
 * 월드 AI 방에서 LLM을 기다려 주는 상한 (ms). 예약 시각(speakAt)에 매이지 않는다 —
 * 풀 문구가 없는 방이라 자리를 놓친 답은 버리면 그냥 침묵인데, 사용자 결정은
 * "어색한 풀 문구 < 침묵 < 늦은 진짜 답"이다. /api/agent의 8초 컷(SPEC §12.3)
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
  /**
   * 최근 채팅. 사람·봇 것을 같이 담는다 (id로 나중에 가른다).
   *
   * 월드 채팅은 저장하지 않으므로(SPEC §6.1의 messages와 별개다) 이게 유일한 기록이고,
   * evict로 날아가도 무해하다 — 비면 "방금 나온 문구 피하기"만 못 할 뿐이다.
   * LLM이 붙으면(3단계) 여기가 그대로 대화 맥락이 된다.
   */
  private chatLog: { id: string; nickname: string; text: string }[] = [];

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
    for (const other of this.ctx.getWebSockets()) {
      const s = other.deserializeAttachment() as PlayerSnapshot | null;
      if (s?.id === ticket.pid) {
        this.broadcast({ t: 'player_left', id: s.id }, other);
        other.close(4002, 'superseded');
      }
    }

    // ⑦ 상태 구성 → accept → 명부 교환
    const start = spawnFor(ticket.seat, meta.capacity);
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

    // accept 전에 모아야 한다. 뒤에 모으면 자기 자신이 명부에 섞인다.
    const others = this.humanSnapshots().filter((s) => s.id !== snapshot.id);
    const bots = await this.ensureBots(meta);

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(snapshot);

    this.send(server, {
      t: 'welcome',
      selfId: snapshot.id,
      // 사람과 봇을 한 배열에 섞는다. 순서로도 갈리지 않게 좌석순으로 정렬한다.
      players: [...others, ...bots.map(botSnapshot)].sort((a, b) => a.seat - b.seat),
    });
    this.broadcast({ t: 'player_joined', player: snapshot }, server);

    await this.ctx.storage.delete(KEY_EMPTY_AT);
    await this.ensureAlarm();
    this.startSim();

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

        const now = Date.now();
        if (now - (this.lastChatAt.get(ws) ?? 0) < CHAT_MIN_INTERVAL_MS) return;
        this.lastChatAt.set(ws, now);

        // 닉네임·시각은 서버 값만 쓴다. 본인도 포함해 보낸다 —
        // 낙관적 로컬 에코를 하면 내 화면과 남의 화면에서 순서가 달라진다.
        this.broadcast({ t: 'chat', id: snap.id, nickname: snap.nickname, text, ts: now });
        this.rememberChat(snap.id, snap.nickname, text);

        // 봇 하나가 대꾸할 수도 있다. **사람 소켓의 채팅에서만 부른다** —
        // 봇 발화에서도 부르면 봇끼리 끝없이 주고받는다.
        this.reactToHuman(now, text);
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
    if (snap) this.broadcast({ t: 'player_left', id: snap.id }, ws);

    if (this.humanCount() === 0) {
      this.stopSim();
      await this.ctx.storage.put(KEY_EMPTY_AT, Date.now());
      await this.persistBots();
    }
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
    await this.persistBots();
    await this.ctx.storage.setAlarm(now + SWEEP_ALARM_MS);
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_ALARM_MS);
    }
  }

  /* ─────────────────────────── 봇 시뮬레이션 ─────────────────────────── */

  private startSim(): void {
    if (this.simTimer !== null) return;
    if (!this.bots || this.bots.length === 0) return;
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

  /** evict 후 첫 이벤트에서 메타·봇·타이머를 되살린다. */
  private async reviveIfNeeded(): Promise<void> {
    if (this.simTimer !== null) return;
    if (this.humanCount() === 0) return;

    const meta = this.meta ?? (await this.loadMeta());
    if (!meta) return;
    await this.ensureBots(meta);
    this.startSim();
  }

  private tick(): void {
    const now = Date.now();
    const dt = Math.min((now - this.lastTickAt) / 1000, 0.5);
    this.lastTickAt = now;

    const bots = this.bots;
    if (!bots || bots.length === 0 || this.humanCount() === 0) {
      this.stopSim();
      return;
    }

    for (const bot of bots) {
      // ① 말할 때가 됐으면 **예약만** 한다. 여기서 바로 broadcast하면 걸어가면서
      //    말풍선이 뜬다 — 사람은 타이핑 중 발이 묶이므로 그게 곧 봇 표식이다 (I1).
      //    stepBot보다 먼저 걸어야 같은 틱에 발이 묶인다.
      //    스스로 꺼내는 말이라 읽는 시간은 없다 — 읽을 게 없으니 바로 친다.
      //
      // ★ 직전 발화가 자기 것이면 얹지 않는다 — LLM이 대화를 이어 쓰다가 **자기가
      //   던진 질문에 자기가 답하는** 그림이 된다 (실측 — 사용자 결정으로 금지).
      //   shouldChat이 nextChatAt을 이미 미뤘으므로 이번 차례만 쉰다. 사람 발화가
      //   끼면 다음 차례에 다시 말한다.
      if (shouldChat(bot, now) && this.chatLog[this.chatLog.length - 1]?.id !== bot.id) {
        // 로비 방은 풀이 비어 있어 null이 온다 — 자리만 잡히고 문구는 LLM이 채운다.
        scheduleSpeech(bot, pickLine(this.botLines(), this.recentTexts()), now);
        // ★ 스스로 꺼내는 말도 LLM 을 태운다. 안 태우면 이 자리는 아무 말도 못 한다
        //   (예전에는 평생 풀 문구만 말했고, 사용자가 본 게 정확히 그거였다).
        //   trigger 는 없다(답할 상대가 없으니 흐름에 끼어드는 게 맞다).
        void this.upgradeSpeech(bot, bot.speechSeq, null);
      }

      // ② 굴린다. 예약이 걸려 있으면 stepBot이 세워 둔다.
      if (stepBot(bot, now, dt)) {
        this.broadcast({
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
      const said = takeSpeech(bot, now);
      if (said !== null) {
        this.broadcast({
          t: 'chat',
          id: bot.id,
          nickname: bot.nickname,
          text: said,
          ts: now,
        });
        this.rememberChat(bot.id, bot.nickname, said);
      }
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

    const bot = pickResponder(bots, now, this.meta?.companionMode === true);
    if (!bot) return;

    // 읽는 시간을 준다 — 0이면 사람이 말한 그 순간 멈추는 아바타가 생긴다 (I1).
    scheduleSpeech(bot, pickLine(this.botLines(), this.recentTexts()), now, readDelayMs());

    // 자리는 잡혔다. LLM이 speakAt 전에 오면 그 자리가 채워지고, 못 오면 잠깐 서 있다
    // 그냥 지나간다 — 어느 쪽이든 서 있는 시간은 같다 (bots.ts의 speechHeld).
    void this.upgradeSpeech(bot, bot.speechSeq, trigger);
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
    /** 반응이면 그 사람 발화. 스스로 꺼내는 말이면 null. */
    trigger: string | null,
  ): Promise<void> {
    const roomId = this.meta?.roomId;
    if (!roomId) return;
    const companion = this.meta?.companionMode === true;

    const budget = bot.speakAt - Date.now();
    if (!companion && budget < MIN_AGENT_BUDGET_MS) return;

    const lines = await fetchAgentLines(
      this.env,
      roomId,
      [bot.id],
      this.chatContext(),
      trigger,
      companion ? Math.max(budget, COMPANION_AGENT_TIMEOUT_MS) : budget,
    );
    const text = lines.find((l) => l.player_id === bot.id)?.text;
    if (!text) return;

    if (replaceSpeech(bot, seq, text, Date.now())) return;

    // 자리를 놓친 답. 게임 방이면 버린다 (위 머리말). 월드 AI 방은 **seq가 그대로일
    // 때만** 지금 바로 말한다 — 다음 예약이 이미 걸렸으면(seq 불일치) 그 예약의 LLM이
    // 이 맥락을 대신 안다. 아직 서 있는 중이면 자리도 걷는다 — 침묵과 답이 겹치지 않게.
    if (companion && bot.speechSeq === seq) {
      bot.speechHeld = false;
      bot.pendingText = null;
      const ts = Date.now();
      this.broadcast({ t: 'chat', id: bot.id, nickname: bot.nickname, text, ts });
      this.rememberChat(bot.id, bot.nickname, text);
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
          meta.capacity,
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

  /* ─────────────────────────────── 방 메타 ─────────────────────────────── */

  private async loadMeta(): Promise<CachedMeta | null> {
    const cached = await this.ctx.storage.get<CachedMeta>(KEY_META);
    if (cached) this.meta = cached;
    return this.meta;
  }

  private async ensureMeta(roomId: string, force: boolean): Promise<CachedMeta | null> {
    const now = Date.now();
    if (!this.meta) await this.loadMeta();
    if (!force && this.meta && now - this.meta.fetchedAt < META_TTL_MS) return this.meta;

    const fresh = await fetchRoomMeta(this.env, roomId);
    if (!fresh) return this.meta; // Next가 잠깐 죽어도 캐시로 버틴다

    // 좌석 명단이 바뀌었으면(사람이 들어왔거나 게임이 시작돼 봇이 생겼으면) 봇을 다시 만든다.
    const before = this.meta?.seats.map((s) => s.id).join(',') ?? '';
    const after = fresh.seats.map((s) => s.id).join(',');
    if (before !== after) this.bots = null;

    this.meta = { ...fresh, fetchedAt: now, roomId };
    await this.ctx.storage.put(KEY_META, this.meta);
    return this.meta;
  }

  /* ─────────────────────────────── 유틸 ─────────────────────────────── */

  private humanCount(): number {
    return this.ctx.getWebSockets().length;
  }

  private humanSnapshots(): PlayerSnapshot[] {
    const out: PlayerSnapshot[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as PlayerSnapshot | null;
      if (s) out.push(s);
    }
    return out;
  }

  private send(ws: WebSocket, msg: S2CMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // 이미 닫힌 소켓. close 이벤트가 곧 온다
    }
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
