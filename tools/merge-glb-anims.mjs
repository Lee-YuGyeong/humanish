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
 */
import { readFileSync, writeFileSync } from 'node:fs';

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** 컴포넌트 타입 → 바이트 수 */
const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
/** 타입 → 컴포넌트 개수 */
const TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

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
  const [basePath, outPath, ...pairs] = process.argv.slice(2);
  if (!basePath || !outPath || pairs.length === 0) {
    console.error('사용법: node tools/merge-glb-anims.mjs <base.glb> <out.glb> name=src.glb …');
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
    const channels = [];
    for (const ch of anim.channels) {
      const srcName = src.json.nodes[ch.target.node]?.name;
      const node = srcName != null ? nodeByName.get(srcName) : undefined;
      if (node == null) {
        dropped += 1;
        continue;
      }
      channels.push({ sampler: ch.sampler, target: { node, path: ch.target.path } });
    }
    if (dropped) console.warn(`⚠︎ ${name}: 이름이 안 맞는 채널 ${dropped}개를 버렸다`);

    json.animations.push({ name, samplers, channels });
    console.log(`  ${name}: 채널 ${channels.length}개`);
  }

  const bin = Buffer.concat(chunks, binLength);
  json.buffers = [{ byteLength: bin.length }];
  const size = writeGLB(outPath, json, bin);
  console.log(`→ ${outPath} (${(size / 1048576).toFixed(2)}MB, 클립 ${json.animations.length}개)`);
}

main();
