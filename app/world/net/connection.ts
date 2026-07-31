/**
 * WebSocket 래퍼. 소유: 원상 (/world)
 *
 * 콜백 인터페이스(WorldEvents)로 한 겹 감싸는 이유: **소켓 코드가 상태관리 라이브러리를
 * 모르게 하려고.** 다른 화면으로 옮길 때 이 파일은 그대로 가고 콜백 구현만 새로 쓴다.
 *
 * 하트비트는 raw 텍스트 "ping"이다. JSON 프로토콜이 아니다 —
 * 플랫폼(Cloudflare)이 DO를 깨우지 않고 대신 "pong"을 돌려주기 때문이다.
 * 그래서 onmessage에서 **JSON.parse 전에** 걸러낸다.
 */

import { PING_INTERVAL_MS, PROTOCOL_VERSION } from '@/lib/mp/constants';
import type {
  AnimState,
  C2SMessage,
  ErrorCode,
  PlayerSnapshot,
  S2CMessage,
} from '@/lib/mp/protocol';

export interface WorldEvents {
  onWelcome(selfId: string, players: PlayerSnapshot[]): void;
  onJoined(player: PlayerSnapshot): void;
  onLeft(id: string): void;
  onMoved(id: string, x: number, z: number, y: number, heading: number, anim: AnimState): void;
  onChat(id: string, nickname: string, text: string, ts: number): void;
  onError(code: ErrorCode | 'connection_failed'): void;
  onClose(): void;
}

export class WorldConnection {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** 서버가 error를 보낸 뒤 닫히면 onClose로 이유를 덮어쓰지 않는다 */
  private failed = false;

  connect(wsBase: string, roomId: string, ticket: string, events: WorldEvents): void {
    this.close();
    this.failed = false;

    const base = wsBase.replace(/\/$/, '');
    const url =
      `${base}/rooms/${encodeURIComponent(roomId)}/ws` +
      `?t=${encodeURIComponent(ticket)}&v=${PROTOCOL_VERSION}`;

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.stopPing();
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('ping');
      }, PING_INTERVAL_MS);
    };

    ws.onerror = () => {
      this.failed = true;
      events.onError('connection_failed');
    };

    ws.onclose = () => {
      this.stopPing();
      if (!this.failed) events.onClose();
    };

    ws.onmessage = (e: MessageEvent) => {
      if (e.data === 'pong') return; // 프로토콜 파싱 전에 걸러낸다

      let msg: S2CMessage;
      try {
        msg = JSON.parse(e.data as string) as S2CMessage;
      } catch {
        return;
      }

      switch (msg.t) {
        case 'welcome':
          events.onWelcome(msg.selfId, msg.players);
          break;
        case 'player_joined':
          events.onJoined(msg.player);
          break;
        case 'player_left':
          events.onLeft(msg.id);
          break;
        case 'player_moved':
          // y는 나중에 붙은 필드다. 구 워커·구 클라이언트는 안 보낸다 → 바닥으로 읽는다
          events.onMoved(msg.id, msg.x, msg.z, msg.y ?? 0, msg.heading, msg.anim);
          break;
        case 'chat':
          events.onChat(msg.id, msg.nickname, msg.text, msg.ts);
          break;
        case 'error':
          this.failed = true;
          events.onError(msg.code);
          break;
        default:
          break; // 전방 호환. 모르는 타입은 무시한다
      }
    };
  }

  sendMove(x: number, z: number, y: number, heading: number, anim: AnimState): void {
    this.send({ t: 'move', x, z, y, heading, anim });
  }

  sendChat(text: string): void {
    this.send({ t: 'chat', text });
  }

  /** 연결 전 호출은 정상 상황이다(씬이 먼저 뜬다). 조용히 버린다. */
  private send(msg: C2SMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.stopPing();
    if (this.ws) {
      // 닫는 중에 콜백이 튀어 상태를 되돌리는 걸 막는다
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
  }

  private stopPing(): void {
    if (this.pingTimer === null) return;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
