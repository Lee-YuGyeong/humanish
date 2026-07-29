"use client";

/**
 * 창고 시네마 라운지 — /world 의 배경. 소유: 원상
 *
 * 사진 한 장을 판때기에 붙이는 방식과 달리 방을 **실제로 짓는다**.
 * 바닥·벽·박공지붕·트러스·스크린·가구가 전부 별개의 메시라 카메라가 움직이면 시차가 생긴다.
 *
 * 텍스처는 Higgsfield(nano_banana_pro)로 뽑은 타일링용 3장이다.
 *   public/textures/warehouse/{wall,floor,box}.jpg
 * 벽·바닥은 이음매가 맞물리고, 조명이 구워져 있지 않아 아래 조명 설정이 그대로 먹는다.
 *
 * 여기에는 **씬만 있다.** 캔버스·카메라·이동·네트워크는 world-scene.tsx 가 쥔다.
 * 원래 /bg-3d 라는 전용 배경화면 라우트였는데, /world 가 같은 방을 쓰게 되면서
 * 배경만 보는 화면은 지웠다. 치수는 lib/mp/constants.ts 의 WORLD 와 같은 좌표계다
 * (WORLD 는 아래 ROOM 을 0.6 인셋한 값 — 서버가 그 범위로 검증한다).
 */

import { useFrame } from "@react-three/fiber";
import { RoundedBox, useTexture } from "@react-three/drei";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";

/* ─────────────────────────── 창고 치수 (월드 단위 ≈ m) ─────────────────────────── */

const ROOM = {
  width: 22,
  /** z 범위: -14(스크린 벽) ~ 6(등 뒤 벽) */
  back: -14,
  front: 6,
  /** 처마 높이. 여기까지가 벽, 위는 박공지붕 */
  eave: 5.6,
  /** 용마루(지붕 꼭대기) 높이 */
  ridge: 8.8,
};
const DEPTH = ROOM.front - ROOM.back;
const MID_Z = (ROOM.front + ROOM.back) / 2;
const HALF_W = ROOM.width / 2;
/** 지붕 경사각과 경사면 길이 */
const RISE = ROOM.ridge - ROOM.eave;
const SLOPE_ANGLE = Math.atan2(RISE, HALF_W);
const SLOPE_LEN = Math.hypot(HALF_W, RISE);

const TEX = {
  wall: "/textures/warehouse/wall.jpg",
  floor: "/textures/warehouse/floor.jpg",
  box: "/textures/warehouse/box.jpg",
};

useTexture.preload([TEX.wall, TEX.floor, TEX.box]);

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

/* ─────────────────────────────── 건물 ─────────────────────────────── */

const STEEL = "#1e1b17";

/** 건물 골조 · 스크린 · 선반. /world 가 같은 좌표계로 이걸 그대로 세운다 */
export function Warehouse() {
  const [wall, floor, box] = useTexture([TEX.wall, TEX.floor, TEX.box]);

  // 텍스처 한 장이 덮는 실제 크기: 골강판 3.2m, 바닥 슬래브 4장 = 7m
  const sideTex = useTiled(wall, DEPTH / 3.2, ROOM.eave / 3.2);
  const gableTex = useTiled(wall, ROOM.width / 3.2, ROOM.ridge / 3.2);
  const roofTex = useTiled(wall, DEPTH / 3.2, SLOPE_LEN / 3.2);
  const floorTex = useTiled(floor, ROOM.width / 7, DEPTH / 7);

  return (
    <group>
      {/* 바닥 */}
      <mesh rotation-x={-Math.PI / 2} position={[0, 0, MID_Z]} receiveShadow>
        <planeGeometry args={[ROOM.width, DEPTH]} />
        <meshStandardMaterial
          map={floorTex}
          color="#93887a"
          roughness={0.88}
          metalness={0.04}
        />
      </mesh>

      {/*
        벽은 그림자를 받지 않는다.
        스포트라이트가 벽면을 스치듯 지나가면 섀도 맵이 계단처럼 깨진다.
        바닥만 그림자를 받아도 가구가 떠 보이지 않는다.
      */}
      {/* 스크린이 걸린 안쪽 박공벽 — 지붕 위로 남는 귀퉁이는 지붕 판이 가린다 */}
      <mesh position={[0, ROOM.ridge / 2, ROOM.back]}>
        <planeGeometry args={[ROOM.width, ROOM.ridge]} />
        <meshStandardMaterial map={gableTex} color="#8b847b" roughness={0.92} />
      </mesh>
      {/* 등 뒤 박공벽 — 카메라가 뒤로 밀려도 바깥이 보이지 않게 */}
      <mesh position={[0, ROOM.ridge / 2, ROOM.front]} rotation-y={Math.PI}>
        <planeGeometry args={[ROOM.width, ROOM.ridge]} />
        <meshStandardMaterial map={gableTex} color="#6f6a62" roughness={1} />
      </mesh>

      {/* 좌우 벽 (처마 높이까지) */}
      <mesh position={[-HALF_W, ROOM.eave / 2, MID_Z]} rotation-y={Math.PI / 2}>
        <planeGeometry args={[DEPTH, ROOM.eave]} />
        <meshStandardMaterial map={sideTex} color="#8b847b" roughness={0.92} />
      </mesh>
      <mesh position={[HALF_W, ROOM.eave / 2, MID_Z]} rotation-y={-Math.PI / 2}>
        <planeGeometry args={[DEPTH, ROOM.eave]} />
        <meshStandardMaterial map={sideTex} color="#8b847b" roughness={0.92} />
      </mesh>

      <Roof map={roofTex} />
      <Trusses />
      <WallBraces />

      <Screen />
      <Stage />

      {/* 스크린 양옆 + 좌우 벽의 박스 선반 */}
      <Rack map={box} position={[-8.3, 0, ROOM.back + 0.75]} />
      <Rack map={box} position={[8.3, 0, ROOM.back + 0.75]} />
      <Rack map={box} position={[-HALF_W + 0.75, 0, -8.5]} rotationY={Math.PI / 2} />
      <Rack map={box} position={[HALF_W - 0.75, 0, -8.5]} rotationY={-Math.PI / 2} />
      <Rack map={box} position={[-HALF_W + 0.75, 0, -4.8]} rotationY={Math.PI / 2} />
      <Rack map={box} position={[HALF_W - 0.75, 0, -4.8]} rotationY={-Math.PI / 2} />

      <SteelDoor position={[-HALF_W + 0.08, 0, -11.4]} side={1} />
      <SteelDoor position={[HALF_W - 0.08, 0, -11.4]} side={-1} />

      {/* 오른쪽 벽 앞의 장비 케이스 무더기 */}
      <RoadCases />
    </group>
  );
}

