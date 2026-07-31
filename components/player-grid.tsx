/**
 * 참가자 좌석 그리드. 소유: C (SPEC §2, §17.6)
 *
 * ★ 누가 봇인지 표시할 방법이 없다. 그게 정상이다 — 클라이언트는 public_players만
 *   읽고 거기에는 is_bot이 없다 (I1). 빈 자리도 봇이 채운 자리와 구분되지 않는다.
 *
 * ★ 칸 수는 방마다 다르다 (정원 3~8, SPEC §17.6). 여기서 5로 하드코딩하면 정원 8인
 *   방의 뒷자리 세 명이 화면에서 사라진다. 정원은 항상 room.capacity에서 받는다.
 *
 * 자리는 창고 바닥에 늘어놓은 플라이트 케이스로 그린다. 그리드에 원근을 살짝 걸어
 * 바닥에 놓인 물건처럼 보이게 했다 — 각도는 6도다. 그 이상 눕히면 글자가 읽기 나빠진다.
 */
import type { PublicPlayer } from '@/lib/game/types';

/**
 * 정원 → 그리드 열 클래스.
 *
 * ★ Tailwind는 소스에 **문자열 그대로** 적힌 클래스만 CSS로 만든다.
 *   `grid-cols-${n}`처럼 조립한 이름은 스캐너가 못 보고 지나가서 규칙이 아예 생성되지
 *   않고, 그리드가 한 열로 무너진다. 그래서 정적 표로 적어 둔다.
 *
 * 좁은 화면에서는 8칸이 뭉개지므로 열을 줄여 두 줄로 접는다. 접히는 순서는 seat 순서
 * 그대로라 자리 번호가 뒤섞이지 않는다.
 */
const GRID_COLS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-2 sm:grid-cols-4',
  5: 'grid-cols-3 sm:grid-cols-5',
  6: 'grid-cols-3 sm:grid-cols-6',
  7: 'grid-cols-4 sm:grid-cols-7',
  8: 'grid-cols-4 sm:grid-cols-8',
};

export function PlayerGrid({
  players,
  capacity,
  meId,
  selectable = false,
  selectedId = null,
  onSelect,
  lobby = false,
}: {
  players: PublicPlayer[];
  /** 그 방의 정원 (3~8). room.capacity를 그대로 넘긴다. */
  capacity: number;
  meId?: string | null;
  selectable?: boolean;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /**
   * 대기실인가 (SPEC §15-3-결정). 말풍선·준비 표시를 그릴지 정한다.
   *
   * ★ 뷰가 이미 phase='lobby' 일 때만 값을 주므로(policies.sql) 이 플래그가 없어도
   *   게임 중에는 아무것도 안 그려진다. 그래도 명시하는 이유는, 그 보호가 **뷰 쪽
   *   한 줄에만** 걸려 있기 때문이다. 대기실에는 사람만 있어서(봇은 시작할 때 앉는다)
   *   이 값이 게임까지 새면 값이 있는 자리 = 사람이 되어 봇이 전부 드러난다 (I1).
   */
  lobby?: boolean;
}) {
  const bySeat = new Map(players.map((p) => [p.seat, p]));

  // rooms를 select할 때 capacity 컬럼을 빠뜨리면 여기가 undefined로 들어온다.
  // 그때 0칸을 그리면 화면이 통째로 비어 원인을 못 찾으므로, 앉아 있는 사람 수만큼이라도
  // 그린다. 정상 경로에서는 항상 capacity가 이긴다.
  const seatCount =
    Number.isFinite(capacity) && capacity > 0 ? Math.trunc(capacity) : players.length;
  const cols = GRID_COLS[seatCount] ?? 'grid-cols-4';

  return (
    // 바닥에 놓인 것처럼 보이게 하는 원근. 자식 ul 이 이 소실점을 받는다.
    <div style={{ perspective: '900px', perspectiveOrigin: '50% 0%' }}>
      <ul
        className={`grid gap-1.5 ${cols}`}
        style={{ transform: 'rotateX(6deg)', transformStyle: 'preserve-3d' }}
      >
        {Array.from({ length: seatCount }, (_, i) => i + 1).map((seat) => {
          const p = bySeat.get(seat);
          const isMe = p != null && p.id === meId;
          const canPick = selectable && p != null && !isMe;
          const picked = p != null && p.id === selectedId;

          return (
            <li key={seat}>
              <button
                type="button"
                disabled={!canPick}
                onClick={() => p && onSelect?.(p.id)}
                aria-pressed={selectable ? picked : undefined}
                className={[
                  'relative flex w-full flex-col items-center gap-2 px-2 py-3.5 text-center',
                  // 앉은 자리는 바닥에 놓인 케이스, 빈 자리는 바닥에 파인 자국
                  p ? 'case' : 'cut',
                  picked
                    ? 'shadow-[inset_0_0_0_1px_rgba(255,51,32,0.7),0_0_28px_-8px_rgba(255,51,32,0.9)]'
                    : '',
                  canPick ? 'case-live cursor-pointer' : 'cursor-default',
                ].join(' ')}
              >
                {/*
                  대기실 말풍선. 사람마다 **지금 한 줄**만 있다 — 기록이 아니라서
                  쌓이지 않는다. 로그로 쌓으면 순서 자체가 메시지가 되어, 문구를
                  여덟 개로 좁혀둔 의미가 사라진다 (lib/server/lobby-lines.ts).

                  빈 줄이라도 자리를 잡아 두는 이유: 한 사람만 말했을 때 그 칸만
                  키가 커져서 그리드가 들썩인다.
                */}
                {lobby && (
                  <span
                    className={[
                      'flex h-5 w-full items-center justify-center px-1 text-[9px] leading-none',
                      p?.lobby_line ? 'cut text-bone' : '',
                    ].join(' ')}
                    title={p?.lobby_line ?? undefined}
                  >
                    <span className="truncate">{p?.lobby_line ?? ''}</span>
                  </span>
                )}

                {/* 케이스에 스텐실로 찍힌 자리 번호 */}
                <span
                  className={[
                    'readout flex h-8 w-8 items-center justify-center rounded-[2px] text-[13px]',
                    p
                      ? isMe
                        ? 'bg-tung/15 text-flare shadow-[inset_0_0_0_1px_rgba(0,255,102,0.45)]'
                        : 'bg-black/45 text-dust'
                      : 'text-ash',
                  ].join(' ')}
                  aria-hidden
                >
                  {p ? seat : '·'}
                </span>

                <span
                  className={[
                    'w-full truncate text-[11px] leading-tight',
                    p ? 'font-semibold text-bone' : 'text-ash',
                  ].join(' ')}
                >
                  {p ? p.nickname : '빈자리'}
                </span>

                {/* 자리마다 높이를 맞추려고 '나'가 아니어도 한 줄을 비워 둔다 */}
                <span className="stencil flex h-3 items-center gap-1.5 text-[8px] text-signal">
                  {isMe ? '나' : ' '}
                  {/*
                    준비 완료는 발화가 아니라 상태다. 말풍선으로 흘리지 않는다 —
                    켜고 끄는 순서가 그대로 신호가 되기 때문이다.
                    시작을 막지도 않는다. 방장이 참고하는 표시일 뿐이다.
                  */}
                  {lobby && p?.is_ready && <span className="text-tung">준비</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
