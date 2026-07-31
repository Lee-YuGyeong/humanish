#!/usr/bin/env node
/**
 * 여러 GLB 에 흩어진 애니메이션 클립을 하나로 합친다. 소유: 원상 (/world)
 *
 *   node tools/merge-glb-anims.mjs <base.glb> <out.glb> idle=a.glb walk=b.glb …
 *
 * ┌─ 왜 필요한가 ──────────────────────────────────────────────────────────┐
 * │ 리깅 서비스(Higgsfield → Meshy)는 **한 번에 클립 하나**만 넣어준다.     │
 * │ 걷기·서기·뛰기·점프를 받으려면 같은 모델로 네 번 돌려야 하고, 그러면    │
 * │ 똑같은 메시가 네 벌 생긴다(2MB × 4). 메시는 base 것 하나만 남기고        │
 * │ 나머지 파일에서는 **애니메이션 트랙만** 뽑아 붙인다.                    │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 채널의 target.node 는 파일마다 인덱스가 다르다. **이름으로 다시 찾는다.**
 *   인덱스를 그대로 믿으면 팔 트랙이 정강이에 붙는 식으로 조용히 어긋난다.
 *   같은 입력 모델을 같은 서비스에 넣었으므로 본 이름은 같다 — 다르면 경고하고
 *   그 채널을 버린다(조용히 틀리게 만들지 않는다).
 *
 * ┌─ ★★ 회전은 그대로 복사하면 안 된다 (리타게팅) ─────────────────────────┐
 * │ glTF 의 회전 채널은 **바인드 포즈를 대체하는 절대 로컬 회전**이다.       │
 * │ 리깅을 클립마다 한 번씩 돌렸으므로(avatar.tsx 머리말) 소스마다 바인드가  │
 * │ 조금씩 다르고, 그 값을 base 뼈대에 그대로 얹으면 그 차이만큼 팔다리가    │
 * │ 통째로 틀어진다 — 팔이 벌어지고 다리가 X 자로 모인다.                   │
 * │                                                                        │
 * │ 그래서 "바인드 대비 얼마나 돌았나"만 옮긴다:                            │
 * │     q' = R_base · R_src⁻¹ · q                                          │
 * │ R_src = 소스 노드의 바인드 회전, R_base = base 노드의 바인드 회전.       │
 * │ 둘이 같으면 q' = q 라 아무 일도 안 일어난다 — 손해가 없다.              │
 * │                                                                        │
 * │ 위치(translation) 채널은 건드리지 않는다. 뼈 길이가 다르면 위치는 스케일 │
 * │ 보정이 필요한데, 그건 이 도구가 판단할 수 없다 — Hips 가 크게 어긋나면   │
 * │ 리깅을 다시 하는 게 맞다.                                              │
 * │                                                                        │
 * │ `--no-retarget` 으로 끌 수 있다(예전 동작과 정확히 같아진다).            │
 * └────────────────────────────────────────────────────────────────────────┘
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** 컴포넌트 타입 → 바이트 수 */
const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
/** 타입 → 컴포넌트 개수 */
const TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

const IDENTITY_Q = [0, 0, 0, 1];

/**
 * 이보다 작은 바인드 차이는 없는 것으로 본다 (도).
 * GLB 가 양자화돼 있어 같은 뼈대라도 마지막 자리가 흔들린다 — 그걸 보정이라고
 * 부르면 0.0° 짜리 샘플러가 파일에 쌓인다.
 */
const BIND_EPS_DEG = 0.05;

/** 해밀턴 곱 (x, y, z, w) — glTF·three 와 같은 순서 */
export function qmul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** 단위 쿼터니언의 역 = 켤레 */
export function qinv(q) {
  return [-q[0], -q[1], -q[2], q[3]];
}

/**
 * 소스 바인드 기준 회전을 base 바인드 기준으로 옮긴다.
 *
 *   q' = R_base · R_src⁻¹ · q
 *
 * R_src === R_base 면 q 를 그대로 돌려준다 (수치 오차도 안 생기게 지름길을 둔다).
 */
export function retargetRotation(q, restSrc, restBase) {
  if (restSrc === restBase) return q;
  const same =
    Math.abs(restSrc[0] - restBase[0]) < 1e-9 &&
    Math.abs(restSrc[1] - restBase[1]) < 1e-9 &&
    Math.abs(restSrc[2] - restBase[2]) < 1e-9 &&
    Math.abs(restSrc[3] - restBase[3]) < 1e-9;
  if (same) return q;
  return qmul(qmul(restBase, qinv(restSrc)), q);
}

