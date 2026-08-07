'use client';

/**
 * 로봇 스프라이트 굽는 대 (/world/sprite). 소유: 원상 (app/world/)
 *
 * ┌─ 왜 있나 ──────────────────────────────────────────────────────────────┐
 * │ 대기방 좌석 카드에 **월드와 같은 로봇**을 넣기로 했다 (2026-08-07).     │
 * │ 그런데 카드는 여덟 개고 전부 같은 그림이다 — 여덟 칸에 <Canvas> 를      │
 * │ 하나씩 세우면 WebGL 컨텍스트가 여덟 개고, 지금 3D 의존이 0인 대기방에   │
 * │ three 번들과 glb 1.2MB 가 통째로 들어온다. **움직이지도 않을 그림에     │
 * │ 치를 값이 아니다.**                                                     │
 * │                                                                        │
 * │ 그래서 여기서 한 번 굽고, 대기방은 그 PNG 만 쓴다. 이 페이지는          │
 * │ **개발용이다** — 배포본에서 아무도 안 열고, 열려도 게임에 영향이 없다.  │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 쓰는 법 ──────────────────────────────────────────────────────────────┐
 * │ 1. 포즈·각도·조명을 맞춘다 (오른쪽 손잡이들)                            │
 * │ 2. 아래 「좌석 카드에 대보기」로 실제 카드 안에서 확인한다              │
 * │ 3. 「PNG 저장」 → public/room/ 에 넣는다                                │
 * │ 4. 준비 전/후 두 컷을 뽑는다. 이 리그에는 **얼굴이 없어서**(avatar.tsx  │
 * │    머리말: 블렌드셰이프도 얼굴 본도 없는 41본) 표정으로는 상태를 못     │
 * │    만든다 — 포즈와 조명이 그 일을 한다.                                 │
 * │ 5. 쓴 값을 아래 「기록」 블록에서 복사해 대기방 주석에 남긴다.           │
 * │    다시 구울 때 같은 그림이 나와야 한다.                                │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 캔버스 크기 = 출력 크기다. 화면에서는 CSS 로 줄여 보여줄 뿐이라, 보이는
 *   그대로가 저장된다. 따로 고해상도로 다시 렌더하는 경로를 두면 그 경로에서만
 *   프레이밍이 어긋나는 사고가 난다.
 * ★ preserveDrawingBuffer 가 없으면 toDataURL 이 **빈 이미지**를 준다.
 *   브라우저가 그린 직후 버퍼를 비우기 때문이다.
 */

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';

import { AVATAR_MODEL } from '../avatar';

/**
 * 아바타 키(m). **avatar.tsx 의 TARGET_HEIGHT 와 같은 값이어야 한다.**
 * 여기서 다르게 잡으면 스프라이트 속 로봇과 월드 속 로봇의 두상 비율이 어긋나,
 * 대기방에서 본 것과 게임에서 만나는 것이 미묘하게 다른 캐릭터가 된다.
 */
const TARGET_HEIGHT = 1.72;

type Preset = {
  label: string;
  clip: string;
  /** 클립 길이에 대한 비율(0~1). 클립 길이가 바뀌어도 같은 자리를 가리키게 */
  at: number;
  yaw: number;
  pitch: number;
  dist: number;
  targetY: number;
  fov: number;
};

/**
 * 시작 자리 두 개. **정답이 아니라 출발점이다** — 눈으로 보고 고치라고 둔 값이다.
 *
 * 준비 전은 정면에 가깝고 낮게(위축돼 보인다), 준비 완료는 살짝 틀어 올려본다
 * (같은 로봇인데 자세가 선다). 클립은 셋뿐이라(idle · walk · jump) 고를 게 많지 않다.
 */
const PRESETS: Preset[] = [
  { label: '준비 전', clip: 'idle', at: 0, yaw: 8, pitch: 6, dist: 3.1, targetY: 1.0, fov: 30 },
  { label: '준비 완료', clip: 'jump', at: 0.45, yaw: 20, pitch: 4, dist: 3.0, targetY: 1.05, fov: 30 },
];

