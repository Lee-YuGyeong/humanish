/**
 * 원격 아바타 보간 — **순수 함수만.** 소유: A
 *
 * lib/game/과 같은 규칙을 스스로에게 적용한다 (I3): DB·네트워크·Date.now()·랜덤 금지.
 * 시각은 전부 인자로 받는다. 그래야 `npm test`가 DB도 브라우저도 없이 검사한다.
 *
 * 왜 "과거를 그리는가":
 *   항상 최신 샘플보다 INTERP_DELAY_MS 만큼 뒤를 렌더하면, 패킷이 한 번 늦어도
 *   보간할 구간이 남아 있어 순간이동이 생기지 않는다. 최신 샘플을 바로 그리면
 *   패킷이 늦는 순간 아바타가 멈췄다가 튄다.
 */

import { MOVE_BUFFER_MAX } from './constants';

/** 링버퍼 한 칸. t는 **수신 시각**이다(서버 시각이 아니다 — 클라 시계끼리만 비교한다). */
export interface MoveSample {
  t: number;
  x: number;
  z: number;
  heading: number;
}

/** 보간 결과를 담을 그릇. 매 프레임 새 객체를 만들지 않으려고 재사용한다. */
export interface Pose {
  x: number;
  z: number;
  heading: number;
}

/**
 * 최단 각도 회전. 그냥 lerp하면 +179° → -179° 에서 한 바퀴 돌아간다.
 */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/**
 * 샘플을 버퍼에 넣는다. 오래된 것부터 버린다.
 * 버퍼는 제자리 변형한다 — 새 배열을 만들면 매 패킷마다 React가 리렌더할 빌미가 생긴다.
 */
export function pushSample(buffer: MoveSample[], sample: MoveSample): void {
  buffer.push(sample);
  if (buffer.length > MOVE_BUFFER_MAX) {
    buffer.splice(0, buffer.length - MOVE_BUFFER_MAX);
  }
}

/**
 * renderTime 시점의 자세를 구해 out에 쓴다.
 *
 * - 버퍼가 비면 false. 호출자가 마지막 자세를 유지한다.
 * - renderTime이 첫 샘플보다 과거면 첫 샘플(접속 직후 150ms 동안).
 * - renderTime이 마지막 샘플보다 미래면 마지막 샘플. **외삽하지 않는다** —
 *   외삽은 멈춘 사람을 벽으로 밀어넣는다.
 */
export function sampleAt(buffer: MoveSample[], renderTime: number, out: Pose): boolean {
  if (buffer.length === 0) return false;

  const first = buffer[0];
  if (renderTime <= first.t) {
    out.x = first.x;
    out.z = first.z;
    out.heading = first.heading;
    return true;
  }

  const last = buffer[buffer.length - 1];
  if (renderTime >= last.t) {
    out.x = last.x;
    out.z = last.z;
    out.heading = last.heading;
    return true;
  }

  // renderTime을 감싸는 두 샘플을 찾는다. 버퍼가 24칸이라 선형 탐색으로 충분하다.
  for (let i = buffer.length - 1; i > 0; i--) {
    const b = buffer[i];
    const a = buffer[i - 1];
    if (renderTime >= a.t && renderTime <= b.t) {
      const span = b.t - a.t;
      // 같은 ms에 두 샘플이 들어오면 나누기 0이 된다. 뒤쪽을 쓴다.
      const k = span <= 0 ? 1 : (renderTime - a.t) / span;
      out.x = a.x + (b.x - a.x) * k;
      out.z = a.z + (b.z - a.z) * k;
      out.heading = lerpAngle(a.heading, b.heading, k);
      return true;
    }
  }

  out.x = last.x;
  out.z = last.z;
  out.heading = last.heading;
  return true;
}
