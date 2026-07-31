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
 */

import { Html, PointerLockControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Suspense, memo, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

import { Avatar, avatarVariant } from './avatar';
import {
  Furniture,
  Lights,
  SCREEN_FOCUS,
  Warehouse,
  groundHeightAt,
  resolveColliders,
} from './warehouse';
import {
  EYE_HEIGHT,
  GRAVITY,
  INTERP_DELAY_MS,
  JUMP_SPEED,
  MOVE_THROTTLE_MS,
  RUN_SPEED,
  WALK_SPEED,
  WORLD,
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
        <Warehouse />
        <Furniture />
      </Suspense>

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
    // 조작을 받는 조건은 둘이다.
    //   1) 마우스가 잠겨 있다 — ESC 로 풀어 설정을 여는 동안에는 걷지 않는다.
    //   2) 말하는 중이 아니다 — 말하기는 **잠금을 유지한 채** 열리므로(page.tsx),
    //      잠금만 보면 타이핑하는 동안 몸이 걸어간다. 키 핸들러의 typing() 가드가
    //      이미 한 겹 막지만, 포커스가 어디로 튀든 안전하도록 여기서도 막는다.
    const active = !composing && document.pointerLockElement !== null;
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

const RemoteAvatar = memo(function RemoteAvatar({
  player,
  bubbleTick,
}: {
  player: RemotePlayer;
  /** 값 자체는 안 쓴다. 말풍선이 바뀔 때 이 컴포넌트를 다시 그리게 하는 신호다 */
  bubbleTick: number;
}) {
  const group = useRef<THREE.Group>(null);
  const shadow = useRef<THREE.Mesh>(null);
  const pose = useRef<Pose>({
    x: player.pose.x,
    z: player.pose.z,
    y: player.pose.y,
    heading: player.pose.heading,
  });
  const color = useMemo(() => seatColor(player.seat), [player.seat]);
  /** 어떤 캐릭터인가. id 해시라 모두의 화면에서 같다 (avatar.tsx) */
  const variant = useMemo(() => avatarVariant(player.id), [player.id]);

  /*
   * 공중 여부만 상태로 올린다. 좌표는 useFrame 안에서 직접 만지고 리렌더하지 않는다 —
   * 8명 × 10Hz 를 setState 로 돌리면 초당 80번 다시 그린다 (store.ts 머리말과 같은 이유).
   * 점프는 초당 몇 번이 아니라 몇 초에 한 번이라 상태로 둬도 싸다.
   */
  const [airborne, setAirborne] = useState(false);
  const airborneRef = useRef(false);

  const bubble = player.bubbleUntil > performance.now() ? player.bubbleText : '';
  void bubbleTick;

  useFrame((state) => {
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
     * 공중인지는 높이로만 판단한다 (protocol.ts의 ANIM_STATES 주석).
     * 예전에는 여기서 몸통을 위아래로 흔들어 걸음을 흉내 냈다. 이제는 뼈대가 있는
     * 클립(walk/run/jump)이 그 일을 하므로 **흔들지 않는다** — 같이 하면 두 번 튄다.
     */
    const airborne = player.pose.y > 0.02;
    if (airborne !== airborneRef.current) {
      airborneRef.current = airborne;
      setAirborne(airborne);
    }
    void state;

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
      */}
      <Suspense fallback={null}>
        <Avatar variant={variant} anim={player.anim} airborne={airborne} />
      </Suspense>

      {/* 바닥 그림자 대용 — 실제 그림자는 8명이면 비싸다. 높이는 useFrame이 잡는다 */}
      <mesh ref={shadow} rotation-x={-Math.PI / 2} position={[0, 0.02, 0]}>
        <circleGeometry args={[0.34, 20]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.35} />
      </mesh>

      <Html position={[0, 2.0, 0]} center distanceFactor={9} zIndexRange={[10, 0]}>
        <div className="pointer-events-none flex flex-col items-center gap-1">
          {bubble ? (
            // w-max 가 없으면 Html 래퍼(폭 0)에 눌려 **한 글자씩 세로로** 줄바꿈된다.
            // 내용만큼 넓히되 220px 에서 멈춘다.
            <div className="w-max max-w-[220px] rounded-2xl bg-black/80 px-3 py-1.5 text-center text-[13px] leading-snug text-neutral-100 ring-1 ring-white/15">
              {bubble}
            </div>
          ) : null}
          <div
            className="whitespace-nowrap rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-bold"
            style={{ color }}
          >
            {player.nickname}
          </div>
        </div>
      </Html>
    </group>
  );
});