/** 박공지붕 — 경사면 두 장. 안쪽에서 올려다보므로 DoubleSide */
function Roof({ map }: { map: THREE.Texture }) {
  const y = (ROOM.eave + ROOM.ridge) / 2;
  return (
    <group>
      <group position={[-HALF_W / 2, y, MID_Z]} rotation-z={SLOPE_ANGLE}>
        <mesh rotation-x={Math.PI / 2}>
          <planeGeometry args={[SLOPE_LEN, DEPTH]} />
          <meshStandardMaterial
            map={map}
            color="#4b453e"
            roughness={1}
            side={THREE.DoubleSide}
          />
        </mesh>
      </group>
      <group position={[HALF_W / 2, y, MID_Z]} rotation-z={-SLOPE_ANGLE}>
        <mesh rotation-x={Math.PI / 2}>
          <planeGeometry args={[SLOPE_LEN, DEPTH]} />
          <meshStandardMaterial
            map={map}
            color="#4b453e"
            roughness={1}
            side={THREE.DoubleSide}
          />
        </mesh>
      </group>
    </group>
  );
}

/**
 * 철골 트러스 — 하현재 + 서까래 + 킹포스트 + 사재. 실루엣이 창고를 만든다.
 * 스크린 앞을 하현재가 가로지르면 안 되므로 안쪽 벽 근처에는 세우지 않는다.
 */
function Trusses() {
  const zs = useMemo(
    () => Array.from({ length: 5 }, (_, i) => ROOM.back + 4.2 + i * 3.4),
    [],
  );
  const midY = (ROOM.eave + ROOM.ridge) / 2;

  return (
    <group>
      {zs.map((z) => (
        <group key={z}>
          {/* 하현재 (수평) */}
          <mesh position={[0, ROOM.eave, z]}>
            <boxGeometry args={[ROOM.width, 0.18, 0.16]} />
            <meshStandardMaterial color={STEEL} roughness={0.85} metalness={0.35} />
          </mesh>
          {/* 서까래 (경사) */}
          <group position={[-HALF_W / 2, midY, z]} rotation-z={SLOPE_ANGLE}>
            <mesh>
              <boxGeometry args={[SLOPE_LEN, 0.18, 0.14]} />
              <meshStandardMaterial color={STEEL} roughness={0.85} metalness={0.35} />
            </mesh>
          </group>
          <group position={[HALF_W / 2, midY, z]} rotation-z={-SLOPE_ANGLE}>
            <mesh>
              <boxGeometry args={[SLOPE_LEN, 0.18, 0.14]} />
              <meshStandardMaterial color={STEEL} roughness={0.85} metalness={0.35} />
            </mesh>
          </group>
          {/* 킹포스트 + 사재 */}
          <mesh position={[0, ROOM.eave + RISE / 2, z]}>
            <boxGeometry args={[0.14, RISE, 0.12]} />
            <meshStandardMaterial color={STEEL} roughness={0.85} metalness={0.35} />
          </mesh>
          {[-1, 1].map((s) => (
            <group
              key={s}
              position={[(s * HALF_W) / 4, ROOM.eave + RISE / 4, z]}
              rotation-z={-s * Math.atan2(RISE / 2, HALF_W / 2)}
            >
              <mesh>
                <boxGeometry args={[Math.hypot(HALF_W / 2, RISE / 2), 0.1, 0.1]} />
                <meshStandardMaterial color={STEEL} roughness={0.85} metalness={0.35} />
              </mesh>
            </group>
          ))}
        </group>
      ))}
    </group>
  );
}

