/**
 * 계정 이름 정화 (app/api/profile 의 normalizeDisplayName). SPEC §15-2-결정.
 *
 * 방 제목(room-name.test.ts)과 규칙은 같지만 **걸린 것이 다르다.**
 * 이름에는 lower(display_name) 유니크 인덱스가 붙어 있어서, 보이지 않는 글자
 * 하나로 눈에 같아 보이는 이름을 하나 더 만들 수 있다. 대기방에 '철수'가 둘이면
 * 누가 누구인지 못 가린다 — 여기서 터는 것이 그 유니크를 실제로 의미 있게 만든다.
 *
 * DB는 흉내 내지 않는다. 유니크 인덱스 자체는 supabase/test.sh 가 진짜 Postgres에
 * 물어본다 ("같은 이름은 못 쓴다" · "대소문자만 달라도 같은 이름이다").
 */
import { describe, expect, it } from 'vitest';

import { MAX_NAME_LEN, normalizeDisplayName } from '@/app/api/profile/route';

describe('이름이 아닌 것은 거절한다', () => {
  it.each([
    ['생략', undefined],
    ['null', null],
    ['숫자', 42],
    ['객체', {}],
  ])('%s', (_, input) => {
    expect(() => normalizeDisplayName(input)).toThrow();
  });

  // ★ 방 제목은 빈 값을 null 로 접지만 이름은 반드시 있어야 한다.
  //   profiles.display_name 이 not null 이라, 접어서 넘기면 DB 가 23502 로 죽는다.
  it.each([
    ['빈 문자열', ''],
    ['공백만', '   '],
    ['탭·줄바꿈만', '\t\n\r'],
    ['전각 공백만', '　　'],
    ['제로폭 공백만', '​​'],
  ])('%s 는 거절한다', (_, input) => {
    expect(() => normalizeDisplayName(input)).toThrow();
  });
});

describe('눈에 같아 보이는 이름을 하나로 모은다', () => {
  // ★ 이게 이 함수의 존재 이유다. 아래가 전부 통과해야 유니크 인덱스가 뜻을 갖는다.
  it('앞뒤 공백을 턴다', () => {
    expect(normalizeDisplayName('  철수  ')).toBe('철수');
  });

  it('가운데 연속 공백을 한 칸으로 접는다', () => {
    expect(normalizeDisplayName('김  철수')).toBe('김 철수');
  });

  it('제로폭 공백을 지운다 — 이걸 놓치면 흉내가 가능해진다', () => {
    expect(normalizeDisplayName('철​수')).toBe('철수');
    expect(normalizeDisplayName('철수​')).toBe('철수');
  });

  it('전각 공백도 보통 공백으로 접힌다', () => {
    expect(normalizeDisplayName('김　철수')).toBe('김 철수');
  });

  it('자모가 풀린 한글을 합친다 (NFC)', () => {
    // 맥에서 복사하면 이렇게 온다. 합치지 않으면 눈에 같은 이름이 둘이 된다.
    const decomposed = '철수'.normalize('NFD');
    expect(decomposed).not.toBe('철수');
    expect(normalizeDisplayName(decomposed)).toBe('철수');
  });
});

describe('제어문자는 지우지 않고 공백으로 남긴다', () => {
  // ★ 지워버리면 '김\n철수' 가 '김철수' 라는 **원래 없던 이름**이 된다.
  //   서식문자(제로폭)와 다르게 다뤄야 하는 이유다 (normalizeRoomName 주석 참고).
  it('줄바꿈은 칸을 남긴다', () => {
    expect(normalizeDisplayName('김\n철수')).toBe('김 철수');
  });
});

describe('길이', () => {
  it(`${MAX_NAME_LEN}자는 통과한다`, () => {
    expect(normalizeDisplayName('가'.repeat(MAX_NAME_LEN))).toHaveLength(MAX_NAME_LEN);
  });

  it(`${MAX_NAME_LEN + 1}자는 거절한다`, () => {
    expect(() => normalizeDisplayName('가'.repeat(MAX_NAME_LEN + 1))).toThrow();
  });

  // ★ 길이는 **합친 뒤에** 재야 한다. 자모가 풀린 20자는 60자로 세어져서,
  //   붙여넣었을 뿐인데 "20자까지다"로 거절당한다.
  it('자모가 풀린 20자도 통과한다', () => {
    const decomposed = '가'.repeat(MAX_NAME_LEN).normalize('NFD');
    expect(decomposed.length).toBeGreaterThan(MAX_NAME_LEN);
    expect(normalizeDisplayName(decomposed)).toHaveLength(MAX_NAME_LEN);
  });
});
