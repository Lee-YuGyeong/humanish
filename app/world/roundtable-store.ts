'use client';

/**
 * 라운드테이블 진행 상태 — **판이 지금 어디까지 왔는가**. 소유: 원상 (/world)
 *
 * 좌표·멤버십은 store.ts(useWorldStore)가 쥔다. 여기 있는 건 단계·주제·조명·투표처럼
 * **단계가 바뀔 때만 움직이는 값**이다. 그래서 리렌더가 나도 된다(좌표와 반대다).
 *
 * ┌─ 서버가 아는 값 / 내 로컬 선택 ─────────────────────────────────────────────┐
 * │ **서버 소유** phase · topic · endsAt · round · totalRounds · spotlightId ·   │
 * │              nomineeId · voted/total · eliminatedId · reveal               │
 * │   → 전부 워커가 보낸 걸 그대로 담는다. 여기서 만들어 내지 않는다.            │
 * │   ★ endsAt 은 **서버 시각**이다. 클라 카운트다운은 표시용일 뿐이고            │
 * │     단계 전환은 오직 서버가 판정한다 (I2). 카운트다운이 0이 됐다고 화면이     │
 * │     다음 단계로 넘어가면 안 된다 — 다음 round 메시지를 기다린다.             │
 * │                                                                            │
 * │ **내 로컬 선택** myVote · myVerdict                                        │
 * │   → 이건 서버가 되돌려 주지 않는다. 되돌려 줄 수가 없다:                     │
 * │     좌석 단위 투표 현황을 내보내는 순간 그게 I1 누출이다                     │
 * │     ("조기 종료가 걸렸는데 안 낸 자리 = 봇"). 그래서 **낙관적 표시가          │
 * │     선택이 아니라 유일한 방법**이고, 근거는 "빠르니까"가 아니라              │
 * │     "확인 경로를 만들면 게임이 깨져서"다.                                   │
 * │     대신 소켓에 실제로 나갔을 때만 확정한다 —                                │
 * │     WorldConnection.sendVote() 가 boolean 을 돌려주는 이유다.               │
 * │   → 진행 숫자(voted/total)는 절대 로컬로 세지 않는다. 내가 보냈다고 +1 하면   │
 * │     서버 집계와 어긋난다(서버는 표를 바꿔도 고유 좌석 수로 센다).            │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ★ spotlightId · nomineeId · eliminatedId 는 전부 players.id(사람·봇 공통)다.
 *   **봇 여부를 담지 않는다** (I1). 정체가 들어오는 곳은 reveal 하나뿐이고,
 *   그건 판이 끝난 뒤에만 채워진다.
 *
 * ★ 조명은 언제나 spotlightId **하나**만 본다. nomineeId 로 조명을 켜지 말 것 —
 *   두 값이 갈리면 defense 밖에서도 조명이 켜지고 그게 곧 신호가 된다 (protocol.ts).
 *
 * 로컬 setter(setSpotlight/setTopic)는 없앴다. 값의 주인이 서버로 확정된 이상
 * 같은 값을 만드는 두 번째 경로는 언젠가 서버와 어긋난다.
 */

import { create } from 'zustand';
import type { RoundPhase } from '@/lib/mp/protocol';
import type { GateInfo, RevealResult, RoundInfo } from './net/connection';

/**
 * 좌석 메모의 한 칸 — **내 짐작**이다 (2026-08-07 요청). 서버가 준 정체가 아니다.
 *
 * ★ 이름을 role 로 짓지 않는다. 이 값은 **아무 근거가 없다** — 내가 눌러서 만든
 *   낙서고, 소켓으로 나가지도 않고 아무도 못 본다. RoundRole 을 재사용하면
 *   언젠가 "이 자리 role" 로 읽혀서 진짜 정체가 들어오는 통로가 열린다 (I1).
 * ★ 없음('?')은 값이 아니라 **키가 없는 것**이다. 초기값을 따로 두면 좌석이
 *   바뀔 때마다 빈 칸을 채워 넣어야 한다.
 */
export type SeatGuess = 'human' | 'actor' | 'ai';

/** 눌렀을 때 도는 차례. null 이 '?' 다 (사용자 지정: ? → 사람 → 연기자 → AI → ?) */
const GUESS_CYCLE: (SeatGuess | null)[] = [null, 'human', 'actor', 'ai'];