/** 좌우 벽의 기둥과 X자 가새 — 레퍼런스의 대각 브레이싱 */
function WallBraces() {
  const bayW = 6;
  const bays = useMemo(
    () => Array.from({ length: 3 }, (_, i) => ROOM.back + 2.2 + i * (bayW + 0.6)),
    [],
  );
  const diagLen = Math.hypot(bayW, ROOM.eave - 1);
  const diagAngle = Math.atan2(ROOM.eave - 1, bayW);

  return (
    <group>
      {[-1, 1].map((side) => (
        <group
          key={side}
          position={[side * (HALF_W - 0.18), 0, 0]}
          rotation-y={side < 0 ? Math.PI / 2 : -Math.PI / 2}
        >
          {bays.map((z0) => (
            // 벽면을 xy 평면으로 눕혀서 짓는다. x = 방의 z 방향
            <group key={z0} position={[side < 0 ? -(z0 + bayW / 2) : z0 + bayW / 2, 0, 0]}>
              {/* 기둥 */}
              {[-bayW / 2, bayW / 2].map((x) => (
                <mesh key={x} position={[x, ROOM.eave / 2, 0]}>
                  <boxGeometry args={[0.22, ROOM.eave, 0.2]} />
                  <meshStandardMaterial color={STEEL} roughness={0.85} metalness={0.35} />
                </mesh>
              ))}
              {/* X 가새 */}
              {[diagAngle, -diagAngle].map((a) => (
                <mesh key={a} position={[0, ROOM.eave / 2 + 0.4, 0]} rotation-z={a}>
                  <boxGeometry args={[diagLen, 0.12, 0.1]} />
                  <meshStandardMaterial color={STEEL} roughness={0.85} metalness={0.35} />
                </mesh>
              ))}
            </group>
          ))}
        </group>
      ))}
    </group>
  );
}

/* ─────────────────────────────── 스크린 · 무대 ─────────────────────────────── */

const SCREEN = { w: 11, h: 4.3, y: 3.9, z: ROOM.back + 0.22 };

/**
 * 안쪽 벽의 대형 빈 스크린.
 * 흰 판 자체는 살짝만 발광하고, 위에서 쏘는 스포트 3개(§Lights)가
 * 레퍼런스처럼 세 갈래 빛 웅덩이를 만든다.
 */
function Screen() {
  return (
    <group position={[0, SCREEN.y, SCREEN.z]}>
      {/* 액자와 화면이 같은 z 에 있으면 z-파이팅이 난다. 액자는 뒤, 화면은 앞 */}
      <mesh position={[0, 0, -0.05]}>
        <boxGeometry args={[SCREEN.w + 0.3, SCREEN.h + 0.3, 0.1]} />
        <meshStandardMaterial color="#15120e" roughness={0.85} />
      </mesh>
      <mesh position={[0, 0, 0.015]}>
        <planeGeometry args={[SCREEN.w, SCREEN.h]} />
        <meshStandardMaterial
          color="#e8ddcd"
          emissive="#d8c9b2"
          emissiveIntensity={0.14}
          roughness={0.95}
        />
      </mesh>
      {/* 스크린이 방을 향해 뿜는 미광 */}
      <pointLight position={[0, 0, 4]} intensity={30} distance={22} decay={1.6} color="#e6c9a3" />
    </group>
  );
}

