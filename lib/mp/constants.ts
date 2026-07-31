/**
 * 멀티플레이 튜닝 상수 — 클라이언트(app/world)와 워커(worker/src)가 **같이 읽는다**.
 * 소유: A. 값을 고치면 양쪽이 동시에 바뀐다. 한쪽에만 상수를 복붙하지 않는다.
 *
 * 이 파일은 의존성이 없어야 한다. 워커(Cloudflare)에서도 그대로 번들되므로
 * next/react/three/DOM 타입을 끌어오면 빌드가 깨진다.
 */

/**
 * 프로토콜 버전. 입장 URL의 `v=`로 실려 가고 워커가 다르면 끊는다.
 *
 * **필드 추가·새 메시지 타입 추가로는 올리지 않는다** (양쪽 switch의 default가 무시하므로
 * 전방 호환이다). **기존 필드의 의미가 바뀔 때만** 올리고, 올렸으면 워커를 먼저 배포한다.
 * 반대로 하면 새 클라이언트가 구 워커에 version_mismatch로 막힌다.
 */
export const PROTOCOL_VERSION = 1;

/**
 * 월드 경계 (월드 단위 ≈ m). app/world/warehouse.tsx의 창고 치수와 같은 좌표계다
 * (거기 ROOM을 0.6 인셋한 값).
 * x는 좌우, z는 앞뒤(-가 스크린 쪽), y는 바닥에서의 높이.
 *
 * 서버가 이 범위로 검증하므로 씬을 넓히면 여기부터 고친다.
 */
export const WORLD = {
  minX: -10.4,
  maxX: 10.4,
  minZ: -13.4,
  maxZ: 5.4,
  /**
   * 발 높이 상한. 0이 바닥이고, 점프와 "가구 위에 올라섬"으로만 올라간다.
   * 가장 높은 발판(장비 케이스 1.3) + 점프(≈1.05)보다 넉넉히 위에 둔다 —
   * 여기까지가 정상이고, 넘어가면 버그이거나 위조다.
   */
  maxY: 4,
} as const;

/**
 * 서버 검증 여유. 클라이언트의 충돌 처리가 경계에서 0.1쯤 튀는 걸 매번 거절하면
 * 그 사람만 화면이 멈춘다. 넉넉히 두고 **범위 밖이면 거절**만 한다(보정하지 않는다 —
 * 서버가 좌표를 고치면 클라이언트와 어긋나 고무줄이 된다).
 */
export const POS_MARGIN = 2;

/** 이동 송신 주기. 10Hz. 걷기 2.6m/s 기준 샘플 간 0.26m라 보간으로 충분히 매끄럽다. */
export const MOVE_THROTTLE_MS = 100;

/**
 * 서버가 받아주는 이동 최소 간격. **선의를 믿지 않는 쪽의 상한이다.**
 *
 * 클라이언트는 MOVE_THROTTLE_MS(100ms)마다 보내지만, 그건 클라이언트 코드의 약속일
 * 뿐이다. 소켓 하나가 초당 수천 건을 밀어넣으면 DO가 그걸 **방 전원에게 N배로 증폭해**
 * 뿌린다 — 프레임이 떨어지고 워커 요금이 올라간다. 채팅에는 상한이 있었는데
 * 이동에는 없었다.
 *
 * 정상 클라이언트의 실제 간격은 프레임 경계 때문에 100~116ms다. 절반(50ms)으로 잡아
 * 두 배 여유를 둔다 — 더 조이면 진짜 이동이 잘려 그 사람만 뚝뚝 끊긴다.
 */
export const MOVE_MIN_INTERVAL_MS = MOVE_THROTTLE_MS / 2;

/**
 * 수신 보간 지연. 송신 주기보다 한 칸 여유를 둬서 패킷이 늦어도 보간할 구간이 남는다.
 * 줄이면 튀고, 늘리면 남의 움직임이 늦게 보인다.
 */
export const INTERP_DELAY_MS = 150;

/** 플레이어당 좌표 링버퍼 길이. 150ms 지연 + 여유. 넘으면 앞에서 버린다. */
export const MOVE_BUFFER_MAX = 24;

/** 하트비트. 플랫폼 auto-response가 받아주므로 DO는 깨어나지 않는다. */
export const PING_INTERVAL_MS = 20_000;
/** ping 3회를 놓치면 죽은 소켓으로 본다. */
export const SOCKET_TIMEOUT_MS = 60_000;
/** 유령 소켓 청소 · 봇 시뮬레이션 복구 알람 주기. */
export const SWEEP_ALARM_MS = 30_000;

