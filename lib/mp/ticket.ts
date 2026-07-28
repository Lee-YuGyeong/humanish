/**
 * 입장 티켓 서명 · 검증. 소유: A
 * Next(서명)와 워커(검증)가 **같은 코드**를 쓴다. 한쪽만 고치면 전원이 못 들어온다.
 *
 * 왜 티켓인가:
 *   본인 확인 토큰(players.token)은 httpOnly 쿠키다 (SPEC §17.4). 브라우저 JS가 읽을 수
 *   없으니 WebSocket URL에 실을 수 없고, 쿠키는 다른 오리진(워커)으로 자동 전송되지도 않는다.
 *   그래서 같은 오리진의 `/api/world/ticket`이 쿠키를 확인한 뒤 **60초짜리 서명 티켓**을
 *   내주고, 그걸 워커에 낸다.
 *
 * 왜 워커가 Next에 되묻지 않는가:
 *   서명 검증은 네트워크 왕복 0회다. 입장할 때마다 Next를 부르면 그 경로가 죽는 순간
 *   아무도 방에 못 들어온다. 봇 명단처럼 **서명에 담을 수 없는 것만** 되묻는다
 *   (app/api/internal/world-room).
 *
 * WebCrypto만 쓴다 — Node 런타임과 Cloudflare Workers 양쪽에 있다. Buffer는 없다.
 */

import { TICKET_TTL_SEC } from './constants';
import type { TicketPayload } from './protocol';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  // new Uint8Array(number)는 ArrayBufferLike라 crypto.subtle의 BufferSource에 맞지 않는다.
  // 버퍼를 명시해 Uint8Array<ArrayBuffer>로 좁힌다.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * `<base64url(payload)>.<base64url(hmac)>` 을 만든다.
 * exp를 넣지 않고 부르면 지금부터 TICKET_TTL_SEC 뒤로 잡는다.
 */
export async function signTicket(
  payload: Omit<TicketPayload, 'exp'> & { exp?: number },
  secret: string,
  nowSec: number,
): Promise<string> {
  const full: TicketPayload = { ...payload, exp: payload.exp ?? nowSec + TICKET_TTL_SEC };
  const body = toBase64Url(encoder.encode(JSON.stringify(full)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(sig))}`;
}

/**
 * 서명과 만료를 확인하고 알맹이를 돌려준다. 조금이라도 이상하면 null.
 * **어디가 틀렸는지 호출자에게 알려주지 않는다** — 티켓 위조를 도와줄 이유가 없다.
 */
export async function verifyTicket(
  token: string,
  secret: string,
  nowSec: number,
): Promise<TicketPayload | null> {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;

  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      fromBase64Url(sig),
      encoder.encode(body),
    );
  } catch {
    return null;
  }
  if (!ok) return null;

  try {
    const payload = JSON.parse(decoder.decode(fromBase64Url(body))) as TicketPayload;
    if (typeof payload.exp !== 'number' || payload.exp < nowSec) return null;
    if (typeof payload.rid !== 'string' || typeof payload.pid !== 'string') return null;
    if (typeof payload.seat !== 'number' || typeof payload.nick !== 'string') return null;
    if (typeof payload.mask !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * 길이·내용이 새지 않는 문자열 비교. 내부 API의 공유 비밀을 검사할 때 쓴다.
 * `a === b`는 첫 글자가 다르면 즉시 빠져서 이론상 시간차가 생긴다.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
