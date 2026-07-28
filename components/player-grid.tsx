/**
 * 참가자 좌석 그리드. 소유: C (SPEC §2, §17.6)
 *
 * ★ 누가 봇인지 표시할 방법이 없다. 그게 정상이다 — 클라이언트는 public_players만
 *   읽고 거기에는 is_bot이 없다 (I1). 빈 자리도 봇이 채운 자리와 구분되지 않는다.
 *
 * ★ 칸 수는 방마다 다르다 (정원 3~8, SPEC §17.6). 여기서 5로 하드코딩하면 정원 8인
 *   방의 뒷자리 세 명이 화면에서 사라진다. 정원은 항상 room.capacity에서 받는다.
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
}: {
  players: PublicPlayer[];
  /** 그 방의 정원 (3~8). room.capacity를 그대로 넘긴다. */
  capacity: number;
  meId?: string | null;
  selectable?: boolean;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
}) {
  const bySeat = new Map(players.map((p) => [p.seat, p]));

  // rooms를 select할 때 capacity 컬럼을 빠뜨리면 여기가 undefined로 들어온다.
  // 그때 0칸을 그리면 화면이 통째로 비어 원인을 못 찾으므로, 앉아 있는 사람 수만큼이라도
  // 그린다. 정상 경로에서는 항상 capacity가 이긴다.
  const seatCount =
    Number.isFinite(capacity) && capacity > 0 ? Math.trunc(capacity) : players.length;
  const cols = GRID_COLS[seatCount] ?? 'grid-cols-4';

  return (
    <ul className={`grid gap-2 ${cols}`}>
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
                'flex w-full flex-col items-center gap-1.5 rounded-2xl p-2.5 text-center transition',
                // 앉은 자리는 조명을 받은 물건처럼, 빈 자리는 어둠에 잠긴 의자처럼
                p ? 'panel' : 'border border-dashed border-bone/10 bg-black/25',
                picked ? 'border-blood ring-2 ring-blood/30' : '',
                canPick
                  ? 'cursor-pointer hover:-translate-y-0.5 hover:border-blood/50 hover:shadow-[0_0_28px_-10px_rgba(255,43,29,0.9)]'
                  : 'cursor-default',
              ].join(' ')}
            >
              <span
                className={[
                  'flex h-9 w-9 items-center justify-center rounded-full font-mono text-xs font-bold tabular-nums',
                  p
                    ? isMe
                      ? 'bg-blood text-white'
                      : 'bg-seam text-bone'
                    : 'border border-dashed border-bone/15 text-ash',
                ].join(' ')}
                aria-hidden
              >
                {p ? seat : '·'}
              </span>

              <span
                className={[
                  'w-full truncate text-[11px] leading-tight',
                  p ? 'font-bold text-bone' : 'text-ash',
                ].join(' ')}
              >
                {p ? p.nickname : '빈자리'}
              </span>

              {/* 자리마다 높이를 맞추려고 '나'가 아니어도 한 줄을 비워 둔다 */}
              <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-blood">
                {isMe ? '나' : ' '}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
