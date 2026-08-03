#!/usr/bin/env node
/**
 * 로봇 아바타 GLB 의 클립을 게임이 쓰는 모양으로 다듬는다. 소유: 원상 (/world)
 *
 *   node tools/build-robot-glb.mjs <감면된.glb> <out.glb>
 *
 * ┌─ 왜 필요한가 ──────────────────────────────────────────────────────────┐
 * │ 원본(robot+toy+3d+model.glb, Tripo)에는 클립이 **둘뿐이고 이름이 없다** │
 * │ — "NlaTrack" · "NlaTrack.001" 은 블렌더 NLA 트랙 기본 이름이다.        │
 * │ 무엇인지는 뼈대를 실제로 굴려서 알아냈다 (FK 로 발·골반 궤적 측정):    │
 * │                                                                        │
 * │   NlaTrack     2.92s  골반 높이 고정(폭 0.03) · 발이 번갈아 접지        │
 * │                       · **z 로 1.80 전진** → 걷기 (루트 모션 있음)     │
 * │   NlaTrack.001 1.75s  두 발이 **동시에** 0.17 뜸 · 골반 0.29↔0.50 왕복  │
 * │                       · 1.75초에 4~5회 → 제자리 연속 홉 (점프)         │
 * │                                                                        │
 * │ 여기서 세 가지를 한다. 전부 런타임이 아니라 **에셋 시점**에 끝낸다 —   │
 * │ avatar.tsx 가 매 프레임 트랙을 주무르면 그만큼 계산이 새고, 무엇보다   │
 * │ "이 클립이 무엇인가"를 코드에서 다시 추측하게 된다.                    │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 1. 수평 루트 모션만 뗀다 (Hip.translation 의 X·Z) ─────────────────────┐
 * │ 이 월드에서 **앞뒤 위치는 네트워크가 정한다** (world-scene.tsx).        │
 * │ 클립이 스스로 1.8 을 전진하면 그만큼 몸이 새어 나가 제자리를 벗어난다.  │
 * │                                                                        │
 * │ ★ 높이(Y)는 남긴다. 예전에는 위치 트랙을 통째로 뗐는데, 그러면          │
 * │   **점프가 사라진다** — 이 리그의 도약은 전부 Hip 의 Y 이동이라 떼고    │
 * │   나면 무릎만 까딱하는 경련이 된다. 걷기의 골반 흔들림도 같이 죽어      │
 * │   다리만 젓는 인형이 된다. 그게 "미끄러진다"의 정체였다.                │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 2. 점프를 한 번만 남긴다 ─────────────────────────────────────────────┐
 * │ 원본은 연속 홉이라 그대로 쓰면 착지한 뒤에도 계속 통통 뛴다.           │
 * │ 골반 최저점 사이를 한 주기로 보고 **가장 크게 뛴 구간**만 잘라 쓴다.   │
 * │ 잘린 구간을 0 초부터 시작하도록 시간축을 당긴다(rebase).               │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 3. 서 있는 자세(idle)를 만든다 ───────────────────────────────────────┐
 * │ 원본에 idle 이 없다. **바인드 포즈를 쓰면 안 된다** — 이 리그의 바인드는 │
 * │ 팔을 0.46(모델 폭 0.55)만큼 벌린 A 자세라, 서 있는 게 아니라 검문받는  │
 * │ 것처럼 보인다.                                                         │
 * │                                                                        │
 * │ 그래서 걷기 클립에서 **가장 서 있는 프레임**을 뽑아 정지 자세로 굳힌다. │
 * │ 고르는 기준은 세 가지 합이다: 두 발 간격 · 들린 발 높이 · 팔 벌림.     │
 * │ (t=0.547 에서 두 발이 다 닿고 팔이 몸 옆에 내려와 있다.)               │
 * │ 로봇이라 가만히 서 있는 게 어색하지 않다 — 사람이라면 체중 이동이       │
 * │ 필요했겠지만, avatar.tsx 가 얹는 미세한 상하 진동으로 충분하다.        │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 감면(1.98M → 40k 삼각형)·텍스처 축소는 이 도구가 하지 않는다.
 *   gltf-transform 이 훨씬 잘한다. 앞단 순서는 avatar.tsx 머리말에 적어 뒀다.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const COMPONENT = {
  5120: { Arr: Int8Array, bytes: 1 },
  5121: { Arr: Uint8Array, bytes: 1 },
  5122: { Arr: Int16Array, bytes: 2 },
  5123: { Arr: Uint16Array, bytes: 2 },
  5125: { Arr: Uint32Array, bytes: 4 },
  5126: { Arr: Float32Array, bytes: 4 },
};
const TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

/** 루트 모션이 실려 있는 본. 이 본의 위치 트랙만 뗀다. */
const ROOT_BONE = 'Hip';

