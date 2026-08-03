'use client';

/**
 * 3D 월드 씬 — 여러 명이 같이 걸어다니는 공간. 소유: 원상 (/world)
 *
 * 배경(창고 시네마 라운지)은 ./warehouse.tsx 에 있다. 이 파일은 캔버스·카메라·이동·
 * 네트워크만 쥔다.
 *
 * 경계는 lib/mp/constants.ts 의 WORLD 하나뿐이고 서버가 같은 값으로 검증한다.
 * 씬을 넓히려면 거기부터 고친다.
 *
 * ★ 이 파일에는 "누가 봇인가"를 알 수 있는 코드가 한 줄도 없다 (I1).
 *   아바타는 전부 같은 경로로 그려지고, 색은 좌석 번호에서만 나온다.
 *   **처형 연출도 마찬가지다** — store 의 eliminatedId 는 players.id 일 뿐이라,
 *   사람이 처형되든 봇이 처형되든 쓰러지는 모습·속도·표식이 완전히 같다.
 */

import { Html, PointerLockControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Suspense, memo, useCallback, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import { Avatar } from './avatar';
import {
  Furniture,
  Lights,
  SCREEN_FOCUS,
  Warehouse,
  groundHeightAt,
  resolveColliders,
} from './warehouse';
import { PlayerSpotlight, RoundTable, StageMood, TopicProjection } from './roundtable';
import { useRoundtableStore } from './roundtable-store';
import {
  EYE_HEIGHT,
  GRAVITY,
  INTERP_DELAY_MS,
  JUMP_SPEED,
  MOVE_THROTTLE_MS,
  RUN_SPEED,
  WALK_SPEED,
  WORLD,
  mayMove,
} from '@/lib/mp/constants';
import { sampleAt, type Pose } from '@/lib/mp/interp';
import type { AnimState } from '@/lib/mp/protocol';
import { seatColor } from '@/lib/mp/validate';
import type { WorldConnection } from './net/connection';
import type { RemotePlayer } from './net/remote-players';
import { useWorldStore } from './store';

/**
 * 처음 올려다보는 각도의 상한(라디안). 지금 스폰 원(반지름 3.4)에서는 스크린까지
 * 7.9~12.9m 라 11~18°가 나오므로 걸리지 않는다. 스폰이나 스크린을 옮겨 바짝 붙었을 때
 * 하늘을 보며 시작하는 것만 막는 안전선이다.
 */
const MAX_START_PITCH = (25 * Math.PI) / 180;

/* ─────────────────────────────── 최상위 ─────────────────────────────── */

export default function WorldScene({
  conn,
  spawn,
  composing,
  onLockChange,
  onReady,
}: {
  conn: WorldConnection;
  /** 내 시작 위치. 서버가 좌석으로 정한 자리와 같게 맞춘다 */
  spawn: { x: number; z: number };
  /**
   * 한 마디 치는 중인가. **잠금은 걸린 채**라 시야는 계속 돌지만 다리는 멈춘다.
   * 잠금만 봐서는 이 상태를 구분할 수 없어서 따로 받는다 (page.tsx 머리말).
   */
  composing: boolean;
  onLockChange?: (locked: boolean) => void;
  /**
   * 캔버스가 DOM 에 붙었다. **이때부터** 포인터 잠금을 걸 수 있다 —
   * 이 파일은 dynamic import 라, 부모가 `live` 를 본 시점엔 아직 캔버스가 없다.
   */
  onReady?: () => void;
}) {
  return (
    <Canvas
      shadows={false}
      dpr={[1, 1.75]}
      camera={{ position: [spawn.x, EYE_HEIGHT, spawn.z], fov: 60, near: 0.1, far: 60 }}
      gl={{ antialias: true }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.1;
        onReady?.();
      }}
    >
      <color attach="background" args={['#080604']} />
      <fogExp2 attach="fog" args={['#0b0805', 0.028]} />

      <Lights flicker />
      {/*
        다만 여기에는 **남이 서 있다.** 배경화면 조명만으로는 스포트 밖의 사람이
        검은 덩어리가 되어 누가 있는지 안 보인다. 아바타를 알아볼 최소한만 얹는다.
      */}
      <ambientLight intensity={0.45} color="#ffd9a8" />
      <hemisphereLight args={['#8fb6ff', '#3a2a1c', 0.35]} />

      <Suspense fallback={null}>
        {/* 인트로 영상이 끝나면 워커에 알린다 → 라운드테이블 판이 시작된다 */}
        <Warehouse onIntroEnd={() => conn.sendIntroDone()} />
        <Furniture />
        {/* 좌석 원 한가운데의 라운드테이블 무대 (app/world/roundtable.tsx) */}
        <RoundTable />
        {/*
          주제·단계 문구는 **인트로 영상이 나오던 그 영사막**에 겹쳐 뜬다.
          Warehouse 뒤에 두어야 영상막 위에 그려진다 (roundtable.tsx 의 TopicProjection).
        */}
        <TopicProjection />
      </Suspense>

      {/* 지목된 한 사람만 비추는 스포트라이트. store 가 대상을 줄 때까지는 꺼져 있다 */}
      <PlayerSpotlight />
      {/* 단계마다 공간 색을 바꾸는 무대등 하나. 전 좌석이 같은 빛을 받는다 (연출뿐이다) */}
      <StageMood />

      <Remotes />
      <LocalRig conn={conn} spawn={spawn} composing={composing} />
      {/*
        ★ selector 는 **일부러 아무 것도 맞지 않는 값**이다.
          drei 는 selector 가 없으면 `document` 전체에 click→lock 을 건다. 그러면
          ESC 로 설정을 열어 놓고 볼륨 슬라이더나 채팅 판을 누르는 순간 다시 잠겨
          판이 사라진다 — 설정을 만질 수가 없다. 걷기/설정 전환은 **설정창이
          열려 있는가**로 정한다 (page.tsx: 입장하면 바로 잠그고, ESC 로 풀고,
          「게임으로」로 되잡는다).
          클릭으로 잠그는 길은 page.tsx 가 **캔버스를 target 으로 하는 클릭**에만
          따로 건다 — 자동 잠금이 거절됐을 때의 복구용이고, 판 위의 클릭은
          target 이 캔버스가 아니라 여기 걸리지 않는다. 이 selector 를 없애
          document 로 되돌리면 위의 문제가 그대로 돌아온다.
      */}
      <PointerLockControls
        selector="[data-world-click-to-lock]"
        onLock={() => onLockChange?.(true)}
        onUnlock={() => onLockChange?.(false)}
      />
    </Canvas>
  );
}