interface RoundtableState {
  // ── 서버가 아는 값 ────────────────────────────────────────────────────────
  /**
   * 집결 게이트 — 방 사람이 전부 월드에 들어왔는가 (protocol.ts 의 t:'gate').
   *
   * ★ **null 은 "0명 도착"이 아니라 "게이트가 없는 방"이다.** 게이트가 걸리는 건
   *   대기방에서 방장이 시작한 방뿐이고, /world 로 직접 들어온 라운지에는 이
   *   메시지가 한 번도 오지 않는다 — 그때 스크린은 예전처럼 자기 시계로 센다.
   *   두 상태를 숫자 0으로 뭉뚱그리면 라운지가 영원한 대기 화면이 된다.
   */
  gate: GateInfo | null;
  /** 진행 단계. 서버 round 메시지가 정한다. 진행 전엔 'idle' */
  phase: RoundPhase;
  /** 중앙 스크린에 뜨는 주제 문구. null 이면 "대기 중" 상태 */
  topic: string | null;
  /** 현재 단계가 끝나는 **서버 시각**(epoch ms). 카운트다운 표시용이다 (I2) */
  endsAt: number;
  /** 몇 번째 주제 라운드인가 (1-based). 주제 라운드가 아닌 단계에선 0 */
  round: number;
  /** 주제 라운드 총 수. ①/② 진행 표시용 */
  totalRounds: number;
  /** 지금 조명받는 players.id. defense 에서만 채워지고 그 밖엔 null */
  spotlightId: string | null;
  /** 확정된 지목 대상. defense 부터 채워진다. 지목이 없으면 끝까지 null */
  nomineeId: string | null;
  /**
   * 생사 투표가 부결돼 **지목부터 다시 한 횟수** (0이면 첫 바퀴).
   * 화면이 vote 로 되돌아간 이유를 알리는 데만 쓴다 — 좌석과 무관한 수다 (I1).
   */
  revote: number;
  /** 표를 낸 **고유 좌석 수**. 서버가 묶어서 보낸다 — 로컬로 더하지 않는다 */
  voted: number;
  /** 전 좌석 수(사람+봇). 서버가 준 값 그대로다 */
  total: number;
  /** 처형된 players.id. 처형이 없으면 끝까지 null */
  eliminatedId: string | null;
  /** 결과 전문. reveal 이 오기 전에는 null 이어야 한다 — 정체가 여기 들어 있다 */
  reveal: RevealResult | null;

  // ── 내 로컬 선택 (서버가 되돌려 주지 않는다. 머리말 참고) ──────────────────
  /** 내가 고른 지목 대상. 보내기 전엔 null */
  myVote: string | null;
  /** 내 생사 재투표(찬=true). 안 냈으면 null */
  myVerdict: boolean | null;
  /**
   * 내 역할 (§18.2). t:'role' 이 내 것만 준다 — **남의 역할은 여기 절대 없다.**
   * 판이 열리기 전(idle)·역할이 아직 안 온 동안은 null.
   */
  myRole: 'citizen' | 'actor' | null;
  /**
   * 역할 카드의 「확인」을 눌렀는가 — 내 화면에만 있는 로컬 값이다. 누르기 전에는
   * 카드(RoleCard)가 떠 있고, 누르면 왼쪽 상단 머리말 밑의 역할 한 줄로 바뀐다
   * (page.tsx 헤더). myRole 이 걷히는 자리(새 판 topic · reset)에서 **반드시 같이**
   * false 로 돌린다 — 안 돌리면 다음 판의 카드가 아예 안 뜬다.
   */
  roleAck: boolean;
  /**
   * 좌석 메모 — players.id → 내 짐작 (2026-08-07 요청). 키가 없으면 '?' 다.
   *
   * ★ **완전히 로컬이다.** 소켓으로 나가지 않고, 남의 화면에도 없고, 서버는
   *   이런 게 있는지도 모른다. 그래서 이 값이 무엇이든 I1 과 무관하다 —
   *   거꾸로, 여기에 **서버가 준 값을 채워 넣지 마라.** 그 순간 "내가 찍은 것"과
   *   "서버가 아는 것"이 같은 그릇에 담겨서, 정체가 새는 자리가 된다.
   * ★ 새 판(rematch)에서 걷는다. 지난 판의 낙서가 남아 있으면 그게 지금 판의
   *   판단인 것처럼 보인다 — myRole 과 같은 자리에서 같이 비운다.
   */
  guesses: Record<string, SeatGuess>;

