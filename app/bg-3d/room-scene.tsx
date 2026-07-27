"use client";

/**
 * 3D 배경화면 — 레퍼런스 이미지(public/textures/room-bg.png)의 지하 라운지를
 * Three.js 로 다시 세운 씬.
 *
 * 사진 한 장을 판때기에 붙이는 방식과 달리 방을 **실제로 짓는다**.
 * 바닥·벽·천장·스크린·가구가 전부 별개의 메시라 카메라가 움직이면 시차가 생긴다.
 *
 * 텍스처는 Higgsfield(nano_banana_pro)로 레퍼런스를 물려 뽑은 4장이다.
 *   public/textures/room/{wall,floor,screen,mural}.jpg
 * 벽·바닥은 타일링용이라 이음매가 맞물리고, 조명이 구워져 있지 않아
 * 아래 조명 설정이 그대로 먹는다.
 *
 * 이 폴더(app/bg-3d) 밖은 건드리지 않는다.
 */

import { Canvas, useFrame } from "@react-three/fiber";
import { Html, RoundedBox, useProgress, useTexture } from "@react-three/drei";
import {
  Suspense,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as THREE from "three";

/* ─────────────────────────── 방 치수 (월드 단위 ≈ m) ─────────────────────────── */

const ROOM = {
  width: 20,
  /** z 범위: -13(스크린 벽) ~ 5(등 뒤 벽) */
  back: -13,
  front: 5,
  height: 6.5,
};
const DEPTH = ROOM.front - ROOM.back;
/** 방 중앙의 z. 바닥·천장 판을 여기에 놓는다 */
const MID_Z = (ROOM.front + ROOM.back) / 2;

const TEX = {
  wall: "/textures/room/wall.jpg",
  floor: "/textures/room/floor.jpg",
  screen: "/textures/room/screen.jpg",
  mural: "/textures/room/mural.jpg",
};

useTexture.preload([TEX.wall, TEX.floor, TEX.screen, TEX.mural]);

/* ─────────────────────────────── 최상위 ─────────────────────────────── */

export default function RoomScene() {
  const [moving, setMoving] = useState(true);
  const [flicker, setFlicker] = useState(true);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#07050a]">
      <Canvas
        shadows
        dpr={[1, 1.75]}
        camera={{ position: [0, 2.5, 4], fov: 55, near: 0.1, far: 60 }}
        gl={{ antialias: true }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.35;
        }}
      >
        <color attach="background" args={["#07050a"]} />
        {/* 안개가 있어야 뒤쪽 벽이 멀어 보이고 붉은 조명이 공기에 번진다 */}
        <fogExp2 attach="fog" args={["#0a0709", 0.03]} />

        <Lights flicker={flicker} />

        <Suspense fallback={<Loader />}>
          <Room />
          <Furniture />
        </Suspense>

        <Dust />
        <CameraRig moving={moving} />
      </Canvas>

      {/* 화면 가장자리를 떨어뜨려 렌즈 비네팅처럼 보이게 한다 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 45%, transparent 35%, rgba(0,0,0,0.55) 78%, rgba(0,0,0,0.85) 100%)",
        }}
      />

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-center justify-between gap-3 p-5">
        <p className="rounded-full bg-black/40 px-3 py-1.5 text-[11px] text-neutral-400 backdrop-blur">
          마우스를 움직이면 시점이 따라옵니다
        </p>
        <div className="pointer-events-auto flex gap-2">
          <HudButton on={moving} onClick={() => setMoving((v) => !v)}>
            카메라 {moving ? "정지" : "이동"}
          </HudButton>
          <HudButton on={flicker} onClick={() => setFlicker((v) => !v)}>
            조명 깜빡임 {flicker ? "끄기" : "켜기"}
          </HudButton>
        </div>
      </div>
    </div>
  );
}

function HudButton({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-4 py-2 text-xs font-bold backdrop-blur transition-colors ${
        on
          ? "bg-white/10 text-white ring-1 ring-white/25 hover:bg-white/20"
          : "bg-red-950/60 text-red-200 ring-1 ring-red-500/40 hover:bg-red-900/60"
      }`}
    >
      {children}
    </button>
  );
}

/* ─────────────────────────────── 텍스처 ─────────────────────────────── */

/**
 * 면마다 반복 횟수가 달라야 하는데, useTexture 는 URL 단위로 캐시를 공유한다.
 * 원본의 repeat 를 고치면 같은 텍스처를 쓰는 다른 면까지 같이 변한다.
 * 그래서 면마다 clone 해서 쓴다 (이미지 데이터는 공유되므로 메모리는 그대로).
 */
function useTiled(map: THREE.Texture, repeatX: number, repeatY: number) {
  return useMemo(() => {
    const t = map.clone();
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeatX, repeatY);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  }, [map, repeatX, repeatY]);
}

/* ─────────────────────────────── 방 ─────────────────────────────── */

function Room() {
  const [wall, floor, screen, mural] = useTexture([
    TEX.wall,
    TEX.floor,
    TEX.screen,
    TEX.mural,
  ]);

  // 텍스처 한 장이 덮는 실제 크기를 정해두고 면 크기로 나눈다 (벽 4m, 바닥 6.6m)
  const backTex = useTiled(wall, ROOM.width / 4, ROOM.height / 4);
  const sideTex = useTiled(wall, DEPTH / 4, ROOM.height / 4);
  const frontTex = useTiled(wall, ROOM.width / 4, ROOM.height / 4);
  const ceilTex = useTiled(wall, ROOM.width / 5, DEPTH / 5);
  const floorTex = useTiled(floor, ROOM.width / 6.6, DEPTH / 6.6);

  useLayoutEffect(() => {
    for (const t of [screen, mural]) {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      t.needsUpdate = true;
    }
  }, [screen, mural]);

  return (
    <group>
      {/* 바닥 */}
      <mesh rotation-x={-Math.PI / 2} position={[0, 0, MID_Z]} receiveShadow>
        <planeGeometry args={[ROOM.width, DEPTH]} />
        <meshStandardMaterial map={floorTex} roughness={0.82} metalness={0.05} />
      </mesh>

      {/* 천장 — 벽 텍스처를 어둡게 눌러 쓴다 */}
      <mesh rotation-x={Math.PI / 2} position={[0, ROOM.height, MID_Z]}>
        <planeGeometry args={[ROOM.width, DEPTH]} />
        <meshStandardMaterial map={ceilTex} color="#4a4640" roughness={1} />
      </mesh>
      <CeilingBeams />

      {/*
        벽은 그림자를 받지 않는다.
        스포트라이트가 벽면을 스치듯 지나가 섀도 맵이 계단처럼 깨진다(체크무늬 아티팩트).
        바닥만 그림자를 받아도 가구가 떠 보이지 않는다.
      */}
      {/* 스크린이 걸린 안쪽 벽 */}
      <mesh position={[0, ROOM.height / 2, ROOM.back]}>
        <planeGeometry args={[ROOM.width, ROOM.height]} />
        <meshStandardMaterial map={backTex} roughness={0.95} />
      </mesh>

      {/* 좌우 벽 */}
      <mesh position={[-ROOM.width / 2, ROOM.height / 2, MID_Z]} rotation-y={Math.PI / 2}>
        <planeGeometry args={[DEPTH, ROOM.height]} />
        <meshStandardMaterial map={sideTex} roughness={0.95} />
      </mesh>
      <mesh position={[ROOM.width / 2, ROOM.height / 2, MID_Z]} rotation-y={-Math.PI / 2}>
        <planeGeometry args={[DEPTH, ROOM.height]} />
        <meshStandardMaterial map={sideTex} roughness={0.95} />
      </mesh>

      {/* 등 뒤 벽 — 카메라가 뒤로 밀려도 바깥이 보이지 않게 */}
      <mesh position={[0, ROOM.height / 2, ROOM.front]} rotation-y={Math.PI}>
        <planeGeometry args={[ROOM.width, ROOM.height]} />
        <meshStandardMaterial map={frontTex} color="#8a8a8a" roughness={1} />
      </mesh>

      <Screen map={screen} />

      {/* 좌우 벽화 — 레퍼런스의 "I WANT TO PLAY A GAME" 낙서 */}
      <Mural map={mural} position={[-ROOM.width / 2 + 0.06, 3.4, -8.2]} rotationY={Math.PI / 2} />
      <Mural map={mural} position={[ROOM.width / 2 - 0.06, 3.4, -8.2]} rotationY={-Math.PI / 2} />

      <BackLedge />
      <SteelDoor />
      <WallGear />
    </group>
  );
}

/** 천장 격자 — 얇은 각재를 두 방향으로 깔아 우물천장처럼 보이게 한다 */
function CeilingBeams() {
  const xs = useMemo(
    () => Array.from({ length: 7 }, (_, i) => -ROOM.width / 2 + 1.4 + i * 2.9),
    [],
  );
  const zs = useMemo(
    () => Array.from({ length: 7 }, (_, i) => ROOM.back + 1.3 + i * 2.6),
    [],
  );

  return (
    <group position={[0, ROOM.height - 0.07, 0]}>
      {xs.map((x) => (
        <mesh key={`x${x}`} position={[x, 0, MID_Z]}>
          <boxGeometry args={[0.14, 0.14, DEPTH]} />
          <meshStandardMaterial color="#2a2724" roughness={0.9} />
        </mesh>
      ))}
      {zs.map((z) => (
        <mesh key={`z${z}`} position={[0, 0, z]}>
          <boxGeometry args={[ROOM.width, 0.14, 0.14]} />
          <meshStandardMaterial color="#2a2724" roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

/** 안쪽 벽의 대형 스크린. 나선 문양이 아주 약하게 발광한다 */
function Screen({ map }: { map: THREE.Texture }) {
  const W = 10.6;
  const H = 4.4;
  const y = 3.7;
  const z = ROOM.back + 0.2;

  return (
    <group position={[0, y, z]}>
      {/*
        액자와 화면이 같은 z 에 있으면 z-파이팅으로 화면이 얼룩덜룩해진다.
        액자는 뒤로 물리고(-0.1~0) 화면은 그 앞(+0.015)에 띄운다.
      */}
      <mesh position={[0, 0, -0.05]}>
        <boxGeometry args={[W + 0.36, H + 0.36, 0.1]} />
        <meshStandardMaterial color="#171310" roughness={0.85} />
      </mesh>
      <mesh position={[0, 0, 0.015]}>
        <planeGeometry args={[W, H]} />
        <meshStandardMaterial
          map={map}
          emissiveMap={map}
          emissive="#8a3a26"
          emissiveIntensity={0.55}
          roughness={0.95}
        />
      </mesh>
      {/* 스크린이 방을 향해 뿜는 미광 */}
      <pointLight position={[0, 0, 3.5]} intensity={26} distance={20} decay={1.6} color="#c98a5a" />
    </group>
  );
}

function Mural({
  map,
  position,
  rotationY,
}: {
  map: THREE.Texture;
  position: [number, number, number];
  rotationY: number;
}) {
  return (
    <mesh position={position} rotation-y={rotationY}>
      {/* 원본 비율 858x1280 */}
      <planeGeometry args={[3.4, 5.07]} />
      <meshStandardMaterial map={map} roughness={0.98} transparent opacity={0.94} />
    </mesh>
  );
}

/** 스크린 아래 낮은 턱 — 레퍼런스에서 무대처럼 튀어나온 부분 */
function BackLedge() {
  return (
    <group>
      <mesh position={[0, 0.75, ROOM.back + 0.35]} castShadow receiveShadow>
        <boxGeometry args={[ROOM.width, 1.5, 0.7]} />
        <meshStandardMaterial color="#3c3a36" roughness={1} />
      </mesh>
      {/* 턱에 박힌 붉은 표시등 */}
      {[-4.2, -1.4, 1.4, 4.2].map((x) => (
        <mesh key={x} position={[x, 1.2, ROOM.back + 0.71]}>
          <boxGeometry args={[0.1, 0.1, 0.04]} />
          <meshBasicMaterial color="#ff2b1d" toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

/** 왼쪽 벽의 초록 철문 */
function SteelDoor() {
  const x = -ROOM.width / 2 + 0.08;
  return (
    <group position={[x, 0, -6.5]} rotation-y={Math.PI / 2}>
      <mesh position={[0, 1.15, 0]} castShadow>
        <boxGeometry args={[1.15, 2.3, 0.14]} />
        <meshStandardMaterial color="#3e5245" roughness={0.75} metalness={0.35} />
      </mesh>
      <mesh position={[0.42, 1.1, 0.09]}>
        <boxGeometry args={[0.06, 0.24, 0.06]} />
        <meshStandardMaterial color="#7d7a70" roughness={0.5} metalness={0.6} />
      </mesh>
      {/* 문 위 비상등 */}
      <mesh position={[0, 2.62, 0.1]}>
        <boxGeometry args={[0.26, 0.16, 0.12]} />
        <meshBasicMaterial color="#ff2b1d" toneMapped={false} />
      </mesh>
    </group>
  );
}

/** 벽에 붙은 배전함·계량기 같은 잡동사니. 실루엣만으로 방이 훨씬 산다 */
function WallGear() {
  const items = useMemo(
    () =>
      [
        { x: -1, z: -11.2, side: -1 },
        { x: -1, z: -8.4, side: -1 },
        { x: 1, z: -11.2, side: 1 },
        { x: 1, z: -8.4, side: 1 },
        { x: 1, z: -3.6, side: 1 },
        { x: -1, z: -3.6, side: -1 },
      ].map((it) => ({
        ...it,
        px: it.side * (ROOM.width / 2 - 0.22),
      })),
    [],
  );

  return (
    <group>
      {items.map((it) => (
        <group
          key={`${it.px}-${it.z}`}
          position={[it.px, 2.5, it.z]}
          rotation-y={it.side < 0 ? Math.PI / 2 : -Math.PI / 2}
        >
          <mesh castShadow>
            <boxGeometry args={[0.62, 0.8, 0.3]} />
            <meshStandardMaterial color="#4a2a24" roughness={0.85} metalness={0.3} />
          </mesh>
          <mesh position={[0, 0.14, 0.17]}>
            <circleGeometry args={[0.13, 20]} />
            <meshStandardMaterial color="#161311" roughness={0.4} metalness={0.5} />
          </mesh>
          <mesh position={[0, -0.24, 0.17]}>
            <boxGeometry args={[0.07, 0.07, 0.02]} />
            <meshBasicMaterial color="#ff3423" toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/* ─────────────────────────────── 조명 ─────────────────────────────── */

/**
 * HDR 환경맵은 외부 CDN 을 타므로 쓰지 않는다.
 * 천장 다운라이트 6개 + 벽 비상등으로만 구성한다.
 * 그림자는 앞쪽 2개만 굽는다 — 전부 켜면 프레임이 반토막 난다.
 */
function Lights({ flicker }: { flicker: boolean }) {
  const spots = useMemo(
    () => [
      { x: -6.2, z: -10.5, shadow: false },
      { x: 6.2, z: -10.5, shadow: false },
      { x: -6.2, z: -5, shadow: true },
      { x: 6.2, z: -5, shadow: true },
      { x: -6.2, z: 0.5, shadow: false },
      { x: 6.2, z: 0.5, shadow: false },
    ],
    [],
  );

  return (
    <>
      {/* 완전한 암부가 생기지 않을 만큼만 */}
      <ambientLight intensity={0.38} color="#5a6070" />
      {/* 천장은 차갑게, 바닥 반사광은 흙빛으로 — 벽면이 검게 뭉치지 않는다 */}
      <hemisphereLight args={["#6d7486", "#2a1d18", 0.5]} />
      {spots.map((s) => (
        <DownLight key={`${s.x}-${s.z}`} x={s.x} z={s.z} castShadow={s.shadow} />
      ))}

      {/* 스크린 워시 — 안쪽 벽이 검게 죽지 않게 위에서 훑는다 */}
      <Wash from={[0, 5.9, -9.2]} to={[0, 3.6, ROOM.back]} angle={0.55} intensity={70} />
      {/* 벽화 워시 */}
      <Wash
        from={[-8.4, 5.6, -6.8]}
        to={[-ROOM.width / 2, 3.4, -8.2]}
        angle={0.5}
        intensity={26}
        color="#ffc79a"
      />
      <Wash
        from={[8.4, 5.6, -6.8]}
        to={[ROOM.width / 2, 3.4, -8.2]}
        angle={0.5}
        intensity={26}
        color="#ffc79a"
      />

      <RedLamp position={[-ROOM.width / 2 + 0.2, 2.9, -9]} flicker={flicker} />
      <RedLamp position={[ROOM.width / 2 - 0.2, 2.9, -9]} flicker={flicker} />
      <RedLamp position={[-ROOM.width / 2 + 0.2, 2.9, -1]} flicker={flicker} />
      <RedLamp position={[ROOM.width / 2 - 0.2, 2.9, -1]} flicker={flicker} />
    </>
  );
}

/** 천장 매입등 — 원뿔 빛 + 아래를 보는 발광 원판 */
function DownLight({
  x,
  z,
  castShadow,
}: {
  x: number;
  z: number;
  castShadow: boolean;
}) {
  const light = useRef<THREE.SpotLight>(null);
  const target = useRef<THREE.Object3D>(null);

  // spotLight 의 target 은 씬에 들어있는 Object3D 여야 한다
  useLayoutEffect(() => {
    if (light.current && target.current) light.current.target = target.current;
  }, []);

  return (
    <>
      <object3D ref={target} position={[x, 0, z]} />
      <spotLight
        ref={light}
        position={[x, ROOM.height - 0.2, z]}
        angle={0.78}
        penumbra={0.88}
        intensity={95}
        distance={22}
        decay={1.35}
        color="#ffd9ac"
        castShadow={castShadow}
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.05}
      />
      <mesh position={[x, ROOM.height - 0.16, z]} rotation-x={Math.PI / 2}>
        <circleGeometry args={[0.24, 20]} />
        <meshBasicMaterial color="#ffd0a0" toneMapped={false} />
      </mesh>
    </>
  );
}

/** 벽면을 훑는 스포트. 기구는 보이지 않고 빛만 남긴다 */
function Wash({
  from,
  to,
  angle,
  intensity,
  color = "#ffe0bb",
}: {
  from: [number, number, number];
  to: [number, number, number];
  angle: number;
  intensity: number;
  color?: string;
}) {
  const light = useRef<THREE.SpotLight>(null);
  const target = useRef<THREE.Object3D>(null);

  useLayoutEffect(() => {
    if (light.current && target.current) light.current.target = target.current;
  }, []);

  return (
    <>
      <object3D ref={target} position={to} />
      <spotLight
        ref={light}
        position={from}
        angle={angle}
        penumbra={1}
        intensity={intensity}
        distance={18}
        decay={1.2}
        color={color}
      />
    </>
  );
}

/** 벽 비상등 — 접촉 불량처럼 불규칙하게 떤다 */
function RedLamp({
  position,
  flicker,
}: {
  position: [number, number, number];
  flicker: boolean;
}) {
  const light = useRef<THREE.PointLight>(null);
  // 램프마다 위상을 달리해 동시에 깜빡이지 않게 한다
  const phase = useMemo(() => position[2] * 1.7 + position[0] * 0.3, [position]);

  useFrame(({ clock }) => {
    if (!light.current) return;
    if (!flicker) {
      light.current.intensity = 7;
      return;
    }
    const t = clock.getElapsedTime() + phase;
    // 주기가 다른 사인 둘을 겹쳐 규칙성을 지운다
    const n = Math.sin(t * 11.3) * 0.5 + Math.sin(t * 3.7) * 0.5;
    light.current.intensity = 7 + n * 2.6 + (n > 0.86 ? -4 : 0);
  });

  return (
    <group position={position}>
      <pointLight ref={light} intensity={7} distance={7.5} decay={2} color="#ff1f12" />
      <mesh>
        <boxGeometry args={[0.1, 0.24, 0.16]} />
        <meshBasicMaterial color="#ff2b1d" toneMapped={false} />
      </mesh>
    </group>
  );
}

/* ─────────────────────────────── 가구 ─────────────────────────────── */

const LEATHER_DARK = "#211a19";
const LEATHER_RED = "#4d1d20";
const FABRIC_BEIGE = "#7d7666";
const WOOD = "#3a2a1f";

function Furniture() {
  return (
    <group>
      {/* 가운데 라운지 — 붉은 소파가 낮은 테이블을 감싼다 */}
      <Sofa position={[-1.6, 0, -4.4]} rotation={0} color={LEATHER_RED} />
      <Sofa position={[1.9, 0, -6.6]} rotation={Math.PI} color={LEATHER_RED} />
      <LowTable position={[0.2, 0, -5.6]} />
      <LowTable position={[-2.6, 0, -6.6]} width={1.5} depth={0.9} />

      {/* 왼쪽 무리 */}
      <Sofa position={[-5.9, 0, -7.4]} rotation={0.35} color={LEATHER_DARK} />
      <LowTable position={[-5.4, 0, -5.9]} width={1.4} depth={0.9} />

      {/* 오른쪽 무리 */}
      <Sofa position={[5.9, 0, -6.9]} rotation={-0.3} color={LEATHER_DARK} />
      <LowTable position={[5.2, 0, -5.4]} width={1.4} depth={0.9} />
      <Sofa position={[8.3, 0, -2.6]} rotation={-Math.PI / 2} color={FABRIC_BEIGE} />

      {/* 앞쪽 테이블 3개 + 의자 — 화면 아래에 걸려 깊이를 만든다 */}
      <TableSet position={[-5.2, 0, -0.6]} />
      <TableSet position={[0.3, 0, 0.4]} />
      <TableSet position={[5.4, 0, -0.3]} />

      {/* 왼쪽 벽에 붙은 긴 좌석 */}
      <TableSet position={[-8.2, 0, -1.6]} rotation={Math.PI / 2} width={2.6} />
    </group>
  );
}

function Sofa({
  position,
  rotation = 0,
  color,
}: {
  position: [number, number, number];
  rotation?: number;
  color: string;
}) {
  return (
    <group position={position} rotation-y={rotation}>
      {/* 좌판 */}
      <RoundedBox args={[2.6, 0.46, 1.0]} radius={0.09} position={[0, 0.3, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={color} roughness={0.78} />
      </RoundedBox>
      {/* 등받이 */}
      <RoundedBox args={[2.6, 0.72, 0.3]} radius={0.09} position={[0, 0.62, -0.36]} castShadow>
        <meshStandardMaterial color={color} roughness={0.78} />
      </RoundedBox>
      {/* 팔걸이 */}
      {[-1.25, 1.25].map((x) => (
        <RoundedBox key={x} args={[0.24, 0.62, 1.0]} radius={0.08} position={[x, 0.38, 0]} castShadow>
          <meshStandardMaterial color={color} roughness={0.78} />
        </RoundedBox>
      ))}
      {/* 쿠션 */}
      <RoundedBox args={[0.55, 0.16, 0.5]} radius={0.06} position={[0.75, 0.55, -0.18]} rotation-x={-0.35} castShadow>
        <meshStandardMaterial color={color} roughness={0.9} />
      </RoundedBox>
    </group>
  );
}

function LowTable({
  position,
  rotation = 0,
  width = 1.9,
  depth = 1.1,
  height = 0.52,
  props: withProps = true,
}: {
  position: [number, number, number];
  rotation?: number;
  width?: number;
  depth?: number;
  height?: number;
  props?: boolean;
}) {
  const legX = width / 2 - 0.14;
  const legZ = depth / 2 - 0.14;

  return (
    <group position={position} rotation-y={rotation}>
      <mesh position={[0, height, 0]} castShadow receiveShadow>
        <boxGeometry args={[width, 0.09, depth]} />
        <meshStandardMaterial color={WOOD} roughness={0.7} />
      </mesh>
      {[
        [-legX, -legZ],
        [legX, -legZ],
        [-legX, legZ],
        [legX, legZ],
      ].map(([x, z]) => (
        <mesh key={`${x}${z}`} position={[x, height / 2, z]} castShadow>
          <boxGeometry args={[0.1, height, 0.1]} />
          <meshStandardMaterial color="#2b1f18" roughness={0.85} />
        </mesh>
      ))}

      {withProps && <Tabletop height={height} />}
    </group>
  );
}

/** 테이블 위 잡동사니 — 컵과 재떨이. 크기 대비가 생겨 스케일이 읽힌다 */
function Tabletop({ height }: { height: number }) {
  return (
    <group position={[0, height + 0.05, 0]}>
      <mesh position={[-0.35, 0.06, 0.1]} castShadow>
        <cylinderGeometry args={[0.05, 0.04, 0.13, 12]} />
        <meshStandardMaterial color="#b9c0b4" roughness={0.15} metalness={0.1} transparent opacity={0.55} />
      </mesh>
      <mesh position={[0.3, 0.02, -0.12]} castShadow>
        <cylinderGeometry args={[0.11, 0.11, 0.04, 16]} />
        <meshStandardMaterial color="#6b6a63" roughness={0.6} />
      </mesh>
      <mesh position={[0.05, 0.02, 0.22]} rotation-y={0.4} castShadow>
        <boxGeometry args={[0.18, 0.03, 0.12]} />
        <meshStandardMaterial color="#8a2f26" roughness={0.7} />
      </mesh>
    </group>
  );
}

function TableSet({
  position,
  rotation = 0,
  width = 1.9,
}: {
  position: [number, number, number];
  rotation?: number;
  width?: number;
}) {
  const half = width / 2;
  return (
    <group position={position} rotation-y={rotation}>
      <LowTable position={[0, 0, 0]} width={width} depth={1.1} />
      <Chair position={[-half + 0.45, 0, 0.95]} rotation={Math.PI} />
      <Chair position={[half - 0.45, 0, 0.95]} rotation={Math.PI} />
      <Chair position={[-half + 0.45, 0, -0.95]} rotation={0} />
      <Chair position={[half - 0.45, 0, -0.95]} rotation={0} />
    </group>
  );
}

function Chair({
  position,
  rotation = 0,
}: {
  position: [number, number, number];
  rotation?: number;
}) {
  return (
    <group position={position} rotation-y={rotation}>
      <RoundedBox args={[0.52, 0.12, 0.52]} radius={0.04} position={[0, 0.42, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={LEATHER_RED} roughness={0.8} />
      </RoundedBox>
      <RoundedBox args={[0.52, 0.5, 0.12]} radius={0.04} position={[0, 0.72, -0.2]} castShadow>
        <meshStandardMaterial color={LEATHER_RED} roughness={0.8} />
      </RoundedBox>
      {[
        [-0.2, -0.2],
        [0.2, -0.2],
        [-0.2, 0.2],
        [0.2, 0.2],
      ].map(([x, z]) => (
        <mesh key={`${x}${z}`} position={[x, 0.18, z]} castShadow>
          <boxGeometry args={[0.07, 0.36, 0.07]} />
          <meshStandardMaterial color="#2b1f18" roughness={0.85} />
        </mesh>
      ))}
    </group>
  );
}

/* ─────────────────────────────── 먼지 ─────────────────────────────── */

/**
 * 공중에 떠 있는 먼지. 조명 아래를 지날 때 반짝여서 공간이 비어 보이지 않는다.
 * Math.random 대신 고정 시드를 쓴다 — 새로고침마다 배치가 바뀌면 배경으로 산만하다.
 */
const DUST_COUNT = 260;

function Dust() {
  const ref = useRef<THREE.Points>(null);

  const positions = useMemo(() => {
    let seed = 20260727;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const arr = new Float32Array(DUST_COUNT * 3);
    for (let i = 0; i < DUST_COUNT; i += 1) {
      arr[i * 3] = (rand() - 0.5) * (ROOM.width - 2);
      arr[i * 3 + 1] = 0.4 + rand() * (ROOM.height - 1.2);
      arr[i * 3 + 2] = ROOM.back + 1 + rand() * (DEPTH - 2);
    }
    return arr;
  }, []);

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.getElapsedTime();
    // 아주 느리게 흐르는 공기
    ref.current.position.y = Math.sin(t * 0.13) * 0.25;
    ref.current.position.x = Math.sin(t * 0.07) * 0.4;
  });

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={0.035}
        sizeAttenuation
        color="#ffd9b0"
        transparent
        opacity={0.35}
        depthWrite={false}
      />
    </points>
  );
}

/* ─────────────────────────────── 카메라 ─────────────────────────────── */

const camTmp = new THREE.Vector3();
const lookTmp = new THREE.Vector3();

/**
 * 배경화면용 카메라. OrbitControls 를 붙이지 않는다 —
 * 드래그로 방 밖까지 나가버리면 배경이 아니라 뷰어가 된다.
 *
 * 포인터로 좌우·상하를 조금 흔들고, moving 이면 아주 느린 표류를 얹는다.
 */
function CameraRig({ moving }: { moving: boolean }) {
  useFrame((state, delta) => {
    const t = state.clock.getElapsedTime();
    // 탭을 오래 비웠다 돌아오면 delta 가 튄다. 한 프레임 분량으로 묶는다
    const dt = Math.min(delta, 0.1);

    const driftX = moving ? Math.sin(t * 0.11) * 1.7 : 0;
    const driftY = moving ? Math.sin(t * 0.19) * 0.12 : 0;
    const driftZ = moving ? Math.sin(t * 0.07) * 1.1 : 0;

    camTmp.set(
      driftX + state.pointer.x * 1.5,
      2.8 + driftY + state.pointer.y * 0.45,
      4.3 + driftZ,
    );
    // 지수 감쇠로 따라간다 (프레임레이트에 무관)
    state.camera.position.lerp(camTmp, 1 - Math.pow(0.0016, dt));

    // 시선을 조금 내려야 앞쪽 테이블이 화면에 걸린다
    lookTmp.set(state.pointer.x * 0.9, 1.95 + state.pointer.y * 0.5, ROOM.back);
    state.camera.lookAt(lookTmp);
  });

  return null;
}

/* ─────────────────────────────── 로딩 ─────────────────────────────── */

function Loader() {
  const { progress } = useProgress();
  return (
    <Html center>
      <div className="w-56 text-center">
        <div className="mb-3 h-1 w-full overflow-hidden rounded-full bg-neutral-800">
          <div
            className="h-full rounded-full bg-red-700 transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
        <p className="font-mono text-[11px] tracking-widest text-neutral-500">
          {progress.toFixed(0)}%
        </p>
      </div>
    </Html>
  );
}
