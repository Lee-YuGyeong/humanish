'use client';

/**
 * 3D 아바타 — 리깅된 사무직 캐릭터 둘. 소유: 원상 (/world)
 *
 * ┌─ 어떻게 만들어졌나 ────────────────────────────────────────────────────┐
 * │ 원본은 3d_model/office+worker+3d+model_{man,Girl}.glb (각 75MB, 190만  │
 * │ 삼각형, 뼈대만 있고 클립 없음). 그대로는 웹에 못 올린다.               │
 * │   1. 감면·텍스처 축소 — 27k 삼각형 / 1.2MB (gltf-transform)            │
 * │   2. 리깅 + 클립 — Higgsfield(Meshy) 3d_rigging 을 클립마다 한 번씩     │
 * │      (idle 0 · Casual_Walk 30 · RunFast 16 · Regular_Jump 466)         │
 * │   3. 클립 합치기 — tools/merge-glb-anims.mjs 로 네 파일의 트랙만 모아   │
 * │      메시 한 벌에 붙인다 (안 그러면 같은 메시가 네 벌 실린다)          │
 * │   4. webp + 양자화 — public/world/office-{man,girl}.glb, 각 ~0.9MB     │
 * │ 다시 만들려면 이 순서를 그대로 밟는다. 원본은 저장소에 두지 않는다.    │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 표정(눈 깜빡임·입·눈썹)은 넣지 않았다. 두 모델 다 **블렌드셰이프가 없고**
 *   뼈대에도 얼굴 본이 없다(24본: 다리·척추·목·머리·팔·손뿐). 없는 걸 있는 척
 *   흉내 내는 대신, 이 카메라 거리에서 실제로 읽히는 것 — 호흡과 미세한 무게
 *   중심 이동 — 만 코드로 얹었다. 진짜 깜빡임이 필요하면 모델에 ARKit 계열
 *   모프(eyeBlinkLeft/Right)가 있어야 한다.
 *
 * ★ 누가 어떤 캐릭터인지는 **player.id 해시**로 정한다. 모든 클라이언트가 같은
 *   id 를 받으므로 내 화면과 남의 화면에서 같은 사람이 같은 모습이다.
 *   좌석 번호로 정하지 않는다 — 자리는 게임 시작 때 다시 섞인다.
 */

import { useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
// three 0.185 는 이 모듈을 이름별로 내보낸다 (SkeletonUtils 네임스페이스가 아니다)
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';

import type { AnimState } from '@/lib/mp/protocol';

export const AVATAR_MODELS = ['/world/office-man.glb', '/world/office-girl.glb'] as const;

/** 아바타 키(m). 씬의 EYE_HEIGHT(1.6)와 눈높이가 맞도록 이 값으로 정규화한다 */
const TARGET_HEIGHT = 1.72;

/** 클립 사이 넘어가는 시간(초). 짧으면 툭툭 끊기고 길면 미끄러진다 */
const FADE = 0.2;

/**
 * idle 일 때 머리·목을 바인드(정면) 쪽으로 얼마나 되돌릴지. 0=클립 그대로,
 * 1=완전 고정. 0.65면 고개 젓는 폭이 1/3로 줄어 '두리번'이 '가만히'가 된다.
 */
const HEAD_CALM = 0.65;

type ClipName = 'idle' | 'walk' | 'run' | 'jump';

/**
 * 클립 재생 배속. **에셋에서 직접 재고, 이동 속도에서 역산한 값이다.**
 *
 *   측정: walk 1.43걸음/초 · run 4.29걸음/초 (허벅지 회전의 왕복 주기)
 *   속도: WALK_SPEED 2.6m/s · RUN_SPEED 5.0m/s (lib/mp/constants.ts)
 *   보폭을 걷기 0.95m · 달리기 1.35m 로 잡으면 필요한 걸음 수는 2.74 · 3.70/초,
 *   그래서 배속은 1.9 · 0.86 이다.
 *
 * 이 값이 1 이면 몸은 나아가는데 다리가 안 따라와 **발이 얼음판처럼 미끄러진다.**
 * 속도 상수를 바꾸면 여기도 같이 본다.
 */
const CADENCE_SCALE: Record<'walk' | 'run', number> = { walk: 1.9, run: 0.86 };

/**
 * id → 0 | 1. 문자열 해시라 클라이언트마다 같은 값이 나온다.
 * (Math.random 을 쓰면 새로 고칠 때마다 성별이 바뀐다)
 */
export function avatarVariant(id: string): 0 | 1 {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 2) as 0 | 1;
}