/**
 * Hip 의 로컬 축 중 **수평**인 것 (0=X, 1=Y, 2=Z).
 *
 * ★ 이 리그는 블렌더에서 왔고 뼈대 로컬은 **Z 가 위**다. 헷갈리기 딱 좋아서 재 뒀다:
 *   걷기의 전진 1.800 은 **Y** 에, 점프의 도약 0.218 은 **Z** 에 실려 있다.
 *   (Hip 노드 기본 위치도 [0, 0, 0.349] — 셋째 값이 키다.)
 *   여기를 [0,2] 로 잘못 적으면 전진이 살아남아 아바타가 제자리를 벗어나고,
 *   도약이 죽어 점프가 무릎 경련이 된다.
 */
const HORIZONTAL_AXES = [0, 1];

/** 서 있는 자세를 고를 때 "발이 닿았다"로 보는 높이(모델 단위). 바인드 발높이가 0.056 이다. */
const GROUND_Y = 0.056;

/** 팔이 몸 옆에 내려온 것으로 보는 벌림 폭. 이보다 넓으면 점수에서 깎는다. */
const ARMS_DOWN = 0.28;

/* ────────────────────────────── GLB 읽기 ────────────────────────────── */

function readGlb(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`GLB 가 아니다: ${path}`);

  let offset = 12;
  let json = null;
  let bin = Buffer.alloc(0);
  while (offset < buf.length) {
    const len = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === CHUNK_JSON) json = JSON.parse(data.toString('utf8'));
    else if (type === CHUNK_BIN) bin = data;
    offset += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error('JSON 청크가 없다');
  return { json, bin };
}

function pad4(n) {
  return (4 - (n % 4)) % 4;
}

function writeGlb(path, json, bin) {
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = Buffer.alloc(pad4(jsonBuf.length), 0x20); // 공백으로 채운다 (규격)
  const binPad = Buffer.alloc(pad4(bin.length), 0);

  const jsonLen = jsonBuf.length + jsonPad.length;
  const binLen = bin.length + binPad.length;
  const total = 12 + 8 + jsonLen + 8 + binLen;

  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(total, 8);

  const jsonHead = Buffer.alloc(8);
  jsonHead.writeUInt32LE(jsonLen, 0);
  jsonHead.writeUInt32LE(CHUNK_JSON, 4);

  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(binLen, 0);
  binHead.writeUInt32LE(CHUNK_BIN, 4);

  writeFileSync(path, Buffer.concat([head, jsonHead, jsonBuf, jsonPad, binHead, bin, binPad]));
  return total;
}

/* ─────────────────────────── 접근자 디코딩 ─────────────────────────── */

/** 접근자를 [[x,y,…], …] 로 읽는다. 애니메이션 샘플러는 양자화되지 않아 f32 그대로다. */
function readAccessor(json, bin, index) {
  const acc = json.accessors[index];
  const view = json.bufferViews[acc.bufferView];
  const { Arr, bytes } = COMPONENT[acc.componentType];
  const n = TYPE_COUNT[acc.type];
  const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const stride = view.byteStride ?? n * bytes;

  const out = [];
  for (let i = 0; i < acc.count; i += 1) {
    const at = bin.byteOffset + base + i * stride;
    out.push(Array.from(new Arr(bin.buffer, at, n)));
  }
  return out;
}