/* ────────────────────────────── 3D ────────────────────────────── */

function Robot({
  clip,
  at,
  onClips,
}: {
  clip: string;
  /** 클립 안의 위치(0~1) */
  at: number;
  onClips: (info: { name: string; duration: number }[]) => void;
}) {
  const gltf = useGLTF(AVATAR_MODEL);

  // useGLTF 는 파일당 인스턴스 하나를 캐시한다. 그대로 쓰면 /world 와 뼈대를 나눠 갖는다
  const scene = useMemo(() => cloneSkeleton(gltf.scene), [gltf.scene]);

  /*
   * 크기 정규화 + 발 맞추기. 재는 방법은 avatar.tsx 와 **같아야 한다** —
   * 이 파일은 양자화돼 있어(KHR_mesh_quantization) 기하만 재면 2.0 이 나오고
   * 로봇이 절반 크기가 된다. updateMatrixWorld(true) 를 먼저 부르는 이유도 거기 있다.
   *
   * lift 는 여기만의 것이다: 월드는 발밑이 바닥이지만 여기는 카메라만 있어서,
   * 발을 y=0 에 붙여 놔야 targetY 를 "지면에서 몇 m" 로 읽을 수 있다.
   */
  const { scale, lift } = useMemo(() => {
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene);
    const h = box.max.y - box.min.y;
    if (!Number.isFinite(h) || h <= 1e-4) return { scale: 1, lift: 0 };
    const s = TARGET_HEIGHT / h;
    return { scale: s, lift: -box.min.y * s };
  }, [scene]);

  const mixer = useMemo(() => new THREE.AnimationMixer(scene), [scene]);

  // 클립 목록은 한 번만 위로 올린다 (길이를 손잡이가 알아야 한다)
  useEffect(() => {
    onClips(gltf.animations.map((c) => ({ name: c.name, duration: c.duration })));
  }, [gltf.animations, onClips]);

  /*
   * 자세를 **한 프레임에 고정**한다. 재생이 아니라 정지된 포즈가 필요하므로
   * paused 로 세워 두고 time 만 옮긴다. useFrame 에서 매번 액션을 새로 만들면
   * 믹서 장부가 깨지므로(avatar.tsx 의 _cacheIndex 주석) 값이 바뀔 때만 손댄다.
   */
  useEffect(() => {
    const source = gltf.animations.find((c) => c.name === clip) ?? gltf.animations[0];
    if (!source) return;
    mixer.stopAllAction();
    const action = mixer.clipAction(source);
    action.reset();
    action.play();
    action.paused = true;
    action.time = Math.max(0, Math.min(at, 0.999) * source.duration);
    mixer.update(0);
  }, [gltf.animations, mixer, clip, at]);

  return (
    <group position-y={lift} scale={scale}>
      {/* 이 모델은 +z 가 정면이다 (avatar.tsx — 걷기 클립이 +z 로 전진한다) */}
      <primitive object={scene} rotation-y={0} />
    </group>
  );
}

/** 카메라를 구면 좌표로 앉힌다. 손잡이 값이 그대로 숫자로 남아야 다시 구울 수 있다 */
function Rig({
  yaw,
  pitch,
  dist,
  targetY,
  fov,
}: {
  yaw: number;
  pitch: number;
  dist: number;
  targetY: number;
  fov: number;
}) {
  const camera = useThree((s) => s.camera);

  useEffect(() => {
    const y = (yaw * Math.PI) / 180;
    const p = (pitch * Math.PI) / 180;
    camera.position.set(
      dist * Math.sin(y) * Math.cos(p),
      targetY + dist * Math.sin(p),
      dist * Math.cos(y) * Math.cos(p),
    );
    camera.lookAt(0, targetY, 0);
    const persp = camera as THREE.PerspectiveCamera;
    if (persp.isPerspectiveCamera) persp.fov = fov;
    camera.updateProjectionMatrix();
  }, [camera, yaw, pitch, dist, targetY, fov]);

  return null;
}

