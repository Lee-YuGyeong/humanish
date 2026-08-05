/**
 * 방 제목 정화 (lib/server/room.ts의 normalizeRoomName).
 *
 * 방 제목은 **남이 만든 문자열이 내 화면의 목록에 섞여 들어오는 유일한 통로**다.
 * 그래서 "길이를 재는가"보다 **보이지 않는 글자를 터는가**를 더 촘촘히 본다.
 *
 * DB는 여기서 흉내 내지 않는다. rooms.name 체크 제약은 supabase/test.sh 가
 * 진짜 Postgres에 물어본다 (CLAUDE.md).
 */
import { describe, expect, it } from 'vitest';

import { MAX_ROOM_NAME_LEN, codeFromName, normalizeRoomName } from '@/lib/server/room';

describe('빈 값은 전부 null 하나로 접힌다', () => {
  // ★ 이게 이 함수의 존재 이유 절반이다. null 과 '' 이 둘 다 존재하면
  //   "이름이 있는데 화면에 안 보이는" 방이 생긴다 (lib/game/types.ts의 Room.name).
  it.each([
    ['생략', undefined],
    ['null', null],
    ['빈 문자열', ''],
    ['공백만', '   '],
    ['탭·줄바꿈만', '\t\n\r'],
    ['전각 공백만', '　　'],
    ['제로폭 공백만', '​​'],
    ['숫자 (문자열이 아니다)', 42],
    ['객체 (문자열이 아니다)', { name: '방' }],
  ])('%s → null', (_label, input) => {
    expect(normalizeRoomName(input)).toBeNull();
  });

  it('빈 문자열을 돌려주는 경우는 없다', () => {
    for (const input of ['', ' ', '​', '　']) {
      expect(normalizeRoomName(input)).not.toBe('');
    }
  });
});

describe('보이지 않는 글자를 턴다', () => {
  it('★ 우->좌 오버라이드(U+202E)를 지운다 — 제목이 거꾸로 렌더되는 걸 막는다', () => {
    // 이게 남으면 "gnp.txt" 같은 제목으로 남을 사칭하는 방을 만들 수 있다.
    expect(normalizeRoomName('초보‮환영')).toBe('초보환영');
  });

  it('★ 제로폭 공백을 지운다 — 눈으로 똑같은 제목을 여러 개 만드는 걸 막는다', () => {
    expect(normalizeRoomName('초보​방')).toBe('초보방');
    // 정화 뒤 같은 문자열이 되어야 "같은 이름"으로 보이는 두 방이 실제로 같아진다
    expect(normalizeRoomName('초보​방')).toBe(normalizeRoomName('초보방'));
  });

  it('줄바꿈·탭을 지운다 — 목록의 줄 높이가 방마다 달라지지 않게', () => {
    expect(normalizeRoomName('초보\n\n방')).toBe('초보 방');
    expect(normalizeRoomName('초보\t방')).toBe('초보 방');
  });

  it('연속 공백은 한 칸으로 접는다', () => {
    expect(normalizeRoomName('초보     방')).toBe('초보 방');
  });

  it('전각 공백도 보통 공백으로 접힌다', () => {
    // 이게 없으면 전각 공백만으로 "비어 보이는 제목"을 만들 수 있다
    expect(normalizeRoomName('초보　방')).toBe('초보 방');
  });

  it('앞뒤 공백을 턴다', () => {
    expect(normalizeRoomName('  초보방  ')).toBe('초보방');
  });
});

describe('한글은 합쳐진 모양(NFC)으로 접힌다', () => {
  // ★ 이게 없으면 **붙여넣기로 만든 방만** 두 군데서 조용히 어긋난다.
  //   길이는 3배로 세어지고, 목록의 제목 검색은 눈에 같은 글자를 못 찾는다.
  it('자모가 풀린 제목을 합친다', () => {
    expect(normalizeRoomName('초보 환영'.normalize('NFD'))).toBe('초보 환영');
  });

  it('풀린 것과 합쳐진 것이 같은 결과가 된다', () => {
    expect(normalizeRoomName('초보 환영'.normalize('NFD'))).toBe(normalizeRoomName('초보 환영'));
  });

  it('★ 길이는 합친 뒤에 잰다 — 아니면 열두 글자가 20자 상한에 걸린다', () => {
    // 눈으로 12자다. NFD 로는 26이라, 합치지 않으면 상한에 한참 못 미치는 제목이 거절당한다.
    const pasted = '초보만 들어오세요 환영'.normalize('NFD');
    expect(pasted.length).toBeGreaterThan(MAX_ROOM_NAME_LEN);
    expect(normalizeRoomName(pasted)).toBe('초보만 들어오세요 환영');
  });

  it('합친 뒤로도 상한을 넘으면 여전히 거절한다', () => {
    expect(() => normalizeRoomName('가'.repeat(MAX_ROOM_NAME_LEN + 1).normalize('NFD'))).toThrow(
      `방 제목은 ${MAX_ROOM_NAME_LEN}자까지다`,
    );
  });
});

describe('멀쩡한 제목은 그대로 지나간다', () => {
  it.each([
    '초보 환영',
    '아무나 들어와',
    'AI 찾기 고수만',
    'room 1',
    '5명 채우면 시작!',
  ])('%s', (input) => {
    expect(normalizeRoomName(input)).toBe(input);
  });
});

describe('이름이 곧 코드다 (codeFromName)', () => {
  // ★ 입장 정규화(joinRoom 의 normalizeCode)·입력칸들과 **같은 모양**이어야 한다 —
  //   여기가 어긋나면 목록에는 보이는데 쳐서는 못 들어가는 방이 생긴다.
  it('공백을 전부 지우고 대문자로 접는다', () => {
    expect(codeFromName('초보 방')).toBe('초보방');
    expect(codeFromName('my room')).toBe('MYROOM');
  });

  it('한글 이름은 그대로 코드가 된다', () => {
    expect(codeFromName('한빛방')).toBe('한빛방');
  });

  it("'초보 방'과 '초보방'은 같은 코드다 — 눈으로 구분 안 되는 두 방을 막는다", () => {
    expect(codeFromName('초보 방')).toBe(codeFromName('초보방'));
  });
});

describe(`길이는 ${MAX_ROOM_NAME_LEN}자까지다`, () => {
  it('딱 상한이면 통과한다', () => {
    const exact = '가'.repeat(MAX_ROOM_NAME_LEN);
    expect(normalizeRoomName(exact)).toBe(exact);
  });

  it('한 자라도 넘으면 400을 던진다', () => {
    // 화면의 maxLength는 브라우저에서만 도는 방어다. 서버가 진짜 기준이다 (I9).
    expect(() => normalizeRoomName('가'.repeat(MAX_ROOM_NAME_LEN + 1))).toThrow(
      `방 제목은 ${MAX_ROOM_NAME_LEN}자까지다`,
    );
  });

  it('★ 길이는 다듬은 뒤에 잰다', () => {
    // 앞뒤 공백 때문에 거절당하면 사용자는 왜 안 되는지 알 수 없다.
    const padded = `   ${'가'.repeat(MAX_ROOM_NAME_LEN)}   `;
    expect(normalizeRoomName(padded)).toBe('가'.repeat(MAX_ROOM_NAME_LEN));
  });
});