/* ─────────────────────────── 클립 다루기 ─────────────────────────── */

/** GLB 애니메이션 → 다루기 쉬운 모양. 채널마다 시간·값 배열을 통째로 들고 온다. */
function decodeClip(json, bin, anim) {
  const channels = [];
  for (const ch of anim.channels) {
    const sampler = anim.samplers[ch.sampler];
    channels.push({
      node: ch.target.node,
      path: ch.target.path,
      interpolation: sampler.interpolation ?? 'LINEAR',
      times: readAccessor(json, bin, sampler.input).map((v) => v[0]),
      values: readAccessor(json, bin, sampler.output),
    });
  }
  return { name: anim.name, channels };
}

function clipDuration(clip) {
  let d = 0;
  for (const ch of clip.channels) {
    const last = ch.times[ch.times.length - 1];
    if (last > d) d = last;
  }
  return d;
}

const dot4 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];

/** 쿼터니언 보간. 부호를 맞춰 짧은 쪽으로 돈다 — 안 맞추면 팔이 한 바퀴 돈다. */
function slerp(a, b, u) {
  let d = dot4(a, b);
  let end = b;
  if (d < 0) {
    d = -d;
    end = b.map((v) => -v);
  }
  if (d > 0.9995) return a.map((v, i) => v + (end[i] - v) * u);
  const theta = Math.acos(d);
  const s = Math.sin(theta);
  return a.map((v, i) => (v * Math.sin((1 - u) * theta) + end[i] * Math.sin(u * theta)) / s);
}

/** 채널을 시각 t 에서 뽑는다. STEP 이면 보간하지 않는다. */
function sampleChannel(ch, t) {
  const { times, values } = ch;
  if (times.length === 0) return null;
  if (t <= times[0]) return values[0];
  if (t >= times[times.length - 1]) return values[values.length - 1];

  let i = 0;
  while (i < times.length - 1 && times[i + 1] < t) i += 1;
  const t0 = times[i];
  const t1 = times[i + 1];
  if (ch.interpolation === 'STEP' || t1 <= t0) return values[i];

  const u = (t - t0) / (t1 - t0);
  const v0 = values[i];
  const v1 = values[i + 1];
  return ch.path === 'rotation' ? slerp(v0, v1, u) : v0.map((v, k) => v + (v1[k] - v) * u);
}

/**
 * 루트 본의 **수평 이동만** 뗀다. 높이(Y)는 남긴다.
 *
 * ★ 예전에는 위치 트랙을 통째로 뗐다. 그러면 걷기의 골반 상하 흔들림이 사라져
 *   다리만 움직이는 인형이 되고, 무엇보다 **점프가 통째로 없어진다** — 이 리그의
 *   도약은 전부 Hip 의 Y 이동이라, 떼고 나면 무릎만 살짝 굽혔다 펴는 경련이 된다.
 *   앞뒤(X·Z)만 떼면 클립이 제자리를 지키면서 자기 움직임은 그대로 산다.
 *
 * 첫 프레임의 Y 를 기준으로 삼지 않고 값을 그대로 둔다 — 바인드 높이가 곧 서 있는
 * 높이라서 오프셋을 빼면 오히려 땅에 박힌다.
 */
function stripHorizontalTranslation(clip, boneNames, nodeName, restOf) {
  let touched = 0;
  for (const ch of clip.channels) {
    if (ch.path !== 'translation' || !boneNames.has(nodeName(ch.node))) continue;
    // 수평은 그 본의 **기본 위치**로 못 박는다. 0 으로 두면 팔뼈 원점으로 끌려간다.
    const rest = restOf(ch.node);
    ch.values = ch.values.map((v) => {
      const out = v.slice();
      for (const axis of HORIZONTAL_AXES) out[axis] = rest[axis];
      return out;
    });
    touched += 1;
  }
  return touched;
}