  // ── 액션 ──────────────────────────────────────────────────────────────────
  /**
   * 서버 round 메시지를 통째로 반영한다 (page.tsx 의 onRound).
   * ★ 단계가 **실제로 바뀐 경우에만** 내 선택과 진행 숫자를 비운다.
   *   같은 단계로 다시 오는 경우가 있어서다(판 중간 입장자에게 보내는 스냅샷) —
   *   그때 무조건 비우면 이미 낸 표가 화면에서 사라진다.
   */
  /** 집결 게이트 현황 반영 (page.tsx 의 onGate) */
  applyGate(gate: GateInfo): void;
  applyRound(round: RoundInfo): void;
  /** vote_progress 반영. 서버 숫자가 유일한 진실이다 */
  applyProgress(voted: number, total: number): void;
  /** 처형 확정. 아바타 연출은 useWorldStore 쪽에서 따로 받는다(매 프레임 읽어야 해서) */
  applyEliminated(id: string): void;
  /** 판 종료 + 정체 공개 */
  applyReveal(reveal: RevealResult): void;
  /**
   * 내 지목 선택을 확정한다. **소켓에 실제로 나갔을 때만** 부른다
   * (`if (conn.sendVote(id)) setMyVote(id)`). 안 나갔는데 표시하면
   * 서버엔 없는 표가 화면에만 남는다.
   */
  setMyVote(targetId: string | null): void;
  /** 내 생사 재투표 선택. 확정 조건은 setMyVote 와 같다 */
  setMyVerdict(guilty: boolean | null): void;
  /** 내 역할 반영 (page.tsx 의 onRole) */
  setMyRole(role: 'citizen' | 'actor'): void;
  /** 역할 카드의 「확인」 — 카드를 걷고 왼쪽 라벨로 넘어간다 */
  ackRole(): void;
  /** 좌석 메모를 한 칸 돌린다: ? → 사람 → 연기자 → AI → ? */
  cycleGuess(playerId: string): void;
  /** 방을 옮기거나 판이 끝나면 부른다. **지난 판의 정체가 새 방으로 새면 안 된다** */
  reset(): void;
}

/**
 * 초기값. **새 필드는 반드시 여기에도 넣는다** — reset() 이 이것만 뿌리므로,
 * 빠뜨리면 방을 옮겨도 지난 판 값(특히 reveal 의 정체)이 그대로 남는다.
 */
const IDLE = {
  gate: null as GateInfo | null,
  phase: 'idle' as RoundPhase,
  topic: null,
  endsAt: 0,
  round: 0,
  totalRounds: 0,
  spotlightId: null,
  nomineeId: null,
  revote: 0,
  voted: 0,
  total: 0,
  eliminatedId: null,
  reveal: null,
  myVote: null,
  myVerdict: null,
  myRole: null,
  roleAck: false,
  guesses: {} as Record<string, SeatGuess>,
};