/** 두 회전 사이 각도(도). 보정이 얼마나 컸는지 보고할 때 쓴다 */
function angleBetween(a, b) {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
}

function parseGLB(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error(`GLB 가 아니다: ${path}`);
  let offset = 12;
  let json = null;
  let bin = Buffer.alloc(0);
  while (offset < buf.length) {
    const len = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    const body = buf.subarray(offset + 8, offset + 8 + len);
    if (type === CHUNK_JSON) json = JSON.parse(body.toString('utf8'));
    else if (type === CHUNK_BIN) bin = body;
    offset += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error(`JSON 청크가 없다: ${path}`);
  return { json, bin };
}

function writeGLB(path, json, bin) {
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const total =
    12 + 8 + jsonBuf.length + jsonPad + (bin.length ? 8 + bin.length + binPad : 0);

  const out = Buffer.alloc(total);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);

  let p = 12;
  out.writeUInt32LE(jsonBuf.length + jsonPad, p);
  out.writeUInt32LE(CHUNK_JSON, p + 4);
  jsonBuf.copy(out, p + 8);
  out.fill(0x20, p + 8 + jsonBuf.length, p + 8 + jsonBuf.length + jsonPad); // 공백 패딩
  p += 8 + jsonBuf.length + jsonPad;

  if (bin.length) {
    out.writeUInt32LE(bin.length + binPad, p);
    out.writeUInt32LE(CHUNK_BIN, p + 4);
    bin.copy(out, p + 8);
  }
  writeFileSync(path, out);
  return out.length;
}

