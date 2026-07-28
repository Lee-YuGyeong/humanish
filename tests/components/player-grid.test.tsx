// @vitest-environment jsdom
/**
 * 좌석 그리드. (컴포넌트 소유는 C — 이 테스트는 읽기만 한다)
 *
 * 두 가지를 지킨다. 둘 다 CLAUDE.md가 반복해서 경고하는 함정이다.
 *
 *   §17.6  정원은 방마다 3~8이다. 5를 하드코딩하면 8인 방의 뒷자리 세 명이 사라진다
 *   I1     빈자리와 채워진 자리를 구분하는 것 말고는, 어느 자리가 봇인지 알 방법이 없어야 한다
 *
 * 화면이 "예쁜가"는 검사하지 않는다. 검사하는 건 **몇 칸이 그려지고 무엇이 새는가**다.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlayerGrid } from '@/components/player-grid';
import type { PublicPlayer } from '@/lib/game/types';

afterEach(cleanup);

/** seat 1..n 에 사람을 앉힌다. is_bot은 애초에 이 타입에 없다 (I1). */
function seatPlayers(n: number): PublicPlayer[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`,
    room_id: 'r',
    nickname: `익명${i + 1}`,
    mask_id: `mask-0${i + 1}`,
    seat: i + 1,
    connected: true,
  }));
}

const seats = () => screen.getAllByRole('listitem');

describe('정원만큼 칸을 그린다 (SPEC §17.6)', () => {
  it.each([3, 4, 5, 6, 7, 8])('정원 %i이면 그만큼 칸이 그려진다', (capacity) => {
    render(<PlayerGrid players={seatPlayers(2)} capacity={capacity} />);
    expect(seats()).toHaveLength(capacity);
  });

  it('정원 8인 방에서 뒷자리가 잘리지 않는다', () => {
    // 5를 하드코딩했을 때 정확히 여기가 깨진다.
    render(<PlayerGrid players={seatPlayers(8)} capacity={8} />);
    expect(screen.getByText('익명8')).toBeInTheDocument();
    expect(screen.queryByText('빈자리')).not.toBeInTheDocument();
  });

  it('사람보다 정원이 크면 나머지는 빈자리다', () => {
    render(<PlayerGrid players={seatPlayers(2)} capacity={6} />);
    expect(screen.getAllByText('빈자리')).toHaveLength(4);
  });
});

describe('capacity를 못 받았을 때 (rooms select에서 컬럼을 빠뜨린 경우)', () => {
  it('0칸이 되지 않고 앉은 사람 수만큼이라도 그린다', () => {
    // capacity를 빠뜨리면 undefined가 들어온다. 그때 0칸을 그리면 화면이 통째로
    // 비어서 원인을 못 찾는다. 사람이라도 보여야 "정원이 안 왔구나"를 알아챈다.
    render(
      <PlayerGrid
        players={seatPlayers(3)}
        capacity={undefined as unknown as number}
      />,
    );
    expect(seats()).toHaveLength(3);
  });

  it('NaN·0·음수도 같은 길로 빠진다', () => {
    for (const bad of [NaN, 0, -1]) {
      cleanup();
      render(<PlayerGrid players={seatPlayers(4)} capacity={bad} />);
      expect(seats()).toHaveLength(4);
    }
  });
});

describe('열 클래스는 소스에 문자열 그대로 있어야 한다', () => {
  it.each([
    [3, 'grid-cols-3'],
    [5, 'sm:grid-cols-5'],
    [8, 'sm:grid-cols-8'],
  ])('정원 %i → %s', (capacity, cls) => {
    // ★ Tailwind는 소스에 그대로 적힌 클래스만 CSS로 만든다. `grid-cols-${n}`처럼
    //   조립하면 스캐너가 못 보고 지나가 규칙이 아예 안 생기고, 그리드가 한 열로
    //   무너진다. 화면상으로는 "왜 세로로 쌓이지?"로만 보여서 원인을 찾기 어렵다.
    const { container } = render(
      <PlayerGrid players={seatPlayers(2)} capacity={capacity} />,
    );
    expect(container.querySelector('ul')?.className).toContain(cls);
  });
});

describe('I1 — 어느 자리가 봇인지 알 방법이 없다', () => {
  it('채워진 자리끼리는 표시가 똑같다', () => {
    // 실제 방에서는 이 중 일부가 봇이다. 그런데 클라이언트는 public_players만
    // 읽으므로 구분할 근거 자체가 없어야 한다. 자리마다 다른 표시가 붙기 시작하면
    // (예: '연결 중', 생성 시각 배지) 그게 곧 봇 판별기가 된다.
    render(<PlayerGrid players={seatPlayers(5)} capacity={5} />);
    const classes = seats().map((li) => li.querySelector('button')?.className);
    expect(new Set(classes).size).toBe(1);
  });

  it('렌더된 글자에 bot·AI 같은 낱말이 없다', () => {
    const { container } = render(
      <PlayerGrid players={seatPlayers(3)} capacity={5} meId="p1" />,
    );
    expect(container.textContent).not.toMatch(/bot|봇|AI|기계/i);
  });
});

describe('나 표시와 선택', () => {
  it("meId인 자리에만 '나'가 붙는다", () => {
    render(<PlayerGrid players={seatPlayers(4)} capacity={4} meId="p2" />);
    expect(screen.getAllByText('나')).toHaveLength(1);
  });

  it('meId가 없으면 아무 데도 안 붙는다', () => {
    render(<PlayerGrid players={seatPlayers(4)} capacity={4} />);
    expect(screen.queryByText('나')).not.toBeInTheDocument();
  });

  it('selectable이 아니면 아무도 못 고른다', () => {
    const onSelect = vi.fn();
    render(<PlayerGrid players={seatPlayers(3)} capacity={3} meId="p1" onSelect={onSelect} />);
    screen.getAllByRole('button').forEach((b) => expect(b).toBeDisabled());
  });

  it('투표에서 나 자신과 빈자리는 못 고른다', () => {
    // 자기 자신에게 투표하면 채점이 무너진다. 빈자리는 누를 대상이 없다.
    const onSelect = vi.fn();
    render(
      <PlayerGrid
        players={seatPlayers(2)}
        capacity={4}
        meId="p1"
        selectable
        onSelect={onSelect}
      />,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).toBeDisabled(); // 나
    expect(buttons[1]).toBeEnabled(); // 남
    expect(buttons[2]).toBeDisabled(); // 빈자리
    expect(buttons[3]).toBeDisabled();

    fireEvent.click(buttons[1]);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('p2');
  });

  it('고른 자리는 aria-pressed로 드러난다', () => {
    render(
      <PlayerGrid
        players={seatPlayers(3)}
        capacity={3}
        meId="p1"
        selectable
        selectedId="p3"
      />,
    );
    const picked = screen.getAllByRole('button').find((b) => b.getAttribute('aria-pressed') === 'true');
    expect(picked?.textContent).toContain('익명3');
  });
});

describe('자리 번호는 seat을 따른다', () => {
  it('중간이 비어도 번호가 밀리지 않는다', () => {
    // seat 2가 없는 상태. 배열 순서로 그리면 익명3이 2번 자리로 올라가서
    // 화면의 자리 번호와 실제 seat이 어긋난다.
    const players = seatPlayers(3).filter((p) => p.seat !== 2);
    render(<PlayerGrid players={players} capacity={3} />);
    const texts = seats().map((li) => li.textContent);
    expect(texts[0]).toContain('익명1');
    expect(texts[1]).toContain('빈자리');
    expect(texts[2]).toContain('익명3');
  });
});
