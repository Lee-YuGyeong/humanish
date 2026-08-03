'use client';

/**
 * 3D 아바타 — 로봇 한 종류. 소유: 원상 (/world)
 *
 * ┌─ 어떻게 만들어졌나 ────────────────────────────────────────────────────┐
 * │ 원본은 robot+toy+3d+model.glb (Tripo, 78MB · 198만 삼각형).            │
 * │ 그대로는 웹에 못 올린다. 순서는 이렇다 — 다시 만들려면 그대로 밟는다.  │
 * │                                                                        │
 * │   npx @gltf-transform/cli weld     원본.glb  w.glb                     │
 * │   npx @gltf-transform/cli simplify w.glb  s.glb --ratio 0.02 --error 0.002 │
 * │   npx @gltf-transform/cli resize   s.glb  r.glb --width 1024 --height 1024 │
 * │   npx @gltf-transform/cli webp     r.glb  wb.glb                       │
 * │   npx @gltf-transform/cli quantize wb.glb q.glb                        │
 * │   node tools/build-robot-glb.mjs   q.glb  public/world/robot.glb       │
 * │                                                                        │
 * │ → 39,690 삼각형 / 1.21MB. 원본은 저장소에 두지 않는다.                 │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ ★ 클립이 둘뿐이었다 ─────────────────────────────────────────────────┐
 * │ 원본에는 이름 없는 클립 둘("NlaTrack" · "NlaTrack.001")만 있었다.      │
 * │ 무엇인지는 뼈대를 굴려 알아냈고(근거는 tools/build-robot-glb.mjs),     │
 * │ 그 도구가 셋으로 다듬어 굽는다:                                        │
 * │                                                                        │
 * │   walk ← NlaTrack (2.92s)      앞뒤 루트 모션만 뗐다 (높이는 남겼다)   │
 * │   jump ← NlaTrack.001 (0.41s)  연속 홉에서 가장 큰 한 번만 잘랐다      │
 * │   idle ← walk 의 t=0.547 프레임을 굳혔다 (원본에 없다)                 │
 * │                                                                        │
 * │ ★ **높이는 클립의 것을 그대로 쓴다.** 한동안 Hip 의 위치 트랙을 통째로  │
 * │   뗐었는데, 그러면 걷기의 골반 흔들림(0.035)이 죽어 다리만 젓는 인형이  │
 * │   되고 **점프는 통째로 사라진다** — 이 리그의 도약은 전부 Hip 의 Y      │
 * │   이동(0.218)이라 떼고 나면 무릎만 까딱한다. 지금은 걷기 골반이         │
 * │   4.3cm 흔들리고 점프는 골반이 0.30m 솟는다.                            │
 * │                                                                        │
 * │ **run 은 걷기를 빠르게 돌린 것이다.** 뛰는 클립이 없다. 로봇 장난감이라 │
 * │ 보폭이 그대로여도 어색하지 않아서, 없는 동작을 흉내 내는 대신 배속만    │
 * │ 올린다. 진짜 달리기가 필요하면 클립을 하나 더 받아 붙여야 한다.        │
 * │                                                                        │
 * │ **idle 은 완전한 정지다.** 원본에 없어서 걷기의 한 프레임을 굳힌 것이라 │
 * │ 서 있다기보다 걸음을 멈춘 자세에 가깝다. 몸을 코드로 흔들어 메우지      │
 * │ 않는다 — 아쉬우면 idle 클립 자체를 고칠 일이다.                        │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 표정은 없다. 블렌드셰이프도 얼굴 본도 없는 리그다(41본: 다리·척추·목·
 *   머리·팔·손·트위스트뿐). 없는 걸 흉내 내지 않는다.
 */

import { useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
// three 0.185 는 이 모듈을 이름별로 내보낸다 (SkeletonUtils 네임스페이스가 아니다)
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';

import { GRAVITY, JUMP_SPEED, RUN_SPEED, WALK_SPEED } from '@/lib/mp/constants';
import type { AnimState } from '@/lib/mp/protocol';

export const AVATAR_MODEL = '/world/robot.glb';

/** 아바타 키(m). 씬의 EYE_HEIGHT(1.62)와 눈높이가 맞도록 이 값으로 정규화한다 */
const TARGET_HEIGHT = 1.72;

/** 클립 사이 넘어가는 시간(초). 짧으면 툭툭 끊기고 길면 미끄러진다 */
const FADE = 0.18;

/**
 * 걷기 클립이 **스스로 나아가던** 속도 (모델 단위/초).
 *
 * tools/build-robot-glb.mjs 가 루트 모션을 떼기 전에 재서 출력한다
 * (1.800 / 2.92s). 파일에는 남아 있지 않으니 여기 적어 둔다 — GLB 를 다시 구우면
 * 그 출력의 숫자로 갱신할 것.
 *
 * ★ 배속을 숫자로 박지 않고 이 값에서 나눠 쓴다. 그래야 TARGET_HEIGHT 를 바꿔도
 *   발이 안 미끄러진다 — 키가 커지면 같은 걸음이 더 멀리 나가기 때문이다.
 */
const CLIP_WALK_SPEED = 0.617;

type ClipName = 'idle' | 'walk' | 'run' | 'jump';

/**
 * ★ 상태를 **prop 이 아니라 함수로** 받는다. 이유는 이 컴포넌트가 아니라 부르는 쪽에 있다.
 *
 *   원격 플레이어의 anim 은 Map 안 객체를 **제자리 변형**해서 갱신된다 —
 *   10Hz × N명을 setState 로 돌리면 화면이 죽기 때문이다(net/remote-players.ts 머리말).
 *   그래서 값이 바뀌어도 리렌더가 나지 않고, `anim={player.anim}` 처럼 렌더 시점에
 *   읽어 넘기면 **입장할 때의 'idle' 이 영원히 굳는다.** 몸은 매 프레임 보간돼 나아가는데
 *   클립만 idle 이라, 선 자세 그대로 미끄러져 다니는 게 그 증상이었다.
 *
 *   좌표를 useFrame 안에서 직접 읽는 것과 같은 규약으로 맞춘다: **매 프레임 물어본다.**
 */
export function Avatar({
  getAnim,
  getAirborne,
}: {
  getAnim: () => AnimState;
  /** 공중에 떠 있나. 점프 클립을 켜는 조건이다 (높이로만 판단 — protocol.ts 주석) */
  getAirborne: () => boolean;
}) {
  const gltf = useGLTF(AVATAR_MODEL);

  /*
   * ★ 씬을 그대로 쓰면 안 된다. useGLTF 는 같은 파일에 하나의 인스턴스를 캐시하므로
   *   여러 명이 같은 뼈대를 공유해 **한 사람이 걸으면 전원이 같이 걷는다.**
   *   SkeletonUtils.clone 은 스킨 메시와 뼈대를 짝지어 복제한다 (object3d.clone 은 못 한다).
   */
  const scene = useMemo(() => cloneSkeleton(gltf.scene), [gltf.scene]);

  /**
   * 모델마다 실제 키가 달라서 파일에 손대지 않고 여기서 맞춘다.
   *
   * ★ updateMatrixWorld(true) 를 **반드시 먼저** 부른다. Box3 는 SkinnedMesh 를
   *   만나면 computeBoundingBox() 로 **스킨을 먹인 실제 크기**를 재는데, 그 계산이
   *   bones[i].matrixWorld 를 읽는다. 갓 복제한 씬은 그 값이 아직 단위행렬이라
   *   빼먹으면 엉뚱한 크기가 나온다.
   *
   * ★ 이 파일은 양자화돼 있어(KHR_mesh_quantization) position 이 [-1,1] 로 눌려
   *   있고, 되돌리는 보정은 inverseBindMatrices 에 구워져 있다. 그래서 **기하만
   *   재면 2.0 이 나오고 로봇이 절반 크기가 된다.** 위의 스킨 경로를 타야 0.98 이
   *   나온다 — Box3.setFromObject 는 그 경로를 탄다(three 0.185 확인).
   */
  const scale = useMemo(() => {
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene);
    const h = box.max.y - box.min.y;
    // 뼈대만 있고 메시가 안 잡히는 등 이상하면 1 로 두고 눈에 띄게 남긴다
    if (!Number.isFinite(h) || h <= 1e-4) return 1;
    return TARGET_HEIGHT / h;
  }, [scene]);

  const mixer = useMemo(() => new THREE.AnimationMixer(scene), [scene]);

  const actions = useMemo(() => {
    const map = {} as Record<ClipName, THREE.AnimationAction | undefined>;

    /*
     * 클립이 나아가던 속도를 실제 아바타 크기로 환산한다. 이게 배속 1 일 때
     * 다리가 낼 수 있는 속도이고, 몸이 실제로 내는 속도(WALK_SPEED)를 여기 나눈
     * 값이 배속이다. 1 로 두면 몸은 나아가는데 다리가 안 따라와 **발이 미끄러진다.**
     */
    const legSpeed = CLIP_WALK_SPEED * scale;

    for (const source of gltf.animations) {
      const name = source.name as 'idle' | 'walk' | 'jump';
      const action = mixer.clipAction(source);

      if (name === 'jump') {
        // 점프는 한 번만 돌고 마지막(착지) 자세에서 멈춘다
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;

        /*
         * 클립 한 번이 **체공 시간과 같도록** 늘린다. 클립을 고치는 게 아니라
         * 같은 동작을 이 점프의 길이에 맞춰 트는 것이다 — 안 맞추면 클립(0.41초)이
         * 체공(2·JUMP_SPEED/GRAVITY ≈ 0.75초)보다 짧아, **몸이 아직 최고점인데
         * 착지 자세를 잡고** 그대로 굳어 내려온다. 실제로 재 보니 410ms 에
         * 착지 자세(골반 0.547)로 굳은 뒤 340ms 를 그 자세로 떠 있었다.
         */
        const airborneSec = (2 * JUMP_SPEED) / GRAVITY;
        if (source.duration > 0) action.timeScale = source.duration / airborneSec;
      }

      /*
       * 걷기만 배속을 맞춘다. 이건 클립을 주무르는 게 아니라 **발이 땅을 붙잡게
       * 하는 유일한 방법**이다 — 몸은 WALK_SPEED 로 나아가는데 다리가 제 속도로
       * 저으면 그 차이가 그대로 미끄러짐이 된다.
       */
      if (name === 'walk') action.timeScale = WALK_SPEED / legSpeed;

      map[name] = action;
    }

    /*
     * 달리기는 걷기를 더 빠르게 돌린 것이다 — 원본에 뛰는 클립이 없다 (머리말).
     * 같은 클립으로 액션을 하나 더 만든다. 같은 액션에 배속만 바꾸면 걷기/달리기가
     * 서로의 배속을 덮어써서 크로스페이드 도중 다리가 튄다.
     */
    const walkClip = gltf.animations.find((c) => c.name === 'walk');
    if (walkClip) {
      // clipAction 은 (클립, 루트) 한 쌍마다 하나를 캐시한다. 클립을 복제해야 별개가 된다.
      const runClip = walkClip.clone();
      runClip.name = 'run';
      const run = mixer.clipAction(runClip);
      run.timeScale = RUN_SPEED / legSpeed;
      map.run = run;
    }

    return map;
  }, [gltf.animations, mixer, scale]);

  const current = useRef<ClipName | null>(null);

  /*
   * ★ 여기서 mixer.stopAllAction() · uncacheRoot() 를 부르지 않는다.
   *
   *   **아바타가 자세 하나로 굳은 채 미끄러져 다니던 원인이 그거였다.** 정리
   *   함수는 진짜 언마운트에서만 도는 게 아니다 — StrictMode 의 두 번 마운트,
   *   Suspense 가 모델을 받아 자식을 다시 붙일 때, HMR 마다 돈다. 그때
   *   stopAllAction() 이 클립을 전부 멈추는데 current 는 ref 라 살아남아
   *   "이미 walk 다"라며 다시 켜는 걸 건너뛴다. current 를 같이 비우면 이번엔
   *   uncacheRoot 로 버려진 액션을 되살리다 믹서 장부가 깨진다
   *   (`Cannot set properties of undefined (setting '_cacheIndex')`).
   *
   *   치울 것도 없다. mixer 도 scene 도 이 컴포넌트의 useMemo 안에만 살고,
   *   매 프레임 도는 mixer.update 는 useFrame 이 언마운트 때 알아서 끊는다.
   */

  /*
   * 믹서가 새로 만들어지면(모델 재로딩 · HMR · StrictMode 재마운트) 방금까지 돌던
   * 액션은 그 믹서의 것이 아니다. current 는 ref 라 살아남으므로 여기서 비워 준다 —
   * 안 비우면 "이미 walk 다"라며 새 믹서에서 클립을 켜는 걸 건너뛴다 (위 ★ 주석의 함정).
   */
  useEffect(() => {
    current.current = null;
  }, [actions]);

  /*
   * 몸을 코드로 흔들지 않는다. 예전에는 idle 에 얕은 상하 진동을 얹었는데,
   * 클립이 하는 일을 코드가 거들면 둘이 어긋날 때 원인을 찾을 수가 없다.
   * 서 있는 모습이 심심하면 그건 idle 클립을 고쳐서 해결할 일이다.
   */
  useFrame((_, delta) => {
    /*
     * 애니메이션은 **자기 상태만** 본다. 이동 속도로 클립을 고르지 않는 이유는
     * 서버가 보내주는 anim 이 이미 그 판정을 끝냈기 때문이다 (world-scene.tsx).
     * 여기서 다시 계산하면 두 곳이 어긋난다.
     */
    const anim = getAnim();
    const next: ClipName = getAirborne()
      ? 'jump'
      : anim === 'run'
        ? 'run'
        : anim === 'walk'
          ? 'walk'
          : 'idle';

    if (next !== current.current) {
      const to = actions[next];
      const from = current.current ? actions[current.current] : undefined;

      if (to) {
        to.reset();
        to.enabled = true;
        to.setEffectiveWeight(1);
        if (from && from !== to) {
          to.crossFadeFrom(from.play(), FADE, false);
        }
        to.play();
        current.current = next;
      }
    }

    mixer.update(delta);
  });

  return (
    <group scale={scale}>
      {/*
        ★ 정면 축. 씬의 정면(=group +z)은 heading 이 가리키는 방향이다
          (world-scene.tsx 의 heading = atan2(x,z), 봇도 같은 규약).
          이 모델은 걷기 클립이 **+z 로 전진**하므로 +z 가 정면이다 — 여기서
          추가 회전을 주지 않는다 (tools/build-robot-glb.mjs 가 잰 값).
      */}
      <primitive object={scene} rotation-y={0} />
    </group>
  );
}

// 방에 들어가는 순간 받아 둔다. 남이 들어올 때 로딩이 시작되면 그 사람만 늦게 뜬다
useGLTF.preload(AVATAR_MODEL);