/** [from, to] 구간만 남기고 0 초부터 시작하도록 당긴다. 양 끝은 보간해서 만든다. */
function trimClip(clip, from, to) {
  for (const ch of clip.channels) {
    const times = [];
    const values = [];

    const head = sampleChannel(ch, from);
    if (head) {
      times.push(0);
      values.push(head);
    }
    for (let i = 0; i < ch.times.length; i += 1) {
      const t = ch.times[i];
      if (t > from && t < to) {
        times.push(t - from);
        values.push(ch.values[i]);
      }
    }
    const tail = sampleChannel(ch, to);
    if (tail) {
      times.push(to - from);
      values.push(tail);
    }

    ch.times = times;
    ch.values = values;
  }
  return clip;
}

/** 한 프레임을 굳혀 정지 클립을 만든다. 두 키를 두는 건 믹서가 길이 0 클립을 싫어해서다. */
function freezeFrame(clip, t, name, holdSec = 1) {
  const channels = [];
  for (const ch of clip.channels) {
    const v = sampleChannel(ch, t);
    if (!v) continue;
    channels.push({
      node: ch.node,
      path: ch.path,
      interpolation: 'LINEAR',
      times: [0, holdSec],
      values: [v, v.slice()],
    });
  }
  return { name, channels };
}

/* ─────────────────────── 서 있는 프레임 고르기 ─────────────────────── */

const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      let s = 0;
      for (let k = 0; k < 4; k += 1) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
};

function trsMatrix(t, q, s) {
  const [x, y, z, w] = q;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

/** 클립을 t 에서 굴려 본의 월드 좌표를 구한다 (FK). 자세 판정에만 쓴다. */
function worldPositions(json, clip, t, names) {
  const parent = new Map();
  json.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)));

  const posed = new Map();
  for (const ch of clip.channels) {
    const v = sampleChannel(ch, t);
    if (!v) continue;
    if (!posed.has(ch.node)) posed.set(ch.node, {});
    posed.get(ch.node)[ch.path] = v;
  }

  const cache = new Map();
  const world = (i) => {
    if (cache.has(i)) return cache.get(i);
    const node = json.nodes[i];
    const p = posed.get(i) ?? {};
    const local = node.matrix
      ? node.matrix
      : trsMatrix(
          p.translation ?? node.translation ?? [0, 0, 0],
          p.rotation ?? node.rotation ?? [0, 0, 0, 1],
          p.scale ?? node.scale ?? [1, 1, 1],
        );
    const up = parent.get(i);
    const m = up == null ? local : mul(world(up), local);
    cache.set(i, m);
    return m;
  };

  const byName = new Map(json.nodes.map((n, i) => [n.name, i]));
  const out = {};
  for (const nm of names) {
    const i = byName.get(nm);
    if (i != null) {
      const m = world(i);
      out[nm] = [m[12], m[13], m[14]];
    }
  }
  return out;
}

/**
 * 걷기 클립에서 가장 "서 있는" 시각을 찾는다.
 * 점수 = 두 발 간격 + 들린 발 높이 + 팔이 벌어진 정도. 낮을수록 서 있는 자세다.
 */
function findStandingTime(json, walk, samples = 96) {
  const dur = clipDuration(walk);
  let best = { t: 0, score: Infinity };
  for (let k = 0; k <= samples; k += 1) {
    const t = (dur * k) / samples;
    const p = worldPositions(json, walk, t, ['L_Foot', 'R_Foot', 'L_Hand', 'R_Hand']);
    if (!p.L_Foot || !p.R_Foot || !p.L_Hand || !p.R_Hand) return { t: 0, score: 0 };

    const gap = Math.hypot(p.L_Foot[0] - p.R_Foot[0], p.L_Foot[2] - p.R_Foot[2]);
    const lifted = Math.max(0, Math.max(p.L_Foot[1], p.R_Foot[1]) - GROUND_Y);
    const arms = Math.abs(p.L_Hand[0] - p.R_Hand[0]);
    const score = gap * 2 + lifted * 4 + Math.max(0, arms - ARMS_DOWN) * 2;
    if (score < best.score) best = { t, score, gap, lifted, arms };
  }
  return best;
}

