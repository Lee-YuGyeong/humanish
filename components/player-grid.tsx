/**
 * 참가자 5칸. 소유: C (SPEC §2)
 *
 * ★ 누가 봇인지 표시할 방법이 없다. 그게 정상이다 — 클라이언트는 public_players만
 *   읽고 거기에는 is_bot이 없다 (I1). 빈 자리도 봇이 채운 자리와 구분되지 않는다.
 */
import type { PublicPlayer } from '@/lib/game/types';

const CAPACITY = 5;

export function PlayerGrid({
  players,
  meId,
  selectable = false,
  selectedId = null,
  onSelect,
}: {
  players: PublicPlayer[];
  meId?: string | null;
  selectable?: boolean;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
}) {
  const bySeat = new Map(players.map((p) => [p.seat, p]));

  return (
    <ul className="grid grid-cols-5 gap-2">
      {Array.from({ length: CAPACITY }, (_, i) => i + 1).map((seat) => {
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
              className={[
                'flex w-full flex-col items-center gap-1 rounded-lg border p-2 text-center transition',
                p ? '' : 'border-dashed opacity-40',
                picked ? 'border-black ring-2 ring-black dark:border-white dark:ring-white' : '',
                canPick ? 'cursor-pointer hover:border-gray-400' : 'cursor-default',
              ].join(' ')}
            >
              <span className="text-xl" aria-hidden>
                {p ? '🎭' : '·'}
              </span>
              <span className="truncate text-[11px] leading-tight">
                {p ? p.nickname : '빈자리'}
              </span>
              {isMe && <span className="text-[10px] text-gray-500">나</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