export const useRoundtableStore = create<RoundtableState>((set) => ({
  ...IDLE,

  applyGate: (gate) => set({ gate }),

  applyRound: (round) =>
    set((s) => {
      const changed = s.phase !== round.phase;
      return {
        phase: round.phase,
        topic: round.topic,
        endsAt: round.endsAt,
        round: round.round,
        totalRounds: round.totalRounds,
        spotlightId: round.spotlightId,
        nomineeId: round.nomineeId,
        revote: round.revote,
        // 단계가 넘어갔으면 지난 단계의 선택·진행은 의미가 없다
        ...(changed ? { myVote: null, myVerdict: null, voted: 0, total: 0 } : null),
        // 한 판 더(rematch) — 새 판(topic)이 열리면 지난 판의 결과·처형 연출을 걷는다.
        // 여기 말고는 안 걷는다: ended 뒤에도 reveal 은 남아 있어야 한다(결과를 읽는 중).
        // myRole 도 같이 걷는다 — 새 역할(t:'role')은 round 브로드캐스트 **뒤에** 온다
        // (room-do 의 sendRoles 순서). 안 걷으면 새 역할이 오기 전 지난 역할이 보인다.
        // roleAck 도 같이 걷는다 — 새 판에서는 카드부터 다시 봐야 한다.
        ...(round.phase === 'topic' ? { reveal: null, eliminatedId: null } : null),
        /*
         * ┌─ ★★ "topic 이면 걷는다"가 아니다. **판이 끝난 뒤에 온 topic** 만이다 ────┐
         * │ 한 판에 topic 은 **두 번** 온다 (ROUND_TOPIC_ROUNDS = 2):               │
         * │   topic① → speak → topic② → speak → freechat → …                       │
         * │ 조건이 `s.phase !== 'idle'` 이었을 때 topic② 가 그대로 걸렸다. 그래서    │
         * │ 두 번째 주제가 뜨는 순간 머리말의 「내 역할 · 시민」 한 줄이 사라졌고,    │
         * │ 그 뒤로 영영 안 돌아왔다 — sendRoles 는 판이 **열릴 때 한 번**만 부르므로 │
         * │ 새 t:'role' 이 오지 않고, myRole 이 null 이라 카드도 못 뜬다.            │
         * │ (사용자 보고 2026-08-07: "말하는 주제 생기면 역할 라벨이 없어진다")      │
         * │                                                                        │
         * │ 위 주석이 처음부터 "걷는 건 ended·reveal 에서 오는 topic 뿐"이라고 적고  │
         * │ 있었다 — 코드만 그 뜻을 담지 못했다. 이제 그 문장을 그대로 조건에 쓴다.  │
         * │                                                                        │
         * │ ★ idle 에서 온 첫 topic 도 당연히 안 걷는다. 역할은 게이트가 열릴 때 먼저 │
         * │   왔고(카드 선공개, 2026-08-06), 여기서 걷으면 방금 확인한 카드가 판이   │
         * │   열리는 순간 한 번 더 뜬다.                                            │
         * │                                                                        │
         * │ ★ 반대로 여기를 **더 넓히지도** 마라. 판이 끝나기 전에 걷으면 위 증상이  │
         * │   그대로 돌아온다. 새 역할이 오는 시점은 sendRoles 하나뿐이다.           │
         * └──────────────────────────────────────────────────────────────────────┘
         */
        ...(round.phase === 'topic' && (s.phase === 'reveal' || s.phase === 'ended')
          ? { myRole: null, roleAck: false, guesses: {} }
          : null),
      };
    }),

  applyProgress: (voted, total) => set({ voted, total }),

  applyEliminated: (eliminatedId) => set({ eliminatedId }),

  applyReveal: (reveal) => set({ reveal }),

  setMyVote: (myVote) => set({ myVote }),

  setMyVerdict: (myVerdict) => set({ myVerdict }),

  setMyRole: (myRole) => set({ myRole }),

  ackRole: () => set({ roleAck: true }),

  /*
   * 한 칸 돌린다. **없음으로 돌아오면 키를 지운다** — undefined 를 넣어 두면
   * 나간 사람의 자리가 메모에 계속 남는다.
   */
  cycleGuess: (playerId) =>
    set((s) => {
      const next = GUESS_CYCLE[(GUESS_CYCLE.indexOf(s.guesses[playerId] ?? null) + 1) % GUESS_CYCLE.length];
      const guesses = { ...s.guesses };
      if (next === null) delete guesses[playerId];
      else guesses[playerId] = next;
      return { guesses };
    }),

  reset: () => set({ ...IDLE }),
}));

/**
 * 역할 카드가 지금 떠 있는가 — 역할은 받았는데 아직 「확인」 전이다.
 *
 * ★ 셀렉터를 여기 하나만 둔다. page.tsx(커서를 돌려줘야 한다)와 game-hud.tsx
 *   (카드를 그린다)가 **같은 조건**을 봐야 하기 때문이다 — 한쪽에 조건을 복붙하면
 *   커서 없이 카드만 뜨거나, 카드 없이 커서만 풀린 화면이 된다.
 * ★ idle 을 막지 않는다 — 역할은 게이트가 열릴 때(전원 집결, 카운트다운 시작)
 *   오고, 그때 단계는 아직 idle 이다. 카드가 뜨는 순간이 바로 거기다 (2026-08-06).
 * ★ reveal 뒤에는 안 띄운다 — 정체가 전부 공개된 마당에 내 역할 카드는 소음이다.
 */
export function roleCardOpen(s: RoundtableState): boolean {
  return s.myRole !== null && !s.roleAck && s.reveal === null && s.phase !== 'ended';
}