/** 채팅 한 줄 길이 상한. 서버가 자른다. */
export const CHAT_MAX_LEN = 200;
/** 같은 소켓의 채팅 최소 간격. 스팸 차단. */
export const CHAT_MIN_INTERVAL_MS = 600;

/**
 * 메시지 크기 상한을 **용도별로 나눈다.**
 * 하나로 두면 큰 페이로드가 조용히 드롭돼서 원인을 찾는 데 오래 걸린다.
 */
export const MAX_WS_MESSAGE_LEN = 64 * 1024;
export const MAX_GAME_MESSAGE_LEN = 512;

/** 방 정원 상한. rooms.capacity check(3~8) · players.seat check와 같은 값이다. */
export const ROOM_MAX_PLAYERS = 8;

/** 입장 티켓 수명. 발급 직후 바로 접속하므로 짧을수록 좋다. */
export const TICKET_TTL_SEC = 60;

/* ───────────────────────────── 봇 조종 (서버 전용) ───────────────────────────── */

/**
 * 봇 시뮬레이션 틱. **사람의 송신 주기와 같아야 한다.**
 *
 * ★ I1이 걸리는 자리다. 봇 좌표를 "A에서 B로 4초간 이동" 같은 계획으로 보내면
 *   devtools에서 사람(10Hz 샘플)과 봇(계획 1건)이 한눈에 갈린다. 그래서 봇도
 *   같은 `player_moved` 스트림에 같은 주기로, **변했을 때만** 실어 보낸다.
 */
export const BOT_TICK_MS = MOVE_THROTTLE_MS;

/** 봇 걷기 속도 범위 (m/s). 사람 기본 속도(WALK_SPEED)를 사이에 두고 흩뿌린다. */
export const BOT_SPEED_MIN = 1.7;
export const BOT_SPEED_MAX = 2.9;

/** 목적지에 닿은 뒤 서 있는 시간 (ms). */
export const BOT_IDLE_MIN_MS = 1_500;
export const BOT_IDLE_MAX_MS = 7_000;

/** 봇이 한마디 던지는 간격 (ms). 사람보다 잦으면 그 자체가 표식이 된다. */
export const BOT_CHAT_MIN_MS = 25_000;
export const BOT_CHAT_MAX_MS = 75_000;

/** 봇 좌표를 storage에 굽는 주기. DO가 evict돼도 순간이동하지 않게 한다. */
export const BOT_PERSIST_MS = 5_000;

/* ───────────────────────────── 클라이언트 이동 ───────────────────────────── */

export const WALK_SPEED = 2.6;
export const RUN_SPEED = 5.0;
/** 아바타 눈높이. 카메라가 **발 높이 + 이만큼**에 붙는다 (점프 중에는 같이 올라간다). */
export const EYE_HEIGHT = 1.62;

/**
 * 점프. 최고점 = JUMP_SPEED² / (2·GRAVITY) ≈ 1.05m, 체공 ≈ 0.75초.
 *
 * 이 값을 낮추면 **소파 윗면(0.99)에 못 올라간다** — 가구 위에 서는 게 점프의
 * 유일한 쓸모라 그 순간 점프는 그냥 화면 흔들기가 된다. 올리면 붕 뜬다.
 * 중력만 키우면(예: 20) 최고점이 낮아지니 둘을 같이 본다.
 */
export const JUMP_SPEED = 5.6;
export const GRAVITY = 15;
/** 바닥에서 뛰었을 때의 최고점. 서버 검증·문서가 같이 읽는다. */
export const JUMP_MAX_Y = (JUMP_SPEED * JUMP_SPEED) / (2 * GRAVITY);

/**
 * 봇이 한 번 뛰는 간격 (ms).
 *
 * ★ I1 — 봇에게 점프를 주지 않으면 "한 번도 안 뛴 아바타"가 곧 봇 후보 명단이 된다.
 *   사람은 30분에 한 번이라도 뛴다. 그래서 봇도 뛰되, 채팅과 같은 이유로
 *   사람보다 잦지 않게 잡는다 — 너무 자주 뛰면 그게 다시 표식이다.
 */
export const BOT_JUMP_MIN_MS = 20_000;
export const BOT_JUMP_MAX_MS = 90_000;