function main() {
  const args = process.argv.slice(2);
  /** 예전 동작으로 되돌리는 탈출구. 보정이 오히려 이상하면 이걸로 비교한다 */
  const retarget = !args.includes('--no-retarget');
  const [basePath, outPath, ...pairs] = args.filter((a) => a !== '--no-retarget');
  if (!basePath || !outPath || pairs.length === 0) {
    console.error(
      '사용법: node tools/merge-glb-anims.mjs [--no-retarget] <base.glb> <out.glb> name=src.glb …',
    );
    process.exit(1);
  }

  const base = parseGLB(basePath);
  const json = base.json;
  const chunks = [base.bin];
  let binLength = base.bin.length;

  /** 이름 → 노드 인덱스. 채널을 다시 묶는 유일한 열쇠다 */
  const nodeByName = new Map();
  (json.nodes ?? []).forEach((n, i) => {
    if (n.name != null && !nodeByName.has(n.name)) nodeByName.set(n.name, i);
  });

  json.animations = [];
  json.accessors ??= [];
  json.bufferViews ??= [];

  /** src 의 accessor 하나를 base 의 버퍼로 복사하고 새 인덱스를 준다 */
  function copyAccessor(src, index) {
    const acc = src.json.accessors[index];
    const view = src.json.bufferViews[acc.bufferView];
    const stride = COMPONENT_BYTES[acc.componentType] * TYPE_COUNT[acc.type];
    const start = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const bytes = src.bin.subarray(start, start + acc.count * stride);

    const pad = (4 - (binLength % 4)) % 4;
    if (pad) {
      chunks.push(Buffer.alloc(pad));
      binLength += pad;
    }
    const byteOffset = binLength;
    chunks.push(bytes);
    binLength += bytes.length;

    json.bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.length });
    json.accessors.push({
      bufferView: json.bufferViews.length - 1,
      componentType: acc.componentType,
      count: acc.count,
      type: acc.type,
      ...(acc.min ? { min: acc.min } : {}),
      ...(acc.max ? { max: acc.max } : {}),
    });
    return json.accessors.length - 1;
  }

  /** 새로 만든 float 배열을 base 버퍼에 붙이고 accessor 인덱스를 준다 */
  function pushFloatAccessor(values, type) {
    const bytes = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => bytes.writeFloatLE(v, i * 4));

    const pad = (4 - (binLength % 4)) % 4;
    if (pad) {
      chunks.push(Buffer.alloc(pad));
      binLength += pad;
    }
    const byteOffset = binLength;
    chunks.push(bytes);
    binLength += bytes.length;

    json.bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.length });
    json.accessors.push({
      bufferView: json.bufferViews.length - 1,
      componentType: 5126,
      count: values.length / TYPE_COUNT[type],
      type,
    });
    return json.accessors.length - 1;
  }

  /** src accessor 를 float 배열로 읽는다 (회전은 항상 float VEC4 로 나온다) */
  function readFloats(src, index) {
    const acc = src.json.accessors[index];
    if (acc.componentType !== 5126) return null; // 양자화된 트랙 — 손대지 않는다
    const view = src.json.bufferViews[acc.bufferView];
    const start = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const n = acc.count * TYPE_COUNT[acc.type];
    const out = new Array(n);
    for (let i = 0; i < n; i += 1) out[i] = src.bin.readFloatLE(start + i * 4);
    return out;
  }

  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq);
    const src = parseGLB(pair.slice(eq + 1));
    const anim = (src.json.animations ?? [])[0];
    if (!anim) {
      console.warn(`⚠︎ ${name}: 애니메이션이 없다 — 건너뛴다`);
      continue;
    }

    const samplers = anim.samplers.map((s) => ({
      input: copyAccessor(src, s.input),
      output: copyAccessor(src, s.output),
      ...(s.interpolation ? { interpolation: s.interpolation } : {}),
    }));

    let dropped = 0;
    let retargeted = 0;
    let worst = { bone: null, deg: 0 };
    let skippedSpline = 0;
    const channels = [];

    for (const ch of anim.channels) {
      const srcName = src.json.nodes[ch.target.node]?.name;
      const node = srcName != null ? nodeByName.get(srcName) : undefined;
      if (node == null) {
        dropped += 1;
        continue;
      }

      let sampler = ch.sampler;

      // ★ 회전만 바인드 차이를 보정한다 (머리말의 리타게팅 상자 참고)
      if (retarget && ch.target.path === 'rotation') {
        const restSrc = src.json.nodes[ch.target.node]?.rotation ?? IDENTITY_Q;
        const restBase = json.nodes[node]?.rotation ?? IDENTITY_Q;
        const srcSampler = anim.samplers[ch.sampler];

        // 각도를 **먼저** 잰다. 바인드가 사실상 같으면 아무것도 만들지 않는다 —
        // 안 그러면 0.0° 짜리 샘플러가 파일에 쌓인다.
        const deg = angleBetween(restSrc, restBase);
        if (deg > BIND_EPS_DEG) {
          if ((srcSampler.interpolation ?? 'LINEAR') === 'CUBICSPLINE') {
            // 접선까지 같이 돌려야 해서 단순 곱으로는 안 된다. 건드리지 않고 알린다.
            skippedSpline += 1;
          } else {
            const q = readFloats(src, srcSampler.output);
            if (q) {
              const out = new Array(q.length);
              for (let i = 0; i < q.length; i += 4) {
                const fixed = retargetRotation(
                  [q[i], q[i + 1], q[i + 2], q[i + 3]],
                  restSrc,
                  restBase,
                );
                out[i] = fixed[0];
                out[i + 1] = fixed[1];
                out[i + 2] = fixed[2];
                out[i + 3] = fixed[3];
              }
              retargeted += 1;
              if (deg > worst.deg) worst = { bone: srcName, deg };
              sampler = samplers.length;
              samplers.push({
                input: samplers[ch.sampler].input,
                output: pushFloatAccessor(out, 'VEC4'),
                ...(srcSampler.interpolation ? { interpolation: srcSampler.interpolation } : {}),
              });
            }
          }
        }
      }

      channels.push({ sampler, target: { node, path: ch.target.path } });
    }

    if (dropped) console.warn(`⚠︎ ${name}: 이름이 안 맞는 채널 ${dropped}개를 버렸다`);
    if (skippedSpline) {
      console.warn(`⚠︎ ${name}: CUBICSPLINE 회전 ${skippedSpline}개는 보정하지 않았다`);
    }

    json.animations.push({ name, samplers, channels });
    const note = retarget
      ? retargeted === 0
        ? ' · 바인드가 같다 (보정 없음)'
        : ` · 바인드 보정 ${retargeted}개, 최대 ${worst.deg.toFixed(1)}° (${worst.bone})`
      : ' · 보정 끔';
    console.log(`  ${name}: 채널 ${channels.length}개${note}`);
  }

  const bin = Buffer.concat(chunks, binLength);
  json.buffers = [{ byteLength: bin.length }];
  const size = writeGLB(outPath, json, bin);
  console.log(`→ ${outPath} (${(size / 1048576).toFixed(2)}MB, 클립 ${json.animations.length}개)`);
}

// ★ 직접 실행할 때만 돈다. 검사(tests/tools/retarget.test.ts)가 회전 보정 함수만
//   가져다 쓰는데, 그냥 두면 import 하는 순간 main 이 돌아 사용법을 찍고 죽는다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