/** 매 프레임 그린다. 포즈가 정지라 한 장이면 충분하지만, 손잡이를 돌릴 때 즉시 따라와야 한다 */
function Spin() {
  useFrame(() => {});
  return null;
}

/* ───────────────────────────── 손잡이 ───────────────────────────── */

function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label style={{ display: 'grid', gridTemplateColumns: '4.6rem 1fr 3.4rem', gap: '0.6rem', alignItems: 'center' }}>
      <span style={{ fontSize: '0.72rem', color: '#8b97a2' }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: '#00ff66' }}
      />
      <span
        style={{
          fontSize: '0.7rem',
          fontVariantNumeric: 'tabular-nums',
          textAlign: 'right',
          color: '#e3e7ea',
        }}
      >
        {value.toFixed(step < 1 ? 2 : 0)}
        {unit ?? ''}
      </span>
    </label>
  );
}

/* ────────────────────────────── 화면 ────────────────────────────── */

export default function RobotSpritePage() {
  // 출력 크기 = 캔버스 크기. 좌석 카드 비율(4 : 3.1)에 맞춘 기본값이다
  const [w, setW] = useState(800);
  const [h, setH] = useState(620);

  const [clip, setClip] = useState(PRESETS[0].clip);
  const [at, setAt] = useState(PRESETS[0].at);
  const [yaw, setYaw] = useState(PRESETS[0].yaw);
  const [pitch, setPitch] = useState(PRESETS[0].pitch);
  const [dist, setDist] = useState(PRESETS[0].dist);
  const [targetY, setTargetY] = useState(PRESETS[0].targetY);
  const [fov, setFov] = useState(PRESETS[0].fov);

  const [keyI, setKeyI] = useState(2.4);
  const [rimI, setRimI] = useState(3.2);
  const [rimColor, setRimColor] = useState('#00ff66');
  const [fillI, setFillI] = useState(0.5);
  const [ambI, setAmbI] = useState(0.35);

  const [clips, setClips] = useState<{ name: string; duration: number }[]>([]);
  const [name, setName] = useState('robot-idle');

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [shot, setShot] = useState<string | null>(null);

  const duration = clips.find((c) => c.name === clip)?.duration ?? 0;

  /*
   * 손잡이가 멎으면 한 장 떠서 아래 카드 미리보기에 쓴다.
   * 매 프레임 toDataURL 을 부르면 GPU→CPU 로 화면을 통째로 내리는 짓이라 뚝뚝 끊긴다.
   */
  useEffect(() => {
    const t = setTimeout(() => {
      const c = canvasRef.current;
      if (c) setShot(c.toDataURL('image/png'));
    }, 280);
    return () => clearTimeout(t);
  }, [clip, at, yaw, pitch, dist, targetY, fov, keyI, rimI, rimColor, fillI, ambI, w, h]);

  const applyPreset = (p: Preset) => {
    setClip(p.clip);
    setAt(p.at);
    setYaw(p.yaw);
    setPitch(p.pitch);
    setDist(p.dist);
    setTargetY(p.targetY);
    setFov(p.fov);
    setName(p.label === '준비 전' ? 'robot-idle' : 'robot-ready');
  };

  const save = () => {
    const c = canvasRef.current;
    if (!c) return;
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png');
    a.download = `${name || 'robot'}.png`;
    a.click();
  };

  const record = `clip=${clip} at=${at.toFixed(2)} yaw=${yaw} pitch=${pitch} dist=${dist.toFixed(2)} targetY=${targetY.toFixed(2)} fov=${fov} / key=${keyI.toFixed(1)} rim=${rimI.toFixed(1)}${rimColor} fill=${fillI.toFixed(1)} amb=${ambI.toFixed(2)} / ${w}×${h}`;

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#05070a',
        color: '#e3e7ea',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        padding: '1.6rem',
      }}
    >
      <header style={{ marginBottom: '1.4rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700 }}>로봇 스프라이트 굽는 대</h1>
        <p style={{ margin: '0.35rem 0 0', fontSize: '0.8rem', color: '#737f8b' }}>
          /world 의 robot.glb 를 대기방 좌석 카드에 쓸 PNG 로 뽑는다. 배경은 투명하다.
        </p>
      </header>

      <div style={{ display: 'flex', gap: '1.6rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* ── 캔버스 ─────────────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
          <div
            style={{
              width: 420,
              // 투명한 곳을 눈으로 확인할 체커보드
              backgroundColor: '#0f1216',
              backgroundImage:
                'linear-gradient(45deg,#1a1f25 25%,transparent 25%),linear-gradient(-45deg,#1a1f25 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#1a1f25 75%),linear-gradient(-45deg,transparent 75%,#1a1f25 75%)',
              backgroundSize: '16px 16px',
              backgroundPosition: '0 0,0 8px,8px -8px,-8px 0',
              borderRadius: 8,
              overflow: 'hidden',
              boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.1)',
            }}
          >
            {/*
              ★ 캔버스의 픽셀 크기가 곧 저장 크기다. CSS 로만 줄여 보여준다.
              ★ dpr 을 1 로 못 박는다. 안 그러면 레티나에서 캔버스가 2배로 커져
                저장 파일이 1600×1240 이 되고, 화면에서 맞춘 프레이밍과 어긋난다.
            */}
            <Canvas
              style={{ width: 420, height: (420 * h) / w, display: 'block' }}
              dpr={1}
              gl={{ preserveDrawingBuffer: true, alpha: true, antialias: true }}
              camera={{ fov, near: 0.1, far: 100 }}
              onCreated={({ gl }) => {
                canvasRef.current = gl.domElement;
                gl.setSize(w, h, false);
                gl.setClearAlpha(0);
              }}
            >
              <ambientLight intensity={ambI} />
              {/* 키 — 앞 위 오른쪽. 형태를 만드는 빛 */}
              <directionalLight position={[2.6, 3.4, 3.2]} intensity={keyI} />
              {/* 림 — 뒤 왼쪽에서 윤곽을 긋는다. 대기방 형광 초록이 여기서 들어온다 */}
              <directionalLight position={[-2.8, 2.2, -2.6]} intensity={rimI} color={rimColor} />
              {/* 필 — 그늘이 새까매지지 않을 만큼만, 차갑게 */}
              <directionalLight position={[-2.2, 0.6, 2.4]} intensity={fillI} color="#7fa8c8" />

              <Rig yaw={yaw} pitch={pitch} dist={dist} targetY={targetY} fov={fov} />
              <Spin />
              <Suspense fallback={null}>
                <Robot clip={clip} at={at} onClips={setClips} />
              </Suspense>
            </Canvas>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{
                flex: 1,
                background: '#0f1216',
                border: '1px solid rgba(255,255,255,.12)',
                borderRadius: 5,
                color: '#e3e7ea',
                padding: '0.45rem 0.6rem',
                fontSize: '0.78rem',
              }}
            />
            <button
              type="button"
              onClick={save}
              style={{
                background: 'rgba(0,255,102,.12)',
                border: '1px solid rgba(0,255,102,.5)',
                borderRadius: 5,
                color: '#00ff66',
                padding: '0.45rem 0.9rem',
                fontSize: '0.78rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              PNG 저장
            </button>
          </div>

          <p style={{ margin: 0, fontSize: '0.7rem', color: '#4c5862' }}>
            저장 크기 {w}×{h} · 화면에서는 420px 로 줄여 보여준다
          </p>
        </div>

        {/* ── 손잡이 ─────────────────────────────────────────────── */}
        <div style={{ flex: 1, minWidth: 320, display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
          <section style={{ display: 'flex', gap: '0.5rem' }}>
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => applyPreset(p)}
                style={{
                  background: '#161b21',
                  border: '1px solid rgba(255,255,255,.12)',
                  borderRadius: 5,
                  color: '#e3e7ea',
                  padding: '0.45rem 0.85rem',
                  fontSize: '0.76rem',
                  cursor: 'pointer',
                }}
              >
                {p.label}
              </button>
            ))}
          </section>

          <section style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <h2 style={{ margin: 0, fontSize: '0.68rem', letterSpacing: '.16em', color: '#4c5862' }}>포즈</h2>
            <div style={{ display: 'flex', gap: '0.4rem' }}>
              {clips.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => setClip(c.name)}
                  style={{
                    background: clip === c.name ? 'rgba(0,255,102,.12)' : '#12161b',
                    border: `1px solid ${clip === c.name ? 'rgba(0,255,102,.5)' : 'rgba(255,255,255,.1)'}`,
                    borderRadius: 4,
                    color: clip === c.name ? '#00ff66' : '#8b97a2',
                    padding: '0.3rem 0.7rem',
                    fontSize: '0.72rem',
                    cursor: 'pointer',
                  }}
                >
                  {c.name}
                  <span style={{ opacity: 0.5 }}> {c.duration.toFixed(2)}s</span>
                </button>
              ))}
              {clips.length === 0 && (
                <span style={{ fontSize: '0.72rem', color: '#4c5862' }}>모델 받는 중…</span>
              )}
            </div>
            <Slider label="프레임" value={at} min={0} max={0.999} step={0.005} onChange={setAt} />
            <p style={{ margin: 0, fontSize: '0.68rem', color: '#4c5862' }}>
              {duration > 0 ? `${(at * duration).toFixed(2)}s / ${duration.toFixed(2)}s` : '—'}
            </p>
          </section>

          <section style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <h2 style={{ margin: 0, fontSize: '0.68rem', letterSpacing: '.16em', color: '#4c5862' }}>카메라</h2>
            <Slider label="회전" value={yaw} min={-180} max={180} step={1} unit="°" onChange={setYaw} />
            <Slider label="올려봄" value={pitch} min={-25} max={45} step={1} unit="°" onChange={setPitch} />
            <Slider label="거리" value={dist} min={1.2} max={7} step={0.05} unit="m" onChange={setDist} />
            <Slider label="높이" value={targetY} min={0} max={2} step={0.01} unit="m" onChange={setTargetY} />
            <Slider label="화각" value={fov} min={12} max={60} step={1} unit="°" onChange={setFov} />
          </section>

          <section style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <h2 style={{ margin: 0, fontSize: '0.68rem', letterSpacing: '.16em', color: '#4c5862' }}>조명</h2>
            <Slider label="키" value={keyI} min={0} max={6} step={0.1} onChange={setKeyI} />
            <Slider label="림" value={rimI} min={0} max={8} step={0.1} onChange={setRimI} />
            <label style={{ display: 'grid', gridTemplateColumns: '4.6rem 1fr', gap: '0.6rem', alignItems: 'center' }}>
              <span style={{ fontSize: '0.72rem', color: '#8b97a2' }}>림 색</span>
              <input type="color" value={rimColor} onChange={(e) => setRimColor(e.target.value)} />
            </label>
            <Slider label="필" value={fillI} min={0} max={3} step={0.1} onChange={setFillI} />
            <Slider label="환경" value={ambI} min={0} max={2} step={0.05} onChange={setAmbI} />
          </section>

          <section style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <h2 style={{ margin: 0, fontSize: '0.68rem', letterSpacing: '.16em', color: '#4c5862' }}>출력 크기</h2>
            <Slider label="가로" value={w} min={200} max={1600} step={20} unit="px" onChange={setW} />
            <Slider label="세로" value={h} min={200} max={1600} step={20} unit="px" onChange={setH} />
          </section>
        </div>

        {/* ── 좌석 카드에 대보기 ─────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
          <h2 style={{ margin: 0, fontSize: '0.68rem', letterSpacing: '.16em', color: '#4c5862' }}>
            좌석 카드에 대보기
          </h2>
          <div style={{ display: 'flex', gap: '0.6rem' }}>
            <CardPreview shot={shot} label="익명2" dim />
            <CardPreview shot={shot} label="유경" me />
          </div>
          <p style={{ margin: 0, maxWidth: 300, fontSize: '0.7rem', lineHeight: 1.7, color: '#4c5862' }}>
            왼쪽이 준비 전(한 겹 어둡다), 오른쪽이 내 자리다. 카드 안에서 잘리는 곳이 있으면
            <strong style={{ color: '#8b97a2' }}> 거리·높이</strong>로 맞춘다 — 출력 크기를 키워도 프레이밍은 안 바뀐다.
          </p>
        </div>
      </div>

      {/* ── 기록 ─────────────────────────────────────────────────── */}
      <section style={{ marginTop: '1.8rem' }}>
        <h2 style={{ margin: '0 0 0.4rem', fontSize: '0.68rem', letterSpacing: '.16em', color: '#4c5862' }}>
          기록 — 대기방 주석에 남길 값
        </h2>
        <code
          style={{
            display: 'block',
            padding: '0.7rem 0.9rem',
            background: '#0f1216',
            borderRadius: 5,
            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.08)',
            fontSize: '0.72rem',
            color: '#93a2ae',
            overflowX: 'auto',
            whiteSpace: 'nowrap',
          }}
        >
          {record}
        </code>
      </section>
    </div>
  );
}

