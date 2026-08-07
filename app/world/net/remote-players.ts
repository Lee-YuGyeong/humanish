/**
 * 원격 플레이어 보관소. 소유: 원상 (/world)
 *
 * ┌─ 여기가 성능의 급소다 ─────────────────────────────────────────────────────┐
 * │ 좌표를 React state나 스토어 값으로 넣으면 10Hz × N명마다 트리 전체가 리렌더된다. │
 * │ 8명이면 초당 80번이다. 그래서 **좌표는 이 가변 객체 안에만 산다.**             │
 * │ React는 "누가 방에 있는가"만 알면 되고 "어디 있는가"는 몰라도 된다 —           │
 * │ 렌더는 useFrame 안에서 이 Map을 직접 읽어 매 프레임 보간한다.                  │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

import { pushSample, type MoveSample, type Pose } from '@/lib/mp/interp';
import type { AnimState, PlayerSnapshot } from '@/lib/mp/protocol';

export interface RemotePlayer {
  id: string;
  seat: number;
  nickname: string;
  maskId: string;

  /** 애니메이션은 보간하지 않고 즉시 적용한다. 걷다 멈추는 건 지연되면 어색하다 */
  anim: AnimState;
  /** 좌표 링버퍼. 제자리에서 변형된다 */
  buffer: MoveSample[];
  /** 버퍼가 비었을 때 쓸 마지막 자세 */
  pose: Pose;

  /** 말풍선. 표시 여부는 렌더가 판단한다 */
  bubbleText: string;
  bubbleUntil: number;
}

export function createRemote(snap: PlayerSnapshot, now: number): RemotePlayer {
  return {
    id: snap.id,
    seat: snap.seat,
    nickname: snap.nickname,
    maskId: snap.maskId,
    anim: snap.anim,
    // 첫 샘플을 미리 넣어 둔다. 비어 있으면 원점에서 한 번 튄다.
    // y는 나중에 붙은 필드라 구 워커의 welcome에는 없다 → 바닥으로 읽는다.
    buffer: [{ t: now, x: snap.x, z: snap.z, y: snap.y ?? 0, heading: snap.heading }],
    pose: { x: snap.x, z: snap.z, y: snap.y ?? 0, heading: snap.heading },
    bubbleText: '',
    bubbleUntil: 0,
  };
}

export function pushMove(
  player: RemotePlayer,
  x: number,
  z: number,
  y: number,
  heading: number,
  anim: AnimState,
  now: number,
): void {
  player.anim = anim;
  pushSample(player.buffer, { t: now, x, z, y, heading });
}

/**
 * 말풍선 수명. 채팅 최소 간격(600ms)보다 충분히 길다.
 *
 * ★ 5초에서 3초로 줄였다 (사용자 2026-08-07 — "너무 오랫동안 남아있어").
 *   여덟이 한 바퀴 도는 동안 판이 머리 위에 겹겹이 남아서 사람이 안 보였다.
 *   지나간 말을 되짚는 건 흐르는 줄과 전체 기록이 맡는다 — 말풍선은 **지금
 *   누가 말하고 있는가**만 가리키면 된다.
 */
export const BUBBLE_MS = 3_000;

export function setBubble(player: RemotePlayer, text: string, now: number): void {
  player.bubbleText = text;
  player.bubbleUntil = now + BUBBLE_MS;
}