/** 골반이 가장 크게 솟은 한 주기를 찾는다 (연속 홉 → 점프 한 번). */
function findBestHop(json, jump, samples = 140) {
  const dur = clipDuration(jump);
  const ys = [];
  for (let k = 0; k <= samples; k += 1) {
    const t = (dur * k) / samples;
    const p = worldPositions(json, jump, t, ['Hip']);
    ys.push({ t, y: p.Hip ? p.Hip[1] : 0 });
  }

  // 골반 최저점 = 착지. 그 사이가 홉 한 번이다.
  const lows = [];
  for (let i = 1; i < ys.length - 1; i += 1) {
    if (ys[i].y <= ys[i - 1].y && ys[i].y <= ys[i + 1].y) {
      if (lows.length === 0 || ys[i].t - lows[lows.length - 1].t > dur * 0.08) lows.push(ys[i]);
    }
  }
  if (lows.length < 2) return { from: 0, to: dur, rise: 0 };

  let best = null;
  for (let i = 0; i < lows.length - 1; i += 1) {
    const from = lows[i].t;
    const to = lows[i + 1].t;
    let peak = -Infinity;
    for (const s of ys) if (s.t >= from && s.t <= to && s.y > peak) peak = s.y;
    const rise = peak - Math.max(lows[i].y, lows[i + 1].y);
    if (!best || rise > best.rise) best = { from, to, rise };
  }
  return best;
}

/* ────────────────────────── 다시 써넣기 ────────────────────────── */

/**
 * 클립들을 새 접근자로 굽고 GLB 를 다시 만든다.
 *
 * 애니메이션이 아닌 접근자(메시·스킨)는 **바이트를 그대로 옮긴다** — 이 파일은
 * 이미 양자화돼 있어서(KHR_mesh_quantization) 풀었다 다시 굽으면 손해만 본다.
 */
