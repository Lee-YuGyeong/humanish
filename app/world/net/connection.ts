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
  RevealIdentity,
  RevealVote,
  RoundPhase,
  RoundWinner,
  S2CMessage,
} from '@/lib/mp/protocol';

/** round 메시지 알맹이. 씬·HUD 가 읽는 진행 상태다 (protocol.ts 의 t:'round'). */
export interface RoundInfo {
  phase: RoundPhase;
  /** ★ 조명의 소스는 이것 **하나**다. defense 에서만 채워진다 (protocol.ts 참고) */
  spotlightId: string | null;
  topic: string | null;
  /** 서버 시각(epoch ms). 카운트다운은 표시용이다 (I2) */
  endsAt: number;
  /** 몇 번째 주제 라운드인가 (1-based). 주제 라운드가 아니면 0 */
  round: number;
  /** 주제 라운드 총 수 (①/② 표시용) */
  totalRounds: number;
  /** 확정된 지목 대상. defense 부터 채워진다 */
  nomineeId: string | null;
}

/**
 * reveal 메시지 알맹이 — **판이 끝난 뒤의 결과 전문**.
 *
 * ★ `identities` 가 이 프로젝트에서 정체가 실리는 **유일한 경로**다 (I1 의 예외).
 *   이 타입을 다른 이벤트에 재사용하지 마라 — 재사용하는 순간 통로가 하나 더 생긴다.
 */
export interface RevealResult {
  nomineeId: string | null;
  executed: boolean;
  winner: RoundWinner;
  verdict: { guilty: number; innocent: number };
  votes: RevealVote[];
  identities: RevealIdentity[];
}

export interface WorldEvents {
  onWelcome(selfId: string, players: PlayerSnapshot[]): void;
  onJoined(player: PlayerSnapshot): void;
  onLeft(id: string): void;
  onMoved(id: string, x: number, z: number, y: number, heading: number, anim: AnimState): void;
  onChat(id: string, nickname: string, text: string, ts: number): void;
  /** 라운드테이블 진행 상태가 바뀌었다 (단계 전환 · 입장 시 1회) */
  onRound(round: RoundInfo): void;
  /**
   * 투표 진행 현황. **숫자 둘뿐이다** — 누가 냈는지도, 누구를 찍었는지도 오지 않는다 (I1).
   * 서버가 고정 간격으로 묶어 보내므로 내 표를 보낸 직후에 바로 오지 않는다.
   */
  onVoteProgress(voted: number, total: number): void;
  /** 처형이 확정됐다. 판당 최대 한 번. 정체는 실려 있지 않다 */
  onEliminated(id: string): void;
  /** 판이 끝났다. 정체가 실린 유일한 이벤트다 */
  onReveal(reveal: RevealResult): void;
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
        case 'round':
          events.onRound({
            phase: msg.phase,
            spotlightId: msg.spotlightId,
            topic: msg.topic,
            endsAt: msg.endsAt,
            round: msg.round,
            totalRounds: msg.totalRounds,
            nomineeId: msg.nomineeId,
          });
          break;
        case 'vote_progress':
          events.onVoteProgress(msg.voted, msg.total);
          break;
        case 'eliminated':
          events.onEliminated(msg.id);
          break;
        case 'reveal':
          events.onReveal({
            nomineeId: msg.nomineeId,
            executed: msg.executed,
            winner: msg.winner,
            verdict: msg.verdict,
            votes: msg.votes,
            identities: msg.identities,
          });
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

  /** 인트로 영상이 끝났다 — 워커가 라운드테이블 판을 시작하는 신호다. */
  sendIntroDone(): void {
    this.send({ t: 'intro_done' });
  }

  /**
   * 지목 투표. 마감까지 몇 번이든 다시 보낼 수 있고 마지막 것이 유효하다.
   *
   * ★ **나갔는지(true)를 돌려준다.** 서버는 "네 표를 받았다"를 좌석 단위로 되돌려
   *   주지 않는다 — 그런 메시지를 만드는 순간 그게 I1 누출이다 (protocol.ts 의
   *   vote_progress 주석). 그래서 내 선택 표시의 유일한 근거가 이 반환값이다.
   *   소켓이 닫혀 있으면 false 이고, 호출부는 그때 선택을 확정하면 안 된다.
   */
  sendVote(targetId: string): boolean {
    return this.send({ t: 'vote', targetId });
  }

  /** 생사 재투표. 반환값의 뜻은 sendVote 와 같다. */
  sendVerdict(guilty: boolean): boolean {
    return this.send({ t: 'verdict', guilty });
  }

  /**
   * 연결 전 호출은 정상 상황이다(씬이 먼저 뜬다). 조용히 버린다.
   * 실제로 나갔으면 true — 투표처럼 "보냈나"가 화면에 남는 요청이 이 값을 본다.
   */
  private send(msg: C2SMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
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