/** 스크린 아래 낮은 무대턱 — 스피커와 붉은 표시등이 올라간다 */
function Stage() {
  return (
    <group>
      <mesh position={[0, 0.55, ROOM.back + 0.45]} castShadow receiveShadow>
        <boxGeometry args={[ROOM.width * 0.82, 1.1, 0.9]} />
        <meshStandardMaterial color="#37332e" roughness={1} />
      </mesh>
      {/* 스피커 3개 */}
      {[-4.6, 0, 4.6].map((x) => (
        <group key={x} position={[x, 1.42, ROOM.back + 0.5]}>
          <mesh castShadow>
            <boxGeometry args={[0.62, 0.62, 0.5]} />
            <meshStandardMaterial color="#12100d" roughness={0.9} />
          </mesh>
          <mesh position={[0, 0, 0.26]}>
            <circleGeometry args={[0.2, 20]} />
            <meshStandardMaterial color="#050505" roughness={0.6} />
          </mesh>
        </group>
      ))}
      {/* 무대턱의 붉은 대기 표시등 */}
      {[-7.4, -2.3, 2.3, 7.4].map((x) => (
        <mesh key={x} position={[x, 1.02, ROOM.back + 0.91]}>
          <boxGeometry args={[0.09, 0.09, 0.03]} />
          <meshBasicMaterial color="#ff3320" toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

/* ─────────────────────────────── 선반 · 소품 ─────────────────────────────── */

/** 철제 랙 + 골판지 박스 더미. 박스는 텍스처를 반복해 한 덩어리로 그린다 */
function Rack({
  map,
  position,
  rotationY = 0,
}: {
  map: THREE.Texture;
  position: [number, number, number];
  rotationY?: number;
}) {
  const W = 2.8;
  const D = 1.0;
  const H = 4.4;
  const shelfYs = [0.18, 1.35, 2.52, 3.69];
  // 박스 텍스처 한 장(8칸)이 실측 약 8.4m 를 덮게 잡는다 — 박스 하나가 1m 남짓
  const boxTex = useTiled(map, W / 8.4, 1.05 / 8.4);
  // 층마다 박스 더미 폭·높이를 조금씩 다르게 — 규칙적이면 가짜 티가 난다
  const stacks = [
    { w: W - 0.25, h: 0.95 },
    { w: W - 0.55, h: 0.9 },
    { w: W - 0.35, h: 0.85 },
    { w: W - 1.1, h: 0.7 },
  ];

  return (
    <group position={position} rotation-y={rotationY}>
      {/* 기둥 4개 */}
      {[
        [-W / 2, -D / 2],
        [W / 2, -D / 2],
        [-W / 2, D / 2],
        [W / 2, D / 2],
      ].map(([x, z]) => (
        <mesh key={`${x}${z}`} position={[x, H / 2, z]} castShadow>
          <boxGeometry args={[0.09, H, 0.09]} />
          <meshStandardMaterial color={STEEL} roughness={0.8} metalness={0.4} />
        </mesh>
      ))}
      {/* 선반널 + 박스 더미 */}
      {shelfYs.map((y, i) => (
        <group key={y}>
          <mesh position={[0, y, 0]} castShadow>
            <boxGeometry args={[W + 0.06, 0.07, D]} />
            <meshStandardMaterial color="#252220" roughness={0.9} />
          </mesh>
          <mesh position={[0, y + 0.05 + stacks[i].h / 2, 0]} castShadow>
            <boxGeometry args={[stacks[i].w, stacks[i].h, D - 0.2]} />
            <meshStandardMaterial map={boxTex} color="#9c8b71" roughness={0.95} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** 좌우 벽의 철문 */
function SteelDoor({
  position,
  side,
}: {
  position: [number, number, number];
  side: 1 | -1;
}) {
  return (
    <group position={position} rotation-y={(side * Math.PI) / 2}>
      <mesh position={[0, 1.2, 0]} castShadow>
        <boxGeometry args={[1.2, 2.4, 0.14]} />
        <meshStandardMaterial color="#2e2a24" roughness={0.8} metalness={0.3} />
      </mesh>
      <mesh position={[0.44, 1.15, 0.09]}>
        <boxGeometry args={[0.06, 0.22, 0.06]} />
        <meshStandardMaterial color="#8a8578" roughness={0.5} metalness={0.6} />
      </mesh>
      {/* 문 위 비상등 */}
      <mesh position={[0, 2.72, 0.1]}>
        <boxGeometry args={[0.24, 0.14, 0.1]} />
        <meshBasicMaterial color="#ff3320" toneMapped={false} />
      </mesh>
    </group>
  );
}

/** 오른쪽 벽 앞의 투어 장비 케이스 — 실루엣용 잡동사니 */
function RoadCases() {
  const cases = [
    { x: HALF_W - 1.3, z: 1.6, w: 1.4, h: 1.3 },
    { x: HALF_W - 1.2, z: 3.2, w: 1.1, h: 0.9 },
    { x: HALF_W - 2.6, z: 2.4, w: 1.0, h: 1.05 },
    { x: -HALF_W + 1.3, z: 2.2, w: 1.3, h: 1.15 },
  ];
  return (
    <group>
      {cases.map((c) => (
        <group key={`${c.x}${c.z}`} position={[c.x, 0, c.z]}>
          <mesh position={[0, c.h / 2, 0]} castShadow>
            <boxGeometry args={[c.w, c.h, 0.85]} />
            <meshStandardMaterial color="#191a1c" roughness={0.65} metalness={0.35} />
          </mesh>
          {/* 알루미늄 테두리 띠 */}
          <mesh position={[0, c.h / 2, 0]}>
            <boxGeometry args={[c.w + 0.02, 0.05, 0.87]} />
            <meshStandardMaterial color="#6f6e68" roughness={0.4} metalness={0.7} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/* ─────────────────────────────── 조명 ─────────────────────────────── */

/**
 * HDR 환경맵은 외부 CDN 을 타므로 쓰지 않는다.
 * 스크린 스포트 3개 + 펜던트 등 + 벽 브래킷 등으로만 구성한다.
 * 그림자는 좌석 위 스포트 2개만 굽는다 — 전부 켜면 프레임이 반토막 난다.
 */
export function Lights({ flicker }: { flicker: boolean }) {
  return (
    <>
      {/* 완전한 암부가 생기지 않을 만큼만, 따뜻하게 */}
      <ambientLight intensity={0.22} color="#7a6a55" />
      {/* 지붕은 어두운 갈색, 바닥 반사광은 흙빛 */}
      <hemisphereLight args={["#5a5044", "#33261c", 0.38]} />

      {/* 스크린을 때리는 스포트 3개 — 레퍼런스의 세 갈래 빛 웅덩이 */}
      {[-3.4, 0, 3.4].map((x) => (
        <Spot
          key={x}
          from={[x, ROOM.eave + 1, ROOM.back + 2.2]}
          to={[x, SCREEN.y - 0.9, ROOM.back]}
          angle={0.4}
          intensity={190}
          color="#ffe3bd"
        />
      ))}

      {/* 좌석 위 다운라이트 — 가구 그림자는 이 둘이 만든다 */}
      <Spot
        from={[-3.2, ROOM.eave - 0.4, -5.5]}
        to={[-3.2, 0, -5.5]}
        angle={0.85}
        intensity={80}
        color="#ffd9ac"
        castShadow
      />
      <Spot
        from={[3.2, ROOM.eave - 0.4, -3.5]}
        to={[3.2, 0, -3.5]}
        angle={0.85}
        intensity={80}
        color="#ffd9ac"
        castShadow
      />

      {/* 펜던트 등 — 트러스에 매달린 갓등. 절반만 실제 광원이다 */}
      {[
        { x: -7.4, z: -12, lit: false },
        { x: 7.4, z: -12, lit: false },
        { x: -5.8, z: -8, lit: true },
        { x: 5.8, z: -8, lit: true },
        { x: -5.8, z: -1.2, lit: true },
        { x: 5.8, z: -1.2, lit: true },
        { x: 0, z: 2.2, lit: false },
        { x: -5.8, z: 4.5, lit: false },
        { x: 5.8, z: 4.5, lit: false },
      ].map((p) => (
        <Pendant key={`${p.x}${p.z}`} x={p.x} z={p.z} lit={p.lit} flicker={flicker} />
      ))}

      {/* 벽 브래킷 등 — 좌우 벽에 붙은 따뜻한 백열등 */}
      <Sconce position={[-HALF_W + 0.25, 3.6, -9.8]} lit />
      <Sconce position={[HALF_W - 0.25, 3.6, -9.8]} lit />
      <Sconce position={[-HALF_W + 0.25, 3.6, -2]} />
      <Sconce position={[HALF_W - 0.25, 3.6, -2]} />
    </>
  );
}

/** 위치·타깃만 주면 되는 스포트라이트 래퍼 */
function Spot({
  from,
  to,
  angle,
  intensity,
  color = "#ffe0bb",
  castShadow = false,
}: {
  from: [number, number, number];
  to: [number, number, number];
  angle: number;
  intensity: number;
  color?: string;
  castShadow?: boolean;
}) {
  const light = useRef<THREE.SpotLight>(null);
  const target = useRef<THREE.Object3D>(null);

  // spotLight 의 target 은 씬에 들어있는 Object3D 여야 한다
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
        penumbra={0.9}
        intensity={intensity}
        distance={26}
        decay={1.4}
        color={color}
        castShadow={castShadow}
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.05}
      />
    </>
  );
}

/** 트러스에 매달린 공장 갓등. lit 이면 점광원을 품는다 */
function Pendant({
  x,
  z,
  lit,
  flicker,
}: {
  x: number;
  z: number;
  lit: boolean;
  flicker: boolean;
}) {
  const light = useRef<THREE.PointLight>(null);
  const rodLen = 1.0;
  const shadeY = ROOM.eave - rodLen;
  // 등마다 위상을 달리해 동시에 흔들리지 않게 한다
  const phase = useMemo(() => z * 1.7 + x * 0.3, [x, z]);

  useFrame(({ clock }) => {
    if (!light.current) return;
    if (!flicker) {
      light.current.intensity = 26;
      return;
    }
    const t = clock.getElapsedTime() + phase;
    // 주기가 다른 사인 둘을 겹쳐 규칙성을 지운다. 백열등이라 진폭은 작게
    const n = Math.sin(t * 7.3) * 0.5 + Math.sin(t * 2.9) * 0.5;
    light.current.intensity = 26 + n * 3;
  });

  return (
    <group position={[x, shadeY, z]}>
      {/* 매다는 봉 */}
      <mesh position={[0, rodLen / 2 + 0.1, 0]}>
        <cylinderGeometry args={[0.02, 0.02, rodLen, 8]} />
        <meshStandardMaterial color={STEEL} roughness={0.8} />
      </mesh>
      {/* 갓 (아래가 넓은 원뿔) */}
      <mesh>
        <cylinderGeometry args={[0.09, 0.4, 0.32, 24, 1, true]} />
        <meshStandardMaterial
          color="#26221d"
          roughness={0.6}
          metalness={0.5}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* 전구 */}
      <mesh position={[0, -0.12, 0]}>
        <sphereGeometry args={[0.07, 12, 12]} />
        <meshBasicMaterial color="#ffd9a3" toneMapped={false} />
      </mesh>
      {lit && (
        <pointLight
          ref={light}
          position={[0, -0.25, 0]}
          intensity={26}
          distance={13}
          decay={1.7}
          color="#ffca8e"
        />
      )}
    </group>
  );
}

/** 벽 브래킷 등 — 유리 갓 안의 백열등 */
function Sconce({
  position,
  lit = false,
}: {
  position: [number, number, number];
  lit?: boolean;
}) {
  return (
    <group position={position}>
      <mesh>
        <sphereGeometry args={[0.13, 14, 14]} />
        <meshBasicMaterial color="#ffe8c4" toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.16, 0]}>
        <cylinderGeometry args={[0.05, 0.14, 0.12, 12]} />
        <meshStandardMaterial color={STEEL} roughness={0.7} metalness={0.4} />
      </mesh>
      {lit && (
        <pointLight intensity={11} distance={9} decay={1.8} color="#ffd9a8" />
      )}
    </group>
  );
}

/* ─────────────────────────────── 가구 ─────────────────────────────── */

const LEATHER_BLACK = "#1b1715";
const CHAIR_BROWN = "#4a2b21";
const WOOD_DARK = "#241a13";

export function Furniture() {
  return (
    <group>
      {/* 스크린 앞 소파 라운지 — 전부 스크린을 본다 */}
      <Sofa position={[-4.4, 0, -8.2]} rotation={0.12} />
      <Sofa position={[0.2, 0, -7.4]} rotation={0} />
      <Sofa position={[4.8, 0, -8]} rotation={-0.12} />
      <Sofa position={[-7.8, 0, -6.6]} rotation={0.5} />
      <Sofa position={[7.9, 0, -6.4]} rotation={-0.5} />
      <LowTable position={[-4.2, 0, -6.7]} />
      <LowTable position={[0.4, 0, -5.9]} />
      <LowTable position={[4.7, 0, -6.5]} width={1.5} />

      {/* 흩어진 식탁 무리 — 레퍼런스의 앞쪽 절반 */}
      <TableSet position={[-7.6, 0, -1.6]} rotation={0.15} />
      <TableSet position={[-6.9, 0, 3]} rotation={-0.2} />
      <TableSet position={[0.1, 0, 1.4]} rotation={0.05} />
      <TableSet position={[7.2, 0, -1.9]} rotation={-0.12} />
      <TableSet position={[6.6, 0, 3.1]} rotation={0.25} />
    </group>
  );
}

function Sofa({
  position,
  rotation = 0,
}: {
  position: [number, number, number];
  rotation?: number;
}) {
  return (
    <group position={position} rotation-y={rotation}>
      {/* 좌판 */}
      <RoundedBox args={[2.7, 0.48, 1.05]} radius={0.09} position={[0, 0.32, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={LEATHER_BLACK} roughness={0.62} />
      </RoundedBox>
      {/* 등받이 */}
      <RoundedBox args={[2.7, 0.66, 0.3]} radius={0.09} position={[0, 0.66, -0.4]} castShadow>
        <meshStandardMaterial color={LEATHER_BLACK} roughness={0.62} />
      </RoundedBox>
      {/* 팔걸이 */}
      {[-1.3, 1.3].map((x) => (
        <RoundedBox key={x} args={[0.26, 0.6, 1.05]} radius={0.08} position={[x, 0.4, 0]} castShadow>
          <meshStandardMaterial color={LEATHER_BLACK} roughness={0.62} />
        </RoundedBox>
      ))}
      {/* 좌석 쿠션 이음선 — 밋밋함을 줄인다 */}
      {[-0.65, 0.65].map((x) => (
        <RoundedBox key={x} args={[1.18, 0.14, 0.9]} radius={0.06} position={[x, 0.56, 0.02]} castShadow>
          <meshStandardMaterial color={LEATHER_BLACK} roughness={0.68} />
        </RoundedBox>
      ))}
    </group>
  );
}

function LowTable({
  position,
  width = 1.8,
  depth = 1.0,
}: {
  position: [number, number, number];
  width?: number;
  depth?: number;
}) {
  const height = 0.46;
  const legX = width / 2 - 0.12;
  const legZ = depth / 2 - 0.12;

  return (
    <group position={position}>
      <mesh position={[0, height, 0]} castShadow receiveShadow>
        <boxGeometry args={[width, 0.08, depth]} />
        <meshStandardMaterial color={WOOD_DARK} roughness={0.7} />
      </mesh>
      {[
        [-legX, -legZ],
        [legX, -legZ],
        [-legX, legZ],
        [legX, legZ],
      ].map(([x, z]) => (
        <mesh key={`${x}${z}`} position={[x, height / 2, z]} castShadow>
          <boxGeometry args={[0.09, height, 0.09]} />
          <meshStandardMaterial color="#1a1310" roughness={0.85} />
        </mesh>
      ))}
      <Tabletop height={height} />
    </group>
  );
}

/** 테이블 위 잡동사니 — 접시와 컵. 크기 대비가 생겨 스케일이 읽힌다 */
function Tabletop({ height }: { height: number }) {
  return (
    <group position={[0, height + 0.05, 0]}>
      <mesh position={[0.28, 0, -0.1]} castShadow>
        <cylinderGeometry args={[0.13, 0.13, 0.025, 18]} />
        <meshStandardMaterial color="#d6cfc2" roughness={0.4} />
      </mesh>
      <mesh position={[-0.3, 0.05, 0.12]} castShadow>
        <cylinderGeometry args={[0.045, 0.04, 0.11, 12]} />
        <meshStandardMaterial color="#3c3a36" roughness={0.5} />
      </mesh>
      <mesh position={[-0.02, 0, 0.24]} rotation-y={0.5} castShadow>
        <boxGeometry args={[0.16, 0.025, 0.11]} />
        <meshStandardMaterial color="#22201d" roughness={0.7} />
      </mesh>
    </group>
  );
}

/** 식탁 하나 + 의자 4개 */
function TableSet({
  position,
  rotation = 0,
}: {
  position: [number, number, number];
  rotation?: number;
}) {
  const W = 1.5;
  const H = 0.74;
  const legX = W / 2 - 0.12;

  return (
    <group position={position} rotation-y={rotation}>
      <mesh position={[0, H, 0]} castShadow receiveShadow>
        <boxGeometry args={[W, 0.07, W]} />
        <meshStandardMaterial color={WOOD_DARK} roughness={0.65} />
      </mesh>
      {[
        [-legX, -legX],
        [legX, -legX],
        [-legX, legX],
        [legX, legX],
      ].map(([x, z]) => (
        <mesh key={`${x}${z}`} position={[x, H / 2, z]} castShadow>
          <boxGeometry args={[0.08, H, 0.08]} />
          <meshStandardMaterial color="#15100c" roughness={0.85} />
        </mesh>
      ))}
      <Tabletop height={H} />

      <Chair position={[-0.42, 0, 1.02]} rotation={Math.PI} />
      <Chair position={[0.42, 0, 1.02]} rotation={Math.PI} />
      <Chair position={[-0.42, 0, -1.02]} rotation={0} />
      <Chair position={[0.42, 0, -1.02]} rotation={0} />
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
      <RoundedBox args={[0.5, 0.1, 0.5]} radius={0.04} position={[0, 0.46, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={CHAIR_BROWN} roughness={0.75} />
      </RoundedBox>
      <RoundedBox args={[0.5, 0.55, 0.1]} radius={0.04} position={[0, 0.82, -0.2]} castShadow>
        <meshStandardMaterial color={CHAIR_BROWN} roughness={0.75} />
      </RoundedBox>
      {[
        [-0.19, -0.19],
        [0.19, -0.19],
        [-0.19, 0.19],
        [0.19, 0.19],
      ].map(([x, z]) => (
        <mesh key={`${x}${z}`} position={[x, 0.2, z]} castShadow>
          <boxGeometry args={[0.06, 0.4, 0.06]} />
          <meshStandardMaterial color="#16110d" roughness={0.85} />
        </mesh>
      ))}
    </group>
  );
}

/* ─────────────────────────────── 가구 충돌 ─────────────────────────────── */

/** 플레이어 몸통 반지름 — 이만큼 가구에서 밀려난다 */
const PLAYER_R = 0.35;
/** 이보다 낮은 턱은 막지 않고 그냥 지나간다 (낮은 탁자). 걸려서 멈추면 답답하다 */
const STEP_UP = 0.55;

/**
 * 가구 충돌용 회전 박스(footprint). Warehouse()·Furniture() 배치를 그대로 옮겼다.
 * 거기 좌표를 고치면 여기도 같이 고친다. hw/hd 는 반폭·반깊이.
 * top 은 윗면 높이 — 막는 높이이자 **올라섰을 때 발이 닿는 높이**다.
 */
const COLLIDERS: {
  x: number;
  z: number;
  hw: number;
  hd: number;
  rot: number;
  top: number;
}[] = [
  // 소파 (팔걸이 포함 폭 / 등받이 윗면)
  { x: -4.4, z: -8.2, hw: 1.5, hd: 0.62, rot: 0.12, top: 0.99 },
  { x: 0.2, z: -7.4, hw: 1.5, hd: 0.62, rot: 0, top: 0.99 },
  { x: 4.8, z: -8, hw: 1.5, hd: 0.62, rot: -0.12, top: 0.99 },
  { x: -7.8, z: -6.6, hw: 1.5, hd: 0.62, rot: 0.5, top: 0.99 },
  { x: 7.9, z: -6.4, hw: 1.5, hd: 0.62, rot: -0.5, top: 0.99 },
  // 낮은 탁자 (STEP_UP 아래 — 걸어서 올라간다)
  { x: -4.2, z: -6.7, hw: 0.9, hd: 0.5, rot: 0, top: 0.5 },
  { x: 0.4, z: -5.9, hw: 0.9, hd: 0.5, rot: 0, top: 0.5 },
  { x: 4.7, z: -6.5, hw: 0.75, hd: 0.5, rot: 0, top: 0.5 },
  // 식탁 세트 (의자까지 한 덩어리 / 상판 윗면)
  { x: -7.6, z: -1.6, hw: 0.8, hd: 1.3, rot: 0.15, top: 0.81 },
  { x: -6.9, z: 3, hw: 0.8, hd: 1.3, rot: -0.2, top: 0.81 },
  { x: 0.1, z: 1.4, hw: 0.8, hd: 1.3, rot: 0.05, top: 0.81 },
  { x: 7.2, z: -1.9, hw: 0.8, hd: 1.3, rot: -0.12, top: 0.81 },
  { x: 6.6, z: 3.1, hw: 0.8, hd: 1.3, rot: 0.25, top: 0.81 },
  // 좌우 벽의 랙 (90° 돌아간 것만 — 스크린 옆 랙은 이동 한계 밖이다)
  { x: -(HALF_W - 0.75), z: -8.5, hw: 0.55, hd: 1.45, rot: 0, top: 4.4 },
  { x: HALF_W - 0.75, z: -8.5, hw: 0.55, hd: 1.45, rot: 0, top: 4.4 },
  { x: -(HALF_W - 0.75), z: -4.8, hw: 0.55, hd: 1.45, rot: 0, top: 4.4 },
  { x: HALF_W - 0.75, z: -4.8, hw: 0.55, hd: 1.45, rot: 0, top: 4.4 },
  // 장비 케이스
  { x: HALF_W - 1.3, z: 1.6, hw: 0.7, hd: 0.45, rot: 0, top: 1.3 },
  { x: HALF_W - 1.2, z: 3.2, hw: 0.55, hd: 0.45, rot: 0, top: 0.9 },
  { x: HALF_W - 2.6, z: 2.4, hw: 0.5, hd: 0.45, rot: 0, top: 1.05 },
  { x: -HALF_W + 1.3, z: 2.2, hw: 0.65, hd: 0.45, rot: 0, top: 1.15 },
];

/** 월드 좌표를 가구 로컬(rotation-y 역회전)로 옮긴다. lx = 폭 방향, lz = 깊이 방향 */
function toLocal(
  c: (typeof COLLIDERS)[number],
  x: number,
  z: number,
): [number, number] {
  const cos = Math.cos(c.rot);
  const sin = Math.sin(c.rot);
  const dx = x - c.x;
  const dz = z - c.z;
  return [dx * cos - dz * sin, dx * sin + dz * cos];
}

/**
 * 박스 하나하나에 대해: 플레이어 위치를 가구 로컬 좌표로 돌려 넣고,
 * 겹쳤으면 얕게 파고든 축으로 밀어낸다. 벽처럼 미끄러지는 느낌이 난다.
 *
 * 발(feetY)이 윗면보다 높으면 막지 않는다 — 뛰어넘거나 위에 올라선 상태다.
 */
export function resolveColliders(p: THREE.Vector3, feetY: number) {
  for (const c of COLLIDERS) {
    if (feetY >= c.top - 0.02 || c.top - feetY <= STEP_UP) continue;
    const [lx0, lz0] = toLocal(c, p.x, p.z);
    let lx = lx0;
    let lz = lz0;
    const ex = c.hw + PLAYER_R;
    const ez = c.hd + PLAYER_R;
    if (Math.abs(lx) >= ex || Math.abs(lz) >= ez) continue;
    if (ex - Math.abs(lx) < ez - Math.abs(lz)) {
      lx = Math.sign(lx || 1) * ex;
    } else {
      lz = Math.sign(lz || 1) * ez;
    }
    // 로컬 → 월드
    const cos = Math.cos(c.rot);
    const sin = Math.sin(c.rot);
    p.x = c.x + lx * cos + lz * sin;
    p.z = c.z - lx * sin + lz * cos;
  }
}
