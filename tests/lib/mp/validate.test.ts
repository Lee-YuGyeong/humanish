/**
 * 수신 검증 · 티켓 · 스폰 — 서버가 클라이언트를 믿지 않는 경계. 소유: A
 */

import { describe, expect, it } from 'vitest';
import { JUMP_MAX_Y, WORLD } from '@/lib/mp/constants';
import { spawnFor } from '@/lib/mp/spawn';
import { signTicket, timingSafeEqual, verifyTicket } from '@/lib/mp/ticket';
import { isInsideWorld, isValidHeight, parseMove, seatColor } from '@/lib/mp/validate';

describe('parseMove', () => {
  const base = { t: 'move', x: 0, z: 0, y: 0, heading: 0, anim: 'walk' };

  it('정상 메시지를 통과시킨다', () => {
    expect(parseMove(base)).toEqual({ x: 0, z: 0, y: 0, heading: 0, anim: 'walk' });
  });

  it('점프 높이를 그대로 통과시킨다', () => {
    expect(parseMove({ ...base, y: JUMP_MAX_Y })).toMatchObject({ y: JUMP_MAX_Y });
  });

  it('y가 없으면 바닥으로 읽는다 (구 클라이언트)', () => {
    // y는 나중에 붙은 필드다. 없다고 끊으면 구 탭이 열려 있는 사람이 통째로 멈춘다
    const { y: _drop, ...noY } = base;
    expect(parseMove(noY)).toEqual({ x: 0, z: 0, y: 0, heading: 0, anim: 'walk' });
  });

  it('말이 안 되는 높이를 막는다', () => {
    // 천장 위를 떠다니는 아바타. 높이만 0으로 고쳐 통과시키면 원인을 못 찾는다
    expect(parseMove({ ...base, y: 50 })).toBeNull();
    expect(parseMove({ ...base, y: -5 })).toBeNull();
    expect(parseMove({ ...base, y: Number.NaN })).toBeNull();
    expect(parseMove({ ...base, y: '1' })).toBeNull();
  });

  it('NaN·Infinity를 막는다', () => {
    // 하나만 통과해도 그 사람을 보는 **모든** 클라이언트의 보간이 영구히 깨진다
    expect(parseMove({ ...base, x: Number.NaN })).toBeNull();
    expect(parseMove({ ...base, z: Number.POSITIVE_INFINITY })).toBeNull();
    expect(parseMove({ ...base, heading: Number.NaN })).toBeNull();
  });

  it('월드 밖을 막는다', () => {
    expect(parseMove({ ...base, x: 9999 })).toBeNull();
    expect(parseMove({ ...base, z: WORLD.minZ - 100 })).toBeNull();
  });

  it('모르는 애니메이션을 막는다', () => {
    expect(parseMove({ ...base, anim: 'fly' })).toBeNull();
    expect(parseMove({ ...base, anim: 123 })).toBeNull();
  });

  it('숫자가 아닌 값을 막는다', () => {
    expect(parseMove({ ...base, x: '1' })).toBeNull();
    expect(parseMove(null)).toBeNull();
    expect(parseMove('move')).toBeNull();
  });
});

describe('isInsideWorld', () => {
  it('경계에서 살짝 벗어난 건 허용한다', () => {
    // 클라 충돌 처리가 경계에서 조금 튀는 걸 매번 거절하면 그 사람만 화면이 멈춘다
    expect(isInsideWorld(WORLD.maxX + 1, 0)).toBe(true);
    expect(isInsideWorld(WORLD.maxX + 10, 0)).toBe(false);
  });
});

describe('isValidHeight', () => {
  it('바닥 · 점프 최고점 · 가장 높은 발판까지는 허용한다', () => {
    expect(isValidHeight(0)).toBe(true);
    expect(isValidHeight(JUMP_MAX_Y)).toBe(true);
    // 장비 케이스(1.3) 위에서 뛴 높이. 여기까지가 정상이다
    expect(isValidHeight(1.3 + JUMP_MAX_Y)).toBe(true);
  });

  it('점프로 닿을 수 없는 높이를 막는다', () => {
    expect(isValidHeight(WORLD.maxY + 0.01)).toBe(false);
    expect(isValidHeight(-1)).toBe(false);
  });
});

describe('signTicket / verifyTicket', () => {
  const secret = 'test-secret-0123456789';
  const payload = { rid: 'room-1', pid: 'player-1', seat: 3, nick: '익명3', mask: 'mask-03' };

  it('서명한 티켓을 되읽는다', async () => {
    const token = await signTicket(payload, secret, 1_000);
    const got = await verifyTicket(token, secret, 1_000);
    expect(got).toMatchObject(payload);
  });

  it('다른 비밀로는 열리지 않는다', async () => {
    const token = await signTicket(payload, secret, 1_000);
    expect(await verifyTicket(token, 'other-secret', 1_000)).toBeNull();
  });

  it('알맹이를 고치면 열리지 않는다', async () => {
    // 좌석을 바꿔치기해 남의 자리로 들어오는 경로를 막는다
    const token = await signTicket(payload, secret, 1_000);
    const [body, sig] = token.split('.');

    // 서명은 그대로 두고 알맹이만 바꾼다. 닉네임에 한글이 있으므로 btoa가 아니라
    // UTF-8 바이트를 거쳐 인코딩한다 (signTicket과 같은 방식).
    const bytes = new TextEncoder().encode(JSON.stringify({ ...payload, seat: 1, exp: 1_060 }));
    const forged = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    expect(forged).not.toBe(body);
    expect(await verifyTicket(`${forged}.${sig}`, secret, 1_000)).toBeNull();
  });

  it('만료되면 열리지 않는다', async () => {
    const token = await signTicket(payload, secret, 1_000);
    expect(await verifyTicket(token, secret, 1_000 + 61)).toBeNull();
  });

  it('쓰레기 문자열에 죽지 않는다', async () => {
    for (const junk of ['', '.', 'a.b', 'a', '....']) {
      expect(await verifyTicket(junk, secret, 1_000)).toBeNull();
    }
  });
});

describe('timingSafeEqual', () => {
  it('같으면 true, 다르면 false', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('spawnFor', () => {
  it('좌석마다 다른 자리를 준다', () => {
    const seen = new Set<string>();
    for (let seat = 1; seat <= 8; seat++) {
      const p = spawnFor(seat, 8);
      seen.add(`${p.x.toFixed(3)},${p.z.toFixed(3)}`);
    }
    expect(seen.size).toBe(8);
  });

  it('전부 월드 안이다', () => {
    // 여기가 밖이면 서버가 자기 스폰을 거절하는 우스운 상태가 된다
    for (let capacity = 3; capacity <= 8; capacity++) {
      for (let seat = 1; seat <= capacity; seat++) {
        const p = spawnFor(seat, capacity);
        expect(p.x).toBeGreaterThan(WORLD.minX);
        expect(p.x).toBeLessThan(WORLD.maxX);
        expect(p.z).toBeGreaterThan(WORLD.minZ);
        expect(p.z).toBeLessThan(WORLD.maxZ);
      }
    }
  });
});

describe('seatColor', () => {
  it('좌석 번호에서만 나온다 — 사람/봇을 보지 않는다', () => {
    expect(seatColor(1)).toBe(seatColor(9));
    expect(seatColor(1)).not.toBe(seatColor(2));
  });
});