export function Avatar({
  variant,
  anim,
  airborne,
}: {
  variant: 0 | 1;
  anim: AnimState;
  /** 공중에 떠 있나. 점프 클립을 켜는 조건이다 (높이로만 판단 — protocol.ts 주석) */
  airborne: boolean;
}) {
  const gltf = useGLTF(AVATAR_MODELS[variant]);

  /*
   * ★ 씬을 그대로 쓰면 안 된다. useGLTF 는 같은 파일에 하나의 인스턴스를 캐시하므로
   *   여러 명이 같은 뼈대를 공유해 **한 사람이 걸으면 전원이 같이 걷는다.**
   *   SkeletonUtils.clone 은 스킨 메시와 뼈대를 짝지어 복제한다 (object3d.clone 은 못 한다).
   */
  const scene = useMemo(() => cloneSkeleton(gltf.scene), [gltf.scene]);

  /**
   * 머리·목 진정용 바인드 포즈. **믹서가 돌기 전인 지금**(갓 복제한 씬) 잡아야
   * 클립이 흔들어 놓기 전의 '정면을 본 자세'가 들어온다. useFrame 첫 프레임에
   * 잡으면 이미 idle 클립 t=0 값이라 소용없다.
   *
   * idle 클립이 고개를 크게 좌우로 젓는다 — 이 자세로 일부 되돌려 진폭만 줄인다
   * (완전히 고정하면 오히려 뻣뻣해진다).
   */
  const restBones = useMemo(() => {
    const out: { bone: THREE.Object3D; q: THREE.Quaternion }[] = [];
    // 리그마다 'Head' · 'mixamorigHead' 처럼 이름이 다를 수 있어 포함 여부로 찾는다.
    scene.traverse((o) => {
      const n = o.name.toLowerCase();
      if (n.includes('head') || n.includes('neck')) {
        out.push({ bone: o, q: o.quaternion.clone() });
      }
    });
    return out;
  }, [scene]);

  /**
   * 모델마다 실제 키가 달라서 파일에 손대지 않고 여기서 맞춘다.
   *
   * ★ updateMatrixWorld(true) 를 **반드시 먼저** 부른다. Box3.setFromObject 는
   *   자기 자신의 행렬만 갱신하고(updateWorldMatrix(false,false)) 자식은 각자
   *   matrixWorld 를 그대로 쓴다. 갓 복제한 씬은 그 값이 아직 단위행렬이라,
   *   빼먹으면 엉뚱한 크기가 나온다 — 실제로 이 리그(0.01 스케일 노드가 달려 있어
   *   원본이 1.75cm 로 그려진다)에서 아바타가 방보다 커졌다.
   */
  const scale = useMemo(() => {
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene);
    const h = box.max.y - box.min.y;
    // 뼈대만 있고 메시가 안 잡히는 등 이상하면 1 로 두고 눈에 띄게 남긴다
    if (!Number.isFinite(h) || h <= 1e-4) return 1;
    return TARGET_HEIGHT / h;
  }, [scene]);

  /*
   * ┌─ 팔은 손대지 않는다 ──────────────────────────────────────────────────┐
   * │ 한동안 '팔 내리기 보정'(어깨에 고정 쿼터니언을 매 프레임 곱하기)을 넣어 │
   * │ 뒀는데, 그게 팔이 이상해 보인 **원인**이었다. 클립을 직접 재보면 이미   │
   * │ 팔을 내리고 있다 — office-man.glb 의 walk 에서 위팔은 수직에서 27~31°, │
   * │ 아래팔은 31~33° 로 몸 옆에 붙어 있고 한 걸음마다 21° 씩 앞뒤로 흔든다.  │
   * │ (뼈대 원본은 T 자세라 **바인드 포즈만 보면** 팔을 벌린 것처럼 보인다 —  │
   * │  거기에 속아서 보정을 넣었다.)                                        │
   * │                                                                      │
   * │ 그 위에 보정을 또 얹으면 (1) 팔이 몸에 파묻히고 (2) 클립의 앞뒤 스윙이  │
   * │ 고정축에 눌려 사라지며 (3) 첫 프레임이 아직 바인드 자세일 때 계산되면   │
   * │ 축이 통째로 어긋나 **한쪽 팔이 하늘로 뻗는다**. 실제로 그 장면을 봤다.  │
   * │                                                                      │
   * │ 결론: 클립이 이미 맞다. 팔 자세가 어색하면 코드가 아니라 클립을 고친다. │
   * └──────────────────────────────────────────────────────────────────────┘
   */

  const mixer = useMemo(() => new THREE.AnimationMixer(scene), [scene]);
  const actions = useMemo(() => {
    const map = {} as Record<ClipName, THREE.AnimationAction | undefined>;
    for (const source of gltf.animations) {
      const name = source.name as ClipName;

      /*
       * ★ 점프 클립에는 **루트 모션이 들어 있다** — Hips 가 클립 안에서 1m 넘게 솟는다.
       *   그런데 이 월드에서 높이는 물리가 만든다(JUMP_SPEED/GRAVITY 로 최고 1.05m).
       *   그대로 두면 둘이 더해져 2m 를 뛰고, 내려올 때는 바닥을 뚫는 것처럼 보인다.
       *   그래서 Hips 의 **위치 트랙만** 떼어낸다. 회전(자세)은 그대로 살아 있다.
       *   원본 클립은 useGLTF 캐시라 여러 명이 공유한다 — 반드시 복제해서 손댄다.
       */
      const clip =
        name === 'jump'
          ? new THREE.AnimationClip(
              source.name,
              source.duration,
              source.tracks.filter((t) => t.name !== 'Hips.position'),
            )
          : source;

      const action = mixer.clipAction(clip);

      if (name === 'jump') {
        // 점프는 한 번만 돌고 마지막 자세에서 멈춘다. 착지하면 걷기/서기로 넘어간다
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      /*
       * ★ 걸음 수를 이동 속도에 맞춘다. 안 맞추면 **발이 미끄러진다** — 몸은 2.6m/s 로
       *   나아가는데 다리는 1.43걸음/초라 한 걸음에 1.8m 를 벌리는 꼴이 된다.
       *   아래 값은 이 에셋에서 직접 잰 것이다(허벅지 회전의 왕복 주기).
       */
      if (name === 'walk' || name === 'run') action.timeScale = CADENCE_SCALE[name];

      map[name] = action;
    }
    return map;
  }, [gltf.animations, mixer]);

  const current = useRef<ClipName | null>(null);

  useEffect(() => {
    // 컴포넌트가 사라질 때 믹서가 남으면 그만큼 매 프레임 계산이 새어 나간다
    return () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(scene);
    };
  }, [mixer, scene]);

  useEffect(() => {
    /*
     * 애니메이션은 **자기 상태만** 본다. 이동 속도로 클립을 고르지 않는 이유는
     * 서버가 보내주는 anim 이 이미 그 판정을 끝냈기 때문이다 (world-scene.tsx).
     * 여기서 다시 계산하면 두 곳이 어긋난다.
     */
    const next: ClipName = airborne ? 'jump' : anim === 'run' ? 'run' : anim === 'walk' ? 'walk' : 'idle';
    if (next === current.current) return;

    const to = actions[next];
    const from = current.current ? actions[current.current] : undefined;

    if (!to) return;
    to.reset();
    to.enabled = true;
    to.setEffectiveWeight(1);
    if (from && from !== to) {
      to.crossFadeFrom(from.play(), FADE, false);
    }
    to.play();
    current.current = next;
  }, [actions, anim, airborne]);

  const root = useRef<THREE.Group>(null);

  useFrame((state, delta) => {
    mixer.update(delta);

    const idle = !airborne && anim === 'idle';

    // 서 있을 때 고개가 너무 도는 걸 눌러준다. 걷기/뛰기 클립엔 손대지 않는다 —
    // 이동 중 고개 흔들림은 자연스러운 무게 이동이라 그대로 둔다.
    if (idle) {
      for (const { bone, q } of restBones) bone.quaternion.slerp(q, HEAD_CALM);
    }

    /*
     * 얼굴이 못 하는 몫을 몸이 대신한다 — 서 있을 때 아주 얕은 호흡.
     * 진폭은 6mm 다. 이보다 크면 '숨 쉬는 사람'이 아니라 '떠 있는 인형'이 된다.
     */
    const g = root.current;
    if (g) {
      const breath = idle ? Math.sin(state.clock.elapsedTime * 1.7) * 0.006 : 0;
      g.position.y = breath;
    }
  });

  return (
    <group ref={root} scale={scale}>
      {/*
        ★ 정면 축. 씬의 정면(=group +z)은 heading 이 가리키는 방향이다
          (world-scene.tsx 의 heading = atan2(x,z), 봇도 같은 규약).
          이 두 모델(office-man/girl)은 파일 자체가 **+z 를 정면**으로 내보내므로
          여기서 추가 회전을 주지 않는다. 예전엔 -z 로 보고 π 를 곱했는데, 그러면
          캐릭터가 진행·시선 방향과 **정반대**로 서서 뒷걸음질처럼 보였다.
      */}
      <primitive object={scene} rotation-y={0} />
    </group>
  );
}

// 방에 들어가는 순간 둘 다 받아 둔다. 남이 들어올 때 로딩이 시작되면 그 사람만 늦게 뜬다
useGLTF.preload(AVATAR_MODELS[0]);
useGLTF.preload(AVATAR_MODELS[1]);
