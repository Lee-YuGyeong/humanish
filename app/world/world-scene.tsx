'use client';

/**
 * 3D 월드 씬 — 여러 명이 같이 걸어다니는 공간. 소유: 원상 (/world)
 *
 * 배경은 app/bg-3d 의 창고(시네마 라운지)를 **그대로** 세운다. 좌표계가 같아서
 * (WORLD 는 ROOM 을 0.6 인셋한 값) 옮겨 심을 필요 없이 컴포넌트만 가져다 쓴다.
 * 여기에 복붙하면 그 순간 두 씬이 갈리므로 import 로 붙인다.
 *
 * 경계는 lib/mp/constants.ts 의 WORLD 하나뿐이고 서버가 같은 값으로 검증한다.
 * 씬을 넓히려면 거기부터 고친다.
 *
 * ★ 이 파일에는 "누가 봇인가"를 알 수 있는 코드가 한 줄도 없다 (I1).
 *   아바타는 전부 같은 경로로 그려지고, 색은 좌석 번호에서만 나온다.
 */

import { Html, PointerLockControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Suspense, memo, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import { Furniture, Lights, Warehouse, resolveColliders } from '@/app/bg-3d/room-scene';
import {
  EYE_HEIGHT,
  INTERP_DELAY_MS,
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

const CENTER_X = (WORLD.minX + WORLD.maxX) / 2;
const CENTER_Z = (WORLD.minZ + WORLD.maxZ) / 2;

/* ─────────────────────────────── 최상위 ─────────────────────────────── */

export default function WorldScene({
  conn,
  spawn,
  onLockChange,
}: {
  conn: WorldConnection;
  /** 내 시작 위치. 서버가 좌석으로 정한 자리와 같게 맞춘다 */
  spawn: { x: number; z: number };
  onLockChange?: (locked: boolean) => void;
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
      }}
    >
      <color attach="background" args={['#080604']} />
      <fogExp2 attach="fog" args={['#0b0805', 0.028]} />

      {/* 배경화면(/bg-3d)과 같은 조명 */}
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
      <LocalRig conn={conn} spawn={spawn} />
      <PointerLockControls
        onLock={() => onLockChange?.(true)}
        onUnlock={() => onLockChange?.(false)}
      />
    </Canvas>
  );
}

/* ─────────────────────────── 내 아바타 (송신) ─────────────────────────── */

const UP = new THREE.Vector3(0, 1, 0);

function LocalRig({ conn, spawn }: { conn: WorldConnection; spawn: { x: number; z: number } }) {
  const { camera } = useThree();
  const keys = useRef<Record<string, boolean>>({});
  const pos = useRef(new THREE.Vector3(spawn.x, EYE_HEIGHT, spawn.z));
  const forward = useRef(new THREE.Vector3());
  const right = useRef(new THREE.Vector3());
  // NaN으로 시작해 첫 프레임에 무조건 한 번 보내게 한다 (내 자리를 남에게 알린다)
  const lastSent = useRef({ at: 0, x: NaN, z: NaN, heading: NaN, anim: 'idle' as AnimState });

  useEffect(() => {
    camera.position.copy(pos.current);

    // 방 가운데를 보고 시작한다. 좌석 스폰은 원 위에 흩어져 있어서, 기본 방향(-z)으로
    // 두면 사람에 따라 벽만 보이고 **다른 사람이 화면에 아예 없다.** 처음 3초가 곧
    // "멀티플레이가 되는가"의 인상이라 여기서 방향을 잡아 준다.
    //
    // 카메라의 로컬 정면은 -z다. yaw θ일 때 월드 정면은 (-sinθ, 0, -cosθ)이므로
    // 중심 방향 (dx, dz)를 보려면 θ = atan2(-dx, -dz)다.
    // PointerLockControls는 이 회전을 이어받아 델타만 더하므로 먼저 잡아도 안전하다.
    const dx = CENTER_X - spawn.x;
    const dz = CENTER_Z - spawn.z;
    camera.rotation.order = 'YXZ';
    camera.rotation.set(0, Math.atan2(-dx, -dz), 0);
  }, [camera, spawn.x, spawn.z]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
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

  useFrame((_, delta) => {
    const k = keys.current;
    const ax = (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0);
    const az = (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0);
    const running = Boolean(k.ShiftLeft || k.ShiftRight);

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

    // 가구. 배경이 빈 상자가 아니라 라운지가 됐으므로 소파·랙을 뚫고 지나가지 않게 막는다.
    // 발 높이는 항상 0이다 — 이 씬에는 점프가 없다.
    resolveColliders(pos.current, 0);

    // 벽. 서버는 범위 밖을 **거절**만 하므로(보정하지 않는다) 클라가 먼저 막는다
    pos.current.x = Math.min(Math.max(pos.current.x, WORLD.minX + 0.4), WORLD.maxX - 0.4);
    pos.current.z = Math.min(Math.max(pos.current.z, WORLD.minZ + 0.4), WORLD.maxZ - 0.4);
    pos.current.y = EYE_HEIGHT;
    camera.position.copy(pos.current);

    // 아바타의 앞면은 로컬 +z다. 봇(stepBot)과 같은 규칙이어야 방향이 맞는다
    const heading = Math.atan2(forward.current.x, forward.current.z);

    const now = performance.now();
    const s = lastSent.current;
    const changed =
      s.anim !== anim ||
      Math.abs(s.x - pos.current.x) > 0.001 ||
      Math.abs(s.z - pos.current.z) > 0.001 ||
      Math.abs(s.heading - heading) > 0.001 ||
      Number.isNaN(s.x);

    // 가만히 서 있으면 패킷이 0이다. changed 검사를 빼면 8명 방에서 초당 80패킷을 낭비한다
    if (changed && now - s.at >= MOVE_THROTTLE_MS) {
      conn.sendMove(pos.current.x, pos.current.z, heading, anim);
      s.at = now;
      s.x = pos.current.x;
      s.z = pos.current.z;
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
  const body = useRef<THREE.Group>(null);
  const pose = useRef<Pose>({ x: player.pose.x, z: player.pose.z, heading: player.pose.heading });
  const color = useMemo(() => seatColor(player.seat), [player.seat]);

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
      player.pose.heading = pose.current.heading;
    }

    g.position.set(player.pose.x, 0, player.pose.z);
    g.rotation.y = player.pose.heading;

    if (body.current) {
      const moving = player.anim === 'walk' || player.anim === 'run';
      const rate = player.anim === 'run' ? 16 : 9;
      body.current.position.y = moving ? Math.abs(Math.sin(state.clock.elapsedTime * rate)) * 0.06 : 0;
    }
  });

  return (
    <group ref={group}>
      <group ref={body}>
        {/* 몸 */}
        <mesh position={[0, 0.62, 0]}>
          <capsuleGeometry args={[0.28, 0.7, 6, 14]} />
          <meshStandardMaterial color={color} roughness={0.65} metalness={0.05} />
        </mesh>
        {/* 머리 */}
        <mesh position={[0, 1.42, 0]}>
          <sphereGeometry args={[0.24, 20, 16]} />
          <meshStandardMaterial color="#e6ddd2" roughness={0.8} />
        </mesh>
        {/* 앞을 알려주는 챙. 로컬 +z가 정면이다 */}
        <mesh position={[0, 1.44, 0.22]}>
          <boxGeometry args={[0.3, 0.05, 0.16]} />
          <meshStandardMaterial color={color} roughness={0.6} />
        </mesh>
      </group>

      {/* 바닥 그림자 대용 — 실제 그림자는 8명이면 비싸다 */}
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.02, 0]}>
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
