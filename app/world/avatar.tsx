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

  /**
   * 팔 내리기 보정.
   *
   * ┌─ 왜 필요한가 ────────────────────────────────────────────────────────┐
   * │ 자동 리깅(Higgsfield→Meshy)이 준 클립은 **상체를 바인드 포즈 그대로**  │
   * │ 둔다. 프레임마다 LeftArm 의 쿼터니언을 찍어보면 파일에 적힌 바인드 값  │
   * │ (0.163,0.178,-0.003,0.970) 근처만 오간다. 원본 메시가 T 자세라, 그대로 │
   * │ 두면 걷든 서든 팔을 벌리고 다닌다.                                    │
   * │                                                                      │
   * │ 그래서 어깨 공간에서 **한 번만** 계산한 고정 보정을 매 프레임 앞에      │
   * │ 곱한다(premultiply). 고정값이라 클립이 만드는 흔들림은 그대로 남고,    │
   * │ 팔의 기준 자세만 아래로 내려온다. 축을 손으로 찍지 않고 '지금 팔이     │
   * │ 향한 방향 → 원하는 방향'으로 구해서, 리그가 바뀌어도 따라간다.        │
   * └──────────────────────────────────────────────────────────────────────┘
   */
  const armFixRef = useRef<{ bone: THREE.Object3D; corr: THREE.Quaternion }[] | null>(null);

  /*
   * ★ 이 계산은 **첫 프레임에** 한다. 마운트 시점에는 이 씬이 아직 R3F 트리에
   *   붙기 전이라 부모(그룹·rotation-y=π)의 월드 행렬이 없다. 그때 계산하면
   *   '아래'가 엉뚱한 축으로 잡혀서 팔이 위로 올라간다 — 실제로 그랬다.
   */
  const computeArmFix = (root: THREE.Object3D) => {
    const out: { bone: THREE.Object3D; corr: THREE.Quaternion }[] = [];
    root.updateMatrixWorld(true);

    for (const name of ['LeftArm', 'RightArm'] as const) {
      const bone = root.getObjectByName(name);
      const child = bone?.children[0];
      if (!bone || !child) continue;

      // 어깨(부모) 공간에서 본 현재 팔 방향
      const bindDir = child.position.clone().normalize().applyQuaternion(bone.quaternion);

      // 원하는 방향: 아래로, 몸에서 아주 살짝만 벌려서. 벌리는 쪽은 지금 팔이 향한 쪽을 따른다.
      // 0.22 는 팔이 뜨게 벌어져 걷을 때 어색했다 — 0.12 면 팔이 몸에 붙어 자연스럽다.
      const world = new THREE.Vector3();
      child.getWorldPosition(world).sub(bone.getWorldPosition(new THREE.Vector3()));
      const outward = Math.sign(world.x) || 1;
      const wanted = new THREE.Vector3(outward * 0.12, -1, 0.02).normalize();

      const parentQuat = bone.parent
        ? bone.parent.getWorldQuaternion(new THREE.Quaternion())
        : new THREE.Quaternion();
      const wantedInParent = wanted.clone().applyQuaternion(parentQuat.clone().invert());

      out.push({
        bone,
        corr: new THREE.Quaternion().setFromUnitVectors(bindDir, wantedInParent),
      });
    }
    return out;
  };

  const mixer = useMemo(() => new THREE.AnimationMixer(scene), [scene]);
  const actions = useMemo(() => {
    const map = {} as Record<ClipName, THREE.AnimationAction | undefined>;
    for (const clip of gltf.animations) {
      const action = mixer.clipAction(clip);
      if (clip.name === 'jump') {
        // 점프는 한 번만 돌고 마지막 자세에서 멈춘다. 착지하면 걷기/서기로 넘어간다
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      map[clip.name as ClipName] = action;
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

    // 믹서가 팔을 바인드 자세로 되돌린 **다음에** 보정을 얹는다 (순서가 뒤집히면 지워진다)
    if (armFixRef.current === null) armFixRef.current = computeArmFix(scene);
    for (const { bone, corr } of armFixRef.current) bone.quaternion.premultiply(corr);

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