/**
 * 실제 좌석 카드 한 칸. room-lobby.module.css 의 .slot 을 **눈으로 맞춘 사본**이다.
 *
 * ★ 여기서 카드 모양을 고치지 말 것. 이건 확인용이고 진짜 카드는 그쪽 파일에 있다 —
 *   둘이 갈리면 여기서 맞춰 구운 그림이 대기방에서 다르게 잘린다.
 */
function CardPreview({
  shot,
  label,
  me = false,
  dim = false,
}: {
  shot: string | null;
  label: string;
  me?: boolean;
  dim?: boolean;
}) {
  return (
    <div
      style={{
        position: 'relative',
        width: 150,
        aspectRatio: '4 / 3.1',
        borderRadius: 8,
        padding: 1,
        overflow: 'hidden',
        backgroundColor: me ? 'rgba(0,255,102,.32)' : 'rgba(255,255,255,.13)',
        backgroundImage: [0, 100].
          flatMap((x) => [0, 100].map((y) => `radial-gradient(90px 90px at ${x}% ${y}%, ${me ? 'rgba(0,255,102,.9)' : 'rgba(255,255,255,.34)'}, transparent 70%)`))
          .join(','),
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 1,
          borderRadius: 7,
          overflow: 'hidden',
          background: 'linear-gradient(180deg,#0c0f13,#07090b)',
          filter: dim ? 'brightness(.58) saturate(.55)' : undefined,
        }}
      >
        {shot && (
          /*
           * next/image 를 쓰지 않는다. 여기 src 는 캔버스에서 방금 뽑은 data: URL 이라
           * 최적화기가 손댈 게 없고(원본이 곧 최종이다), loader 를 태우면 개발 서버에서
           * 매번 실패한다. 저장될 그림을 **그대로** 보여주는 게 이 미리보기의 일이다.
           */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={shot}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        )}
      </div>
      <div
        style={{
          position: 'absolute',
          left: 1,
          right: 1,
          bottom: 1,
          height: '44%',
          borderRadius: '0 0 7px 7px',
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'center',
          paddingBottom: '0.4rem',
          background:
            'linear-gradient(180deg, transparent, rgba(3,5,7,.82) 58%, rgba(3,5,7,.96))',
          fontSize: '0.72rem',
          fontWeight: 600,
          color: me ? '#00ff66' : '#e3e7ea',
        }}
      >
        {label}
      </div>
    </div>
  );
}
