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
  FALLBACK_LINES,
  botSnapshot,
  createBot,
  shouldChat,
  spawnFor,
  stepBot,
  toPose,
  type BotPose,
  type BotState,
} from './bots';
import { fetchRoomMeta, type RoomMeta } from './room-meta';
import type { Env } from './bindings';

const KEY_META = 'meta';
const KEY_BOTS = 'bots';
const KEY_EMPTY_AT = 'emptyAt';

/** 방 메타(좌석 명단) 캐시 수명. 이보다 자주 사람이 들어오면 pid 미발견 시 강제 갱신된다. */
const META_TTL_MS = 60_000;

interface CachedMeta extends RoomMeta {
  fetchedAt: number;
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
        snap.heading = move.heading;
        snap.anim = move.anim;
        // 새로 들어오는 사람의 welcome에 반영되도록 attachment를 갱신한다.
        ws.serializeAttachment(snap);

        this.broadcast(
          { t: 'player_moved', id: snap.id, x: snap.x, z: snap.z, heading: snap.heading, anim: snap.anim },
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
      if (stepBot(bot, now, dt)) {
        this.broadcast({
          t: 'player_moved',
          id: bot.id,
          x: bot.x,
          z: bot.z,
          heading: bot.heading,
          anim: bot.anim,
        });
      }
      if (shouldChat(bot, now)) {
        const lines = this.meta?.botLines?.length ? this.meta.botLines : FALLBACK_LINES;
        this.broadcast({
          t: 'chat',
          id: bot.id,
          nickname: bot.nickname,
          text: lines[Math.floor(Math.random() * lines.length)],
          ts: now,
        });
      }
    }

    if (now - this.lastPersistAt > BOT_PERSIST_MS) {
      this.lastPersistAt = now;
      void this.persistBots();
    }
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

    this.meta = { ...fresh, fetchedAt: now };
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