/* ─────────────────────────── 내 아바타 (송신) ─────────────────────────── */

const UP = new THREE.Vector3(0, 1, 0);

function LocalRig({
  conn,
  spawn,
  composing,
}: {
  conn: WorldConnection;
  spawn: { x: number; z: number };
  composing: boolean;
}) {
  const { camera } = useThree();
  /*
   * ★★ 내가 지금 움직일 수 있나 (I1 — lib/mp/constants.ts 의 mayMove).
   *
   *   포인터락만 봐서는 부족하다. page.tsx 가 잠금을 푸는 데는 수백 ms 가 걸리고
   *   (round 수신 → 리렌더 → exitPointerLock), 그 사이 걷던 사람은 좌표를 몇 개 더
   *   내보낸다. 봇은 서버 틱에서 **그 틱에** 얼어붙으므로 그 몇 패킷이 곧 사람 표식이다.
   *   그래서 잠금 상태가 아니라 **단계**로 한 번 더 막는다. 워커도 같은 함수로
   *   좌표를 거절하므로 방어선은 셋이다(여기 · 포인터락 · 서버).
   *
   *   ★ defense 에서는 **지목된 내가 아닐 때만** 걷는다. 조명을 받는 자리는 서고,
   *     나머지는 사람도 봇도 평소대로 움직인다 (mayMove 의 상자).
   *
   *   단계·지목은 판당 열 번 남짓 바뀔 뿐이라 구독해도 리렌더 비용이 없다 — 좌표와 다르다.
   */
  const phase = useRoundtableStore((s) => s.phase);
  const nomineeId = useRoundtableStore((s) => s.nomineeId);
  const selfId = useWorldStore((s) => s.selfId);
  const movementLocked = !mayMove(phase, nomineeId !== null && nomineeId === selfId);
  const keys = useRef<Record<string, boolean>>({});
  // ★ pos.y 는 **발 높이**다(눈높이가 아니다). 카메라만 EYE_HEIGHT를 더해 올린다 —
  //   네트워크로 나가는 값도, 가구 충돌이 보는 값도 발 높이라 여기서 갈리면 안 된다.
  const pos = useRef(new THREE.Vector3(spawn.x, 0, spawn.z));
  /** 수직 속도 (m/s). 발이 땅에 있으면 0 */
  const vy = useRef(0);
  const grounded = useRef(true);
  const forward = useRef(new THREE.Vector3());
  const right = useRef(new THREE.Vector3());
  // NaN으로 시작해 첫 프레임에 무조건 한 번 보내게 한다 (내 자리를 남에게 알린다)
  const lastSent = useRef({ at: 0, x: NaN, z: NaN, y: NaN, heading: NaN, anim: 'idle' as AnimState });

  useEffect(() => {
    camera.position.set(spawn.x, EYE_HEIGHT, spawn.z);

    /*
     * **스크린을 보고 시작한다.**
     *
     * 좌석 스폰은 원 위에 흩어져 있어서 기본 방향(-z)으로 두면 사람에 따라 벽만
     * 보인다. 예전엔 방 한가운데를 보게 했지만, 세계가 나타나는 그 순간 스크린에서는
     * 카운트다운이 20부터 흐르기 시작한다 (warehouse.tsx COUNTDOWN_SEC, page.tsx 의
     * live 마운트 주석). 가운데를 보면 그게 시야 밖이라, 정작 처음 20초 동안 벌어지는
     * 유일한 사건을 놓친다. 스폰 원은 스크린 앞쪽에 모여 있으므로 스크린을 보면
     * 다른 사람들도 대체로 같이 화면에 들어온다.
     *
     * 카메라의 로컬 정면은 -z다. yaw θ일 때 월드 정면은 (-sinθ, 0, -cosθ)이므로
     * 목표 방향 (dx, dz)를 보려면 θ = atan2(-dx, -dz)다.
     * 스크린 한가운데는 눈높이보다 위(4.2 vs 1.62)라 고개도 그만큼 든다 — YXZ 순서에서
     * rotation.x 가 양수면 위를 본다.
     * PointerLockControls는 이 회전을 이어받아 델타만 더하므로 먼저 잡아도 안전하다.
     */
    const dx = SCREEN_FOCUS.x - spawn.x;
    const dz = SCREEN_FOCUS.z - spawn.z;
    const pitch = Math.atan2(SCREEN_FOCUS.y - EYE_HEIGHT, Math.hypot(dx, dz));
    camera.rotation.order = 'YXZ';
    camera.rotation.set(Math.min(pitch, MAX_START_PITCH), Math.atan2(-dx, -dz), 0);
  }, [camera, spawn.x, spawn.z]);

  useEffect(() => {
    // 채팅창에 타이핑하는 동안은 조작키가 아니다. 이 가드가 없으면 "왜"를 치다가
    // 걸어다니고, Space를 칠 때마다 뛴다.
    const typing = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable === true;
    };

    const down = (e: KeyboardEvent) => {
      if (typing(e)) return;
      // Space는 브라우저가 스크롤·마지막 버튼 재클릭에 쓴다. 여기선 점프다
      if (e.code === 'Space') e.preventDefault();
      keys.current[e.code] = true;
    };
    const up = (e: KeyboardEvent) => {
      keys.current[e.code] = false;
    };
    // 탭을 벗어나면 눌린 키가 그대로 남아 혼자 계속 걷는다
    const blur = () => {
      keys.current = {};
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // 말하기로 들어가는 순간 눌린 키를 비운다. W 를 누른 채 Enter 를 치면 그 W 의
  // keyup 은 입력창이 가져가고, 여기 keys 에는 true 가 남아 혼자 계속 걸어간다.
  useEffect(() => {
    if (composing) keys.current = {};
  }, [composing]);

  useFrame((_, delta) => {
    const k = keys.current;
    // 조작을 받는 조건은 셋이다.
    //   1) 마우스가 잠겨 있다 — ESC 로 풀어 설정을 여는 동안에는 걷지 않는다.
    //   2) 말하는 중이 아니다 — 말하기는 **잠금을 유지한 채** 열리므로(page.tsx),
    //      잠금만 보면 타이핑하는 동안 몸이 걸어간다. 키 핸들러의 typing() 가드가
    //      이미 한 겹 막지만, 포커스가 어디로 튀든 안전하도록 여기서도 막는다.
    //   3) 이동이 잠긴 단계가 아니다 — 봇이 서버 틱에서 즉시 얼어붙는 그 순간에
    //      맞춰 사람도 멈춰야 한다 (위 movementLocked 의 상자, I1).
    const active = !composing && !movementLocked && document.pointerLockElement !== null;
    const ax = active ? (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0) : 0;
    const az = active ? (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0) : 0;
    const running = active && Boolean(k.ShiftLeft || k.ShiftRight);

    camera.getWorldDirection(forward.current);
    forward.current.y = 0;
    forward.current.normalize();
    right.current.crossVectors(forward.current, UP).normalize();

    let anim: AnimState = 'idle';
    if (ax !== 0 || az !== 0) {
      const speed = (running ? RUN_SPEED : WALK_SPEED) * Math.min(delta, 0.1);
      // 대각선이 빨라지지 않게 정규화한다
      const len = Math.hypot(ax, az);
      pos.current.addScaledVector(forward.current, (az / len) * speed);
      pos.current.addScaledVector(right.current, (ax / len) * speed);
      anim = running ? 'run' : 'walk';
    }

    // 점프. **땅에 있을 때만** 받는다 — 누른 채로 있어도 공중에서 다시 뛰지 않는다.
    if (active && (k.Space || k.KeyE) && grounded.current) {
      vy.current = JUMP_SPEED;
      grounded.current = false;
    }

    // 가구. 배경이 빈 상자가 아니라 라운지가 됐으므로 소파·랙을 뚫고 지나가지 않게 막는다.
    // 발이 윗면보다 높으면 막히지 않는다 — 그래서 뛰어넘고, 위에 올라선다.
    resolveColliders(pos.current, pos.current.y);

    // 벽. 서버는 범위 밖을 **거절**만 하므로(보정하지 않는다) 클라가 먼저 막는다
    pos.current.x = Math.min(Math.max(pos.current.x, WORLD.minX + 0.4), WORLD.maxX - 0.4);
    pos.current.z = Math.min(Math.max(pos.current.z, WORLD.minZ + 0.4), WORLD.maxZ - 0.4);

    // 수직. 지금 발밑이 무엇인지 먼저 묻고(바닥 0 또는 가구 윗면) 그 다음에 떨어뜨린다.
    const ground = groundHeightAt(pos.current.x, pos.current.z, pos.current.y);
    if (grounded.current && pos.current.y > ground + 0.02) {
      // 발판 밖으로 걸어 나갔다. 뛰지 않았으니 초기 속도는 0이다
      grounded.current = false;
    }
    if (grounded.current) {
      pos.current.y = ground;
    } else {
      vy.current -= GRAVITY * Math.min(delta, 0.1);
      pos.current.y += vy.current * Math.min(delta, 0.1);
      if (vy.current <= 0 && pos.current.y <= ground) {
        pos.current.y = ground;
        vy.current = 0;
        grounded.current = true;
      }
    }

    camera.position.set(pos.current.x, pos.current.y + EYE_HEIGHT, pos.current.z);

    // 아바타의 앞면은 로컬 +z다. 봇(stepBot)과 같은 규칙이어야 방향이 맞는다
    const heading = Math.atan2(forward.current.x, forward.current.z);

    const now = performance.now();
    const s = lastSent.current;
    const changed =
      s.anim !== anim ||
      Math.abs(s.x - pos.current.x) > 0.001 ||
      Math.abs(s.z - pos.current.z) > 0.001 ||
      Math.abs(s.y - pos.current.y) > 0.001 ||
      Math.abs(s.heading - heading) > 0.001 ||
      Number.isNaN(s.x);

    // ★ 이동이 잠긴 단계에서는 **한 패킷도 내보내지 않는다** (I1).
    //   active 를 끄는 것만으로는 부족하다 — 잠금이 아직 안 풀린 몇백 ms 동안
    //   마우스만 움직여도 heading 이 바뀌어 10Hz 로 나간다. 봇은 그 구간에
    //   단 한 패킷도 안 내므로 그 차이가 그대로 명단이다.
    if (movementLocked) return;

    // 가만히 서 있으면 패킷이 0이다. changed 검사를 빼면 8명 방에서 초당 80패킷을 낭비한다
    if (changed && now - s.at >= MOVE_THROTTLE_MS) {
      conn.sendMove(pos.current.x, pos.current.z, pos.current.y, heading, anim);
      s.at = now;
      s.x = pos.current.x;
      s.z = pos.current.z;
      s.y = pos.current.y;
      s.heading = heading;
      s.anim = anim;
    }
  });

  return null;
}

/* ─────────────────────────── 남의 아바타 (수신) ─────────────────────────── */

function Remotes() {
  // playersVersion은 "다시 그려라"는 신호다. players는 참조가 절대 바뀌지 않는 가변 Map이라
  // 이 구독이 없으면 입장·퇴장이 화면에 반영되지 않는다. 값 자체는 쓰지 않는다.
  useWorldStore((s) => s.playersVersion);
  const bubbleTick = useWorldStore((s) => s.bubbleTick);
  const players = useWorldStore((s) => s.players);

  // 멤버십이 바뀔 때만 이 컴포넌트가 도므로 memo가 필요 없다. 좌표는 여기로 오지 않는다.
  const list = Array.from(players.values());

  return (
    <>
      {list.map((p) => (
        <RemoteAvatar key={p.id} player={p} bubbleTick={bubbleTick} />
      ))}
    </>
  );
}

/** 쓰러지는 감쇠 계수. 1초 남짓에 눕는다 — 더 빠르면 넘어지는 게 아니라 사라지는 것처럼 보인다 */
const FALL_K = 3.2;
/** 다 누웠을 때 몸을 띄우는 높이(m). 0이면 몸통 절반이 바닥에 파묻힌다 */
const FALL_LIFT = 0.16;
/** 옆으로 살짝 비틀어 눕힌다(rad). 정확히 뒤로만 넘어가면 인형이 넘어진 것 같다 */
const FALL_ROLL = 0.2;
/** 처형된 몸의 밝기 배수. 0이면 실루엣도 안 보여서 "누가 죽었는지"를 못 읽는다 */
const CORPSE_DIM = 0.3;

const RemoteAvatar = memo(function RemoteAvatar({
  player,
  bubbleTick,
}: {
  player: RemotePlayer;
  /** 값 자체는 안 쓴다. 말풍선이 바뀔 때 이 컴포넌트를 다시 그리게 하는 신호다 */
  bubbleTick: number;
}) {
  const group = useRef<THREE.Group>(null);
  const fall = useRef<THREE.Group>(null);
  const shadow = useRef<THREE.Mesh>(null);
  const pose = useRef<Pose>({
    x: player.pose.x,
    z: player.pose.z,
    y: player.pose.y,
    heading: player.pose.heading,
  });
  const color = useMemo(() => seatColor(player.seat), [player.seat]);

  /*
   * ★ 처형만은 **구독으로 받는다.** 좌표·anim 과 정반대의 선택인데 근거가 있다:
   *   처형은 판당 최대 한 번뿐이라 리렌더 한 번이 공짜고, 이름표(DOM)를 같이 고쳐야
   *   하기 때문이다. 좌표처럼 10Hz 로 움직이는 값이었다면 절대 이렇게 두지 않는다.
   *   selector 가 boolean 을 돌려주므로 **내 자리가 처형될 때만** 이 컴포넌트가 돈다 —
   *   남이 처형돼도 여긴 안 돈다.
   *
   * ★ I1 — eliminatedId 는 players.id 일 뿐 정체가 아니다. 사람이 처형되든 봇이 처형되든
   *   여기 오는 값의 모양은 완전히 같고, 이 아래 연출도 완전히 같다.
   */
  const eliminated = useRoundtableStore((s) => s.eliminatedId === player.id);
  // useFrame 은 memo 를 통과하지 않으므로 최신 값을 ref 로 건네준다
  const elim = useRef(eliminated);
  elim.current = eliminated;
  /** 0 = 서 있다, 1 = 완전히 누웠다. 프레임 사이에 이어서 감쇠 보간한다 */
  const fallT = useRef(eliminated ? 1 : 0);

  /*
   * ★★ 이 자리가 지금 **못 움직이는 단계인가** (I1 — lib/mp/constants.ts 의 mayMove).
   *
   * ┌─ 왜 마지막 anim 을 믿으면 안 되나 ────────────────────────────────────────┐
   * │ 단계가 잠기는 순간, 봇은 서버 틱에서 haltBot 이 anim='idle' 한 장을 **보내고** │
   * │ 선다. 그런데 사람 클라는 같은 순간 송신이 막히므로(mayMove) 마지막으로 나간  │
   * │ anim 이 **'walk' 인 채로 남는다.** 그러면 그 20~30초 동안                    │
   * │   · 봇 좌석    → 선 자세                                                    │
   * │   · 걷다 잠긴 사람 → 제자리에서 걷는 자세로 굳음                             │
   * │ 이 되어, **걷는 자세로 굳은 자리 = 사람**이 된다. 총 자리·AI 수가 공개라      │
   * │ 소거법으로 나머지도 갈린다.                                                 │
   * │                                                                            │
   * │ 고치는 자리를 프로토콜이 아니라 **그리는 쪽**으로 잡은 이유:                  │
   * │   · 서버가 사람 몫의 정지 패킷을 대신 쏘면, 그 패킷이 봇의 지터(emitAsBot)와  │
   * │     다른 타이밍으로 도착해 **새 신호**가 된다. 막으려던 것과 같은 종류의 사고. │
   * │   · 여기서 막으면 모든 클라가 **모든 좌석에 같은 규칙**을 적용한다. 사람인지  │
   * │     봇인지 묻지 않고 "지금 못 움직이는 자리인가"만 본다 — 그래서 대칭이다.    │
   * │                                                                            │
   * │ ★ 판정은 단계 하나가 아니라 **좌석마다** 다르다. defense 에서는 지목된 한     │
   * │   자리만 서므로, 나머지는 걷는 클립이 그대로 살아 있어야 한다.               │
   * └──────────────────────────────────────────────────────────────────────────┘
   */
  const frozen = useRoundtableStore((s) => !mayMove(s.phase, s.nomineeId === player.id));
  const frz = useRef(frozen);
  frz.current = frozen;

  /*
   * ★ 아바타에게 anim · airborne 을 **값이 아니라 함수로** 준다.
   *
   *   이 컴포넌트는 memo 라서 멤버십이 바뀔 때만 다시 그린다. player 는 Map 안에서
   *   제자리 변형되므로 걷기 시작해도 리렌더가 나지 않는다 — 값을 넘기면 입장 시점의
   *   'idle' 이 굳어 **선 자세로 미끄러진다.** 아바타가 매 프레임 직접 물어보게 한다
   *   (좌표를 useFrame 에서 읽는 것과 같은 규약, avatar.tsx 머리말 참고).
   *
   *   처형·정지도 같은 통로로 넘긴다 — 둘 다 ref 라 deps 가 그대로다. 시체는 걷지도
   *   뛰지도 않고(idle = 완전한 정지 클립), 높이가 남아 있어도 점프 클립을 켜지 않는다.
   */
  const getAnim = useCallback(
    (): AnimState => (elim.current || frz.current ? 'idle' : player.anim),
    [player],
  );
  // 공중인지는 높이로만 판단한다 (protocol.ts 의 ANIM_STATES 주석)
  const getAirborne = useCallback(
    () => !elim.current && !frz.current && player.pose.y > 0.02,
    [player],
  );

  /*
   * ★ 처형된 자리만 어둡게 한다 — **머티리얼을 그냥 만지면 전원이 같이 어두워진다.**
   *   avatar.tsx 의 SkeletonUtils.clone 은 뼈대만 복제하고 지오메트리·머티리얼은
   *   모든 아바타가 공유한다. 그래서 이 자리 것만 복제해 갈아 끼우고, 원본을 들고
   *   있다가 되돌린다(판이 끝나 store 가 reset 되는 경우).
   *
   *   traverse 대상은 group 이 아니라 fall 이다 — group 아래에는 바닥 그림자 원판도
   *   있어서, 거기까지 훑으면 상관없는 머티리얼을 공연히 복제·폐기하게 된다.
   */
  useEffect(() => {
    const root = fall.current;
    if (!root || !eliminated) return;

    const swapped: { mesh: THREE.Mesh; original: THREE.Material | THREE.Material[] }[] = [];
    const dim = (m: THREE.Material): THREE.Material => {
      const c = m.clone();
      // 재질 종류를 모른다(Basic 에는 emissive 가 없다). 있는 것만 만진다.
      const std = c as Partial<THREE.MeshStandardMaterial>;
      if (std.color) std.color.multiplyScalar(CORPSE_DIM);
      if (std.emissive) std.emissive.setScalar(0);
      return c;
    };

    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const src = o.material as THREE.Material | THREE.Material[] | undefined;
      if (!src) return;
      swapped.push({ mesh: o, original: src });
      o.material = Array.isArray(src) ? src.map(dim) : dim(src);
    });

    return () => {
      for (const s of swapped) {
        const cur = Array.isArray(s.mesh.material) ? s.mesh.material : [s.mesh.material];
        // 복제본은 우리가 만든 것이므로 우리가 버린다. 원본은 남이 쓰고 있으니 그대로 돌려준다.
        for (const m of cur) m.dispose();
        s.mesh.material = s.original;
      }
    };
  }, [eliminated]);

  // 시체는 말하지 않는다. 마지막 말풍선이 누운 몸 위에 그대로 떠 있으면 우스워진다.
  const bubble = !eliminated && player.bubbleUntil > performance.now() ? player.bubbleText : '';
  void bubbleTick;

  useFrame((_, delta) => {
    const g = group.current;
    if (!g) return;

    // **150ms 과거를 그린다.** 최신 샘플을 바로 그리면 패킷이 한 번 늦을 때마다 튄다
    const now = performance.now();
    if (sampleAt(player.buffer, now - INTERP_DELAY_MS, pose.current)) {
      player.pose.x = pose.current.x;
      player.pose.z = pose.current.z;
      player.pose.y = pose.current.y;
      player.pose.heading = pose.current.heading;
    }

    g.position.set(player.pose.x, player.pose.y, player.pose.z);
    g.rotation.y = player.pose.heading;

    /*
     * 예전에는 여기서 몸통을 위아래로 흔들어 걸음을 흉내 냈다. 이제는 뼈대가 있는
     * 클립(walk/run/jump)이 그 일을 하므로 **흔들지 않는다** — 같이 하면 두 번 튄다.
     * 공중 여부는 아바타가 getAirborne 으로 직접 읽어 간다.
     */

    /*
     * 쓰러짐. ★ 바깥 group 은 매 프레임 위에서 통째로 덮어써지므로 여기에 회전을 얹으면
     *   다음 프레임에 지워진다. **안쪽 group(fall)을 따로 두고 그것만 돌린다** — 축도
     *   갈라져서 heading 회전과 섞이지 않는다. 회전축 원점이 발밑이라 그대로 눕힌다.
     */
    const f = fall.current;
    if (f) {
      fallT.current += ((elim.current ? 1 : 0) - fallT.current) * Math.min(delta * FALL_K, 1);
      const t = fallT.current;
      if (t > 0.0005) {
        f.rotation.x = (-Math.PI / 2) * t;
        f.rotation.z = FALL_ROLL * t;
        f.position.y = FALL_LIFT * t;
      }
    }

    // 그림자는 아바타를 따라 올라가지 않는다 — 늘 바닥에 붙어 있고 멀어질수록 작아진다.
    // 이게 없으면 점프가 "위로 간 것"인지 "커진 것"인지 구분이 안 된다.
    if (shadow.current) {
      shadow.current.position.y = 0.02 - player.pose.y;
      const s = Math.max(0.45, 1 - player.pose.y * 0.35);
      shadow.current.scale.set(s, s, 1);
    }
  });

  return (
    <group ref={group}>
      {/*
        아바타. 모델이 늦게 와도 방은 돌아야 하므로 Suspense 로 감싸고, 그동안에는
        발밑 그림자만 떠 있게 둔다 — 자리에 아무것도 없는 것보다 낫다.
        바깥 group 이 아니라 이 fall 그룹이 쓰러짐을 맡는다 (useFrame 주석).
      */}
      <group ref={fall}>
        <Suspense fallback={null}>
          <Avatar getAnim={getAnim} getAirborne={getAirborne} />
        </Suspense>
      </group>

      {/* 바닥 그림자 대용 — 실제 그림자는 8명이면 비싸다. 높이는 useFrame이 잡는다 */}
      <mesh ref={shadow} rotation-x={-Math.PI / 2} position={[0, 0.02, 0]}>
        <circleGeometry args={[0.34, 20]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.35} />
      </mesh>

      {/* 누우면 이름표도 같이 내려온다. 시체 위 2m 에 떠 있으면 누구 것인지 안 읽힌다 */}
      <Html
        position={[0, eliminated ? 0.85 : 2.0, 0]}
        center
        distanceFactor={9}
        zIndexRange={[10, 0]}
      >
        <div className="pointer-events-none flex flex-col items-center gap-1">
          {bubble ? (
            // w-max 가 없으면 Html 래퍼(폭 0)에 눌려 **한 글자씩 세로로** 줄바꿈된다.
            // 내용만큼 넓히되 220px 에서 멈춘다.
            <div className="w-max max-w-[220px] rounded-2xl bg-black/80 px-3 py-1.5 text-center text-[13px] leading-snug text-neutral-100 ring-1 ring-white/15">
              {bubble}
            </div>
          ) : null}
          <div className="flex items-center gap-1">
            <div
              className="whitespace-nowrap rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-bold"
              style={{
                color,
                opacity: eliminated ? 0.55 : 1,
                textDecoration: eliminated ? 'line-through' : undefined,
              }}
            >
              {player.nickname}
            </div>
            {eliminated ? (
              // ★ 표식은 "처형됐다"까지만 말한다. 그가 무엇이었는지는 reveal 이 말한다 (I1)
              <div className="whitespace-nowrap rounded-full bg-red-950/85 px-1.5 py-0.5 text-[10px] font-bold text-red-200 ring-1 ring-red-500/40">
                처형
              </div>
            ) : null}
          </div>
        </div>
      </Html>
    </group>
  );
});