function rebuild(json, bin, clips) {
  const animAccessors = new Set();
  for (const anim of json.animations ?? []) {
    for (const s of anim.samplers) {
      animAccessors.add(s.input);
      animAccessors.add(s.output);
    }
  }

  // 남길 접근자만 추린다. 인덱스가 바뀌므로 옛 → 새 지도를 만든다.
  const keptAccessors = [];
  const accessorMap = new Map();
  json.accessors.forEach((acc, i) => {
    if (animAccessors.has(i)) return;
    accessorMap.set(i, keptAccessors.length);
    keptAccessors.push(acc);
  });

  /*
   * 남은 접근자·이미지가 가리키는 bufferView 만 새 버퍼로 옮긴다.
   * 애니메이션만 쓰던 뷰는 여기서 자연히 빠진다 (클립을 새로 구우므로 쓸모가 없다).
   *
   * 옛 인덱스 오름차순으로 옮긴다 — 순서 자체는 아무래도 좋지만, 고정해 두면
   * 같은 입력에서 같은 파일이 나와 다시 구웠을 때 diff 가 뜨지 않는다.
   */
  const referenced = [...keptAccessors, ...(json.images ?? []).filter((i) => i.bufferView != null)];
  const oldViewIndices = [...new Set(referenced.map((r) => r.bufferView))].sort((a, b) => a - b);

  const viewMap = new Map();
  const newViews = [];
  let cursor = 0;
  for (const oi of oldViewIndices) {
    const v = json.bufferViews[oi];
    cursor += pad4(cursor);
    viewMap.set(oi, newViews.length);
    newViews.push({
      buffer: 0,
      byteOffset: cursor,
      byteLength: v.byteLength,
      ...(v.byteStride != null ? { byteStride: v.byteStride } : {}),
      ...(v.target != null ? { target: v.target } : {}),
    });
    cursor += v.byteLength;
  }

  for (const acc of keptAccessors) acc.bufferView = viewMap.get(acc.bufferView);
  for (const img of json.images ?? []) {
    if (img.bufferView != null) img.bufferView = viewMap.get(img.bufferView);
  }

  // 여기까지가 옛 데이터. 이제 새 애니메이션을 뒤에 굽는다.
  const accessors = keptAccessors;
  const views = newViews;
  let offset = views.length ? views[views.length - 1].byteOffset + views[views.length - 1].byteLength : 0;
  const tail = [];

  const pushFloats = (flat, type, count) => {
    offset += pad4(offset);
    const buf = Buffer.alloc(flat.length * 4);
    flat.forEach((v, i) => buf.writeFloatLE(v, i * 4));
    tail.push({ offset, buf });
    views.push({ buffer: 0, byteOffset: offset, byteLength: buf.length });
    offset += buf.length;

    const acc = {
      bufferView: views.length - 1,
      componentType: 5126,
      count,
      type,
    };
    accessors.push(acc);
    return { index: accessors.length - 1, acc };
  };

  const animations = [];
  for (const clip of clips) {
    const samplers = [];
    const channels = [];
    for (const ch of clip.channels) {
      if (ch.times.length === 0) continue;

      const input = pushFloats(ch.times, 'SCALAR', ch.times.length);
      input.acc.min = [Math.min(...ch.times)];
      input.acc.max = [Math.max(...ch.times)];

      const n = ch.values[0].length;
      const type = n === 4 ? 'VEC4' : n === 3 ? 'VEC3' : 'SCALAR';
      const output = pushFloats(ch.values.flat(), type, ch.values.length);

      samplers.push({
        input: input.index,
        output: output.index,
        interpolation: ch.interpolation,
      });
      channels.push({
        sampler: samplers.length - 1,
        target: { node: ch.node, path: ch.path },
      });
    }
    animations.push({ name: clip.name, samplers, channels });
  }

  // 최종 바이너리 조립 — 앞은 옮긴 뷰, 뒤는 새 애니메이션.
  const parts = [];
  let at = 0;
  for (const oi of oldViewIndices) {
    const v = json.bufferViews[oi];
    const padding = pad4(at);
    if (padding) {
      parts.push(Buffer.alloc(padding));
      at += padding;
    }
    parts.push(bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength));
    at += v.byteLength;
  }
  for (const t of tail) {
    const padding = t.offset - at;
    if (padding > 0) {
      parts.push(Buffer.alloc(padding));
      at += padding;
    }
    parts.push(t.buf);
    at += t.buf.length;
  }

  json.accessors = accessors;
  json.bufferViews = views;
  json.animations = animations;
  json.buffers = [{ byteLength: at }];

  // 메시·스킨이 가리키는 접근자 인덱스를 새 번호로 옮긴다.
  const remap = (i) => {
    const n = accessorMap.get(i);
    if (n == null) throw new Error(`접근자 ${i} 가 사라졌다 — 애니메이션 전용으로 잘못 분류했다`);
    return n;
  };
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives) {
      for (const key of Object.keys(prim.attributes)) prim.attributes[key] = remap(prim.attributes[key]);
      if (prim.indices != null) prim.indices = remap(prim.indices);
      for (const target of prim.targets ?? []) {
        for (const key of Object.keys(target)) target[key] = remap(target[key]);
      }
    }
  }
  for (const skin of json.skins ?? []) {
    if (skin.inverseBindMatrices != null) skin.inverseBindMatrices = remap(skin.inverseBindMatrices);
  }

  return Buffer.concat(parts);
}

/* ──────────────────────────────── 본체 ──────────────────────────────── */

