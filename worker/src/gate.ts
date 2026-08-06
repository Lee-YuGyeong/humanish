/**
 * 집결 게이트 — **방 사람이 전부 월드에 들어왔는가**. 소유: A
 *
 * 대기방에서 방장이 시작하면 전원이 /world 로 이동하는데 로딩 속도가 제각각이다.
 * 예전에는 **제일 먼저 도착한 사람의 인트로가 끝나는 순간** 판이 열렸고
 * (`intro_done` 첫 신호), 늦게 뜬 사람은 자기 영상 위에 주제가 겹친 채 들어왔다.
 * 그래서 "언제 시작하는가"를 클라이언트 시계에서 떼어 워커가 소유한다 (I2).
 *
 * 이 파일은 **순수 함수만** 둔다 — DB·소켓·Date.now() 를 모른다. 판정 규칙이
 * 여기 모여 있어야 tests/worker/gate.test.ts 가 브라우저 없이 확인할 수 있다.
 * (lib/game/ 의 I3 와 같은 이유이고, roundtable.ts·bots.ts 가 이미 같은 모양이다.)
 *
 * ┌─ ★ I1 — 밖으로 나가는 건 숫자 둘뿐이다 ───────────────────────────────────┐
 * │ 좌석 단위 도착 표시를 만들지 마라. 봇 좌석에는 소켓이 없어서 영영 도착하지  │
 * │ 않으므로 "도착 이벤트가 난 자리 = 사람"이 그대로 성립하고, 한 판에 전 좌석이 │
 * │ 갈린다. 여기서 좌석 id 를 다루는 건 **워커 안에서만**이고, 밖으로는          │
 * │ gateCounts 의 숫자 둘만 나간다 (lib/mp/protocol.ts 의 t:'gate').            │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

export interface GateState {
  /**
   * 지금까지 **한 번이라도** 월드에 접속한 사람 좌석. 한 번 들어오면 빠지지 않는다.
   *
   * "지금 붙어 있는 소켓"으로 세지 않는 이유가 여기 있다 — 새로고침은 "끊김 →
   * 붙음"이라 그렇게 세면 present 가 3→2→3 으로 깜빡이고, 그 깜빡임이 그대로
   * "누가 재접속했다"는 신호다 (I1). 도착 집합은 단조 증가라 아예 깜빡이지 않는다.
   */
  arrived: string[];
  /** 게이트가 열린 서버 시각. 열리기 전엔 null */
  openedAt: number | null;
}

/**
 * 도착 명단을 갱신하고 열지 말지 정한다. **한 번 열린 게이트는 다시 닫지 않는다.**
 *
 * ┌─ ★ 왜 닫지 않는가 (I1) ───────────────────────────────────────────────────┐
 * │ 열린 뒤에 누가 나갔다고 카운트다운을 되돌리면, 그 리셋 자체가 **"지금 누가   │
 * │ 새로고침했다"는 관측 신호**가 된다. 봇은 영영 그 신호를 만들지 않으므로 방   │
 * │ 전체가 사람 명단을 실시간으로 읽는다. `player_left` 를 안 내는 것과 같은     │
 * │ 이유다 (room-do.ts 의 handleLeave).                                        │
 * │ 덤으로 입장 ⑥(중복 소켓 정리)이 새로고침마다 리셋을 걸어 판이 안 열린다.     │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * @param prev        지난 상태. 처음이면 null
 * @param humanSeatIds 사람 좌석 전부 (봇 제외). 게이트의 분모다
 * @param connectedIds 지금 소켓이 붙어 있는 좌석. 사람 아닌 id 가 섞여도 걸러진다
 * @param startedAt   방장이 시작을 누른 서버 시각 — **상한의 기준점**이다
 * @param deadlineMs  이만큼 지나면 다 안 모여도 연다 (GATHER_DEADLINE_MS)
 * @param now         서버 시각
 */
export function stepGate(
  prev: GateState | null,
  humanSeatIds: readonly string[],
  connectedIds: readonly string[],
  startedAt: number,
  deadlineMs: number,
  now: number,
): GateState {
  // 이미 열렸으면 도착 명단만 따라가고 openedAt 은 그대로 둔다 (위 상자).
  const humans = new Set(humanSeatIds);
  const arrived = new Set((prev?.arrived ?? []).filter((id) => humans.has(id)));
  for (const id of connectedIds) {
    if (humans.has(id)) arrived.add(id);
  }

  if (prev?.openedAt != null) return { arrived: [...arrived], openedAt: prev.openedAt };

  const filled = arrived.size >= humans.size;
  /*
   * 상한의 기준점은 **방장이 시작을 누른 시각**이다 (rooms.world_started_at).
   * 첫 접속 시각으로 잡으면 아무도 안 들어온 방이 영영 상한에 안 걸린다.
   * 없으면 대기방에서 시작한 뒤 브라우저를 닫은 사람 한 명에 방이 영구 정지한다.
   */
  const timedOut = now - startedAt >= deadlineMs;

  return { arrived: [...arrived], openedAt: filled || timedOut ? now : null };
}

/**
 * 밖으로 내보낼 숫자 둘. **좌석과 묶이는 값은 여기서 만들지 않는다** (I1).
 *
 * total 이 안전한 근거는 "사람 좌석 수 = 자리 수 − AI 수"가 이미 공개값이라는
 * 것이다 (SPEC §15-3). present 는 그 부분집합의 크기라 새로 알려주는 게 없다.
 */
export function gateCounts(
  state: GateState | null,
  humanSeatIds: readonly string[],
): { present: number; total: number } {
  const humans = new Set(humanSeatIds);
  const arrived = (state?.arrived ?? []).filter((id) => humans.has(id));
  return { present: arrived.length, total: humans.size };
}

/**
 * 인트로가 끝나고 **판이 열릴 수 있게 되는 서버 시각**. 아직 대기 중이면 null.
 * 방 전원이 같은 값을 받으므로 카운트다운의 0초가 같은 순간이다 — 예전엔 각자의
 * 마운트 시각 기준이라 사람마다 달랐다 (app/world/warehouse.tsx 의 ScreenVideo).
 */
export function gateStartsAt(state: GateState | null, introMs: number): number | null {
  const openedAt = state?.openedAt ?? null;
  return openedAt === null ? null : openedAt + introMs;
}
