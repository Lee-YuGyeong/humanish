/**
 * 쿼리 키 팩토리 (lib/queries/keys.ts).
 *
 * ★ 여기서 지키는 건 오타 방지가 아니라 **방 스코프(I10)** 다.
 *   방에 속한 키가 전부 scope(roomId) 로 시작해야, 무효화 한 번이 그 방 것만
 *   정확히 지운다. 새 키를 더할 때 접두사를 빠뜨리면 이 검사가 걸린다.
 */

import { describe, expect, it } from 'vitest';

import {
  authUserKey,
  openRoomsKey,
  profileKey,
  profileStatsKey,
  roomKeys,
  serverTimeKey,
} from '@/lib/queries/keys';

const ROOM_A = '11111111-1111-4111-8111-111111111111';
const ROOM_B = '22222222-2222-4222-8222-222222222222';

/** 방 스코프를 타야 하는 키 전부. 새로 추가하면 여기에도 넣는다. */
const SCOPED = [
  ['roster', roomKeys.roster],
  ['me', roomKeys.me],
  ['questions', roomKeys.questions],
  ['answers', roomKeys.answers],
  ['votes', roomKeys.votes],
  ['messages', roomKeys.messages],
  ['reveal', roomKeys.reveal],
] as const;

describe('방 스코프 (I10)', () => {
  it.each(SCOPED)('%s 키는 scope(roomId) 로 시작한다', (_name, make) => {
    const scope = roomKeys.scope(ROOM_A);
    const key = make(ROOM_A);
    expect(key.slice(0, scope.length)).toEqual([...scope]);
  });

  it.each(SCOPED)('%s 키는 방이 다르면 접두사도 다르다', (_name, make) => {
    // 접두사가 겹치면 A 방을 무효화할 때 B 방까지 다시 읽는다
    expect(make(ROOM_A)).not.toEqual(make(ROOM_B));
    const prefixA = roomKeys.scope(ROOM_A);
    expect(make(ROOM_B).slice(0, prefixA.length)).not.toEqual([...prefixA]);
  });

  it('같은 방의 서로 다른 키는 겹치지 않는다', () => {
    const keys = SCOPED.map(([, make]) => JSON.stringify(make(ROOM_A)));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('byCode', () => {
  it('코드는 대문자로 정규화한다 — 소문자로 들어와도 같은 캐시를 쓴다', () => {
    expect(roomKeys.byCode('abcd')).toEqual(roomKeys.byCode('ABCD'));
  });

  it('★ scope 접두사에 걸리지 않는다', () => {
    // 아직 roomId 를 모르는 유일한 키다. 그래서 useInvalidateRoom 이 이것만
    // 따로 챙긴다 — 이 성질이 깨지면 무효화가 방 행을 놓친다.
    const scope = roomKeys.scope(ROOM_A);
    expect(roomKeys.byCode('ABCD').slice(0, scope.length)).not.toEqual([...scope]);
  });
});

describe('방 밖의 키', () => {
  it('서버 시각과 방 목록은 방에 속하지 않는다', () => {
    const scope = roomKeys.scope(ROOM_A);
    expect(serverTimeKey.slice(0, scope.length)).not.toEqual([...scope]);
    expect(openRoomsKey.slice(0, scope.length)).not.toEqual([...scope]);
  });

  it('★ 계정과 전적도 방 밖이다 (SPEC §15-2-결정)', () => {
    // 계정 세계와 방 세계는 분리한다. 방 스코프 안에 두면 "이 방의 그 계정" 같은
    // 조회가 자연스러워 보이기 시작하고, 그게 I1 이 무너지는 첫걸음이다.
    const scope = roomKeys.scope(ROOM_A);
    expect(authUserKey.slice(0, scope.length)).not.toEqual([...scope]);
    expect(profileKey.slice(0, scope.length)).not.toEqual([...scope]);
    expect(profileStatsKey.slice(0, scope.length)).not.toEqual([...scope]);
  });

  it('★ 전적은 프로필의 하위가 아니다', () => {
    // 하위로 두면 이름을 짓는 순간 invalidate(profileKey) 가 전적까지 지운다.
    // 둘은 같이 바뀌지 않는다 — 이름은 한 번뿐이고 전적은 판마다 늘어난다.
    expect(profileStatsKey.slice(0, profileKey.length)).not.toEqual([...profileKey]);
  });
});