function main() {
  const [src, out] = process.argv.slice(2);
  if (!src || !out) {
    console.error('사용법: node tools/build-robot-glb.mjs <감면된.glb> <out.glb>');
    process.exit(1);
  }

  const { json, bin } = readGlb(src);
  const nodeName = (i) => json.nodes[i]?.name ?? `node${i}`;

  if ((json.animations ?? []).length < 2) {
    console.error(`애니메이션이 ${(json.animations ?? []).length}개다 — 걷기·점프 둘이 필요하다`);
    process.exit(1);
  }

  console.log(`\n로봇 아바타 클립 다듬기 — ${src}\n`);

  // 이름이 없으므로 **길이로 가른다.** 걷기가 점프보다 길다 (2.92 vs 1.75).
  const decoded = json.animations.map((a) => decodeClip(json, bin, a));
  decoded.sort((a, b) => clipDuration(b) - clipDuration(a));
  const walk = decoded[0];
  const jump = decoded[1];
  console.log(`  걷기 ← ${JSON.stringify(walk.name)} (${clipDuration(walk).toFixed(2)}s)`);
  console.log(`  점프 ← ${JSON.stringify(jump.name)} (${clipDuration(jump).toFixed(2)}s)`);

  // ① 서 있는 자세는 **루트 모션을 떼기 전에** 고른다. 골반이 앞으로 나간 상태여도
  //    발·손의 상대 위치는 같지만, 뗀 뒤에 고르면 프레임 번호를 다시 맞춰야 한다.
  const stand = findStandingTime(json, walk);
  console.log(
    `\n  서 있는 자세  t=${stand.t.toFixed(3)}s` +
      ` (발간격 ${stand.gap?.toFixed(3)} · 들린발 ${stand.lifted?.toFixed(3)} · 팔벌림 ${stand.arms?.toFixed(3)})`,
  );
  const idle = freezeFrame(walk, stand.t, 'idle');

  // ② 점프에서 가장 크게 뛴 한 주기만 남긴다.
  const hop = findBestHop(json, jump);
  console.log(`  점프 한 주기  ${hop.from.toFixed(3)} ~ ${hop.to.toFixed(3)}s (솟음 ${hop.rise.toFixed(3)})`);
  trimClip(jump, hop.from, hop.to);

  /*
   * ③ 걷기가 스스로 나아가던 속도를 잰다 — **떼기 전에** 재야 한다.
   *
   * avatar.tsx 가 이 값으로 재생 배속을 정한다. 안 맞추면 몸은 2.6m/s 로 나아가는데
   * 다리는 제 속도로 움직여 **발이 얼음판처럼 미끄러진다.** 배속을 코드에 숫자로
   * 박지 않고 이 값에서 나눠 쓰므로, 아바타 키(TARGET_HEIGHT)를 바꿔도 따라온다.
   */
  const walkDur = clipDuration(walk);
  const p0 = worldPositions(json, walk, 0, ['Hip']);
  const p1 = worldPositions(json, walk, walkDur, ['Hip']);
  const travel = Math.hypot(p1.Hip[0] - p0.Hip[0], p1.Hip[2] - p0.Hip[2]);
  const perSec = travel / walkDur;
  console.log(
    `  걷기 전진   ${travel.toFixed(3)} / ${walkDur.toFixed(2)}s = ${perSec.toFixed(4)} 모델단위/초` +
      `  ← avatar.tsx 의 CLIP_WALK_SPEED`,
  );

  // ④ 수평 루트 모션만 제거. 앞뒤 위치는 네트워크가 정하지만 **높이는 클립의 것을 남긴다** —
  //    점프의 도약이 거기 들어 있고, 걷기의 골반 흔들림도 거기서 나온다.
  const roots = new Set([ROOT_BONE]);
  const restOf = (i) => json.nodes[i]?.translation ?? [0, 0, 0];
  const strippedWalk = stripHorizontalTranslation(walk, roots, nodeName, restOf);
  const strippedJump = stripHorizontalTranslation(jump, roots, nodeName, restOf);
  const strippedIdle = stripHorizontalTranslation(idle, roots, nodeName, restOf);
  console.log(`  수평 루트 모션 제거 walk ${strippedWalk} · jump ${strippedJump} · idle ${strippedIdle} 채널`);

  walk.name = 'walk';
  jump.name = 'jump';

  const newBin = rebuild(json, bin, [idle, walk, jump]);
  const size = writeGlb(out, json, newBin);

  console.log(`\n  → ${out}  ${(size / 1048576).toFixed(2)}MB`);
  console.log(`     클립: ${json.animations.map((a) => `${a.name}(${a.channels.length}ch)`).join(' · ')}\n`);
}

main();
