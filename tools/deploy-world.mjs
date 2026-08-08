#!/usr/bin/env node
/**
 * 워커 배포 — NEXT_ORIGIN 을 배포 시점에 실어 보낸다. 소유: A
 *
 *   npm run world:deploy
 *
 * ┌─ 왜 스크립트를 한 겹 두는가 ────────────────────────────────────────────────┐
 * │ wrangler.toml 의 [vars] NEXT_ORIGIN 은 **로컬 기본값**(127.0.0.1:3000)이다.  │
 * │ 그대로 배포하면 워커가 Cloudflare 엣지에서 자기 자신의 127.0.0.1 을 부르고,    │
 * │ 좌석 명단을 못 받아 화면엔 room_unavailable 만 뜬다. 조용히 깨지는 자리다 —    │
 * │ /health 도 200 이고 소켓도 열리는데 방만 비어 보인다.                         │
 * │                                                                            │
 * │ 그래서 배포 경로를 하나로 좁히고, 그 경로가 .env.local 의 NEXT_ORIGIN 을       │
 * │ --var 로 덮어쓴다. 사람이 기억해야 할 값이 한 파일에만 있다.                   │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * 다른 컴퓨터에서 접속하려면 두 주소가 **둘 다 공개**여야 한다.
 *   NEXT_ORIGIN             워커 → Next (좌석 명단). 터널/Vercel 주소
 *   NEXT_PUBLIC_WORLD_WS_URL 브라우저 → 워커. 배포된 wss:// 주소
 * 여기서 그 둘의 짝이 맞는지 먼저 보고, 어긋나면 배포하지 않는다.
 *
 * 옵션
 *   --allow-local        로컬 주소로도 배포한다 (혼자 확인할 때만)
 *   --vars-file <경로>   읽을 파일 (기본 .env.local)
 *                        ★ --env-file 로 이름 짓지 않는다 — node 24 가 그 플래그를 먼저
 *                          가로채서 스크립트가 보기도 전에 "not found"로 죽는다
 *   그 밖의 인자는 wrangler 로 그대로 넘어간다 (--dry-run 등)
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_DIR = resolve(ROOT, 'worker');

/** 다른 컴퓨터에서 절대 닿을 수 없는 호스트. */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)$/i;

/** 월드 워커 이름 (worker/wrangler.toml 의 name). 안내 문구를 만들 때만 쓴다. */
const WORKER_NAME = 'humanish-world';

const args = process.argv.slice(2);
const allowLocal = args.includes('--allow-local');

const envFlag = args.indexOf('--vars-file');
const ENV_FILE = envFlag === -1 ? resolve(ROOT, '.env.local') : resolve(args[envFlag + 1] ?? '');

/** wrangler 가 모르는 옵션은 걸러내고 넘긴다. --vars-file 은 값까지 두 칸이다. */
const passthrough = args.filter(
  (a, i) => a !== '--allow-local' && (envFlag === -1 || (i !== envFlag && i !== envFlag + 1)),
);

let failed = false;

function bad(message, ...hints) {
  failed = true;
  console.error(`  ❌ ${message}`);
  for (const h of hints) console.error(`     ${h}`);
}

function warn(message, ...hints) {
  console.error(`  ⚠️  ${message}`);
  for (const h of hints) console.error(`     ${h}`);
}

/**
 * .env.local 을 읽는다. dotenv 를 끌어오지 않는 이유는 이 저장소가
 * 도구 스크립트에 의존성을 두지 않기 때문이다 (tools/*.mjs 는 전부 내장 모듈만 쓴다).
 */
function readEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }

  const out = {};
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

/** 잘못된 주소를 "왜 안 되는지"까지 붙여 돌려준다. null 이면 배포하지 않는다. */
function parseOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    bad(`NEXT_ORIGIN 을 주소로 읽을 수 없다: ${raw}`, '예) https://<터널>.trycloudflare.com');
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    bad(`NEXT_ORIGIN 의 스킴이 http/https 가 아니다: ${url.protocol}`);
    return null;
  }
  if (LOCAL_HOST.test(url.hostname) && !allowLocal) {
    bad(
      `NEXT_ORIGIN 이 로컬 주소다: ${url.origin}`,
      '배포된 워커는 Cloudflare 엣지에서 돈다 — 거기서 127.0.0.1 은 이 컴퓨터가 아니다.',
      '터널을 띄우고 그 주소를 .env.local 의 NEXT_ORIGIN 에 넣을 것:',
      '  cloudflared tunnel --url http://127.0.0.1:3000',
      '혼자 로컬 워커로 확인할 거면 npm run world:dev 를 쓴다 (배포가 필요 없다).',
    );
    return null;
  }
  // 뒤 슬래시는 room-meta.ts 도 떼지만, 대시보드에 보이는 값도 깔끔한 편이 낫다.
  return url.origin;
}

/** 브라우저가 붙을 주소. NEXT_ORIGIN 과 스킴이 어긋나면 화면에서 조용히 막힌다. */
function checkWsUrl(raw, origin, name = 'WORLD_WS_URL') {
  if (!raw) {
    warn(
      `${name} 이 .env.local 에 없다`,
      '티켓 발급(/api/world/ticket)이 503 을 준다. 배포된 워커의 wss:// 주소를 넣을 것.',
    );
    return;
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    bad(`${name} 을 주소로 읽을 수 없다: ${raw}`);
    return;
  }

  if (LOCAL_HOST.test(url.hostname) && !allowLocal) {
    bad(
      `${name} 이 로컬 주소다: ${url.origin}`,
      '다른 컴퓨터의 브라우저는 이 주소로 붙지 못한다.',
      '배포된 워커 주소(wss://<worker>.<계정>.workers.dev)를 넣을 것.',
    );
    return;
  }

  /*
   * ★ 호스트가 **월드 워커**인지 본다. 여기서 제일 많이 틀렸다 —
   *   Next 앱 주소(humanish.…)를 넣어 두면 소켓이 앱 워커로 가서 404 로 끊긴다.
   *   앱과 월드는 워커가 따로다 (worker/README.md 의 표).
   */
  if (origin.startsWith('https://')) {
    const appHost = new URL(origin).hostname;
    if (url.hostname === appHost) {
      bad(
        `${name} 이 **Next 앱** 주소다: ${url.origin}`,
        '소켓 경로(/rooms/<id>/ws)는 앱 워커에 없다 — 핸드셰이크가 404 로 끊긴다.',
        `월드 워커 주소를 넣을 것: wss://${appHost.replace(/^[^.]+/, `${WORKER_NAME}`)}`,
      );
      return;
    }
  }

  // https 화면에서 ws:// 는 브라우저가 mixed content 로 막는다.
  // 콘솔을 열지 않으면 "월드 서버에 붙지 못했다" 한 줄만 보여서 원인을 찾기 어렵다.
  //
  // ★ 로컬 주소를 이미 허락한 판(--allow-local)에서는 따지지 않는다 (2026-08-09).
  //   ws://127.0.0.1 은 **로컬 개발용 값**이고, 배포본이 브라우저에 내려주는 주소는
  //   이 파일이 아니라 워커 비밀 WORLD_WS_URL 에서 온다 (app/api/world/ticket 이
  //   `WORLD_WS_URL ?? NEXT_PUBLIC_WORLD_WS_URL` 순으로 읽는다). 즉 여기서 막아도
  //   배포본은 안 바뀌고, 통과시키려고 .env.local 을 배포 주소로 되돌리면 **로컬 3D 가
  //   죽은 원격 워커로 나간다.** 바로 위 LOCAL_HOST 검사와 같은 이유로 같이 면제한다.
  const localWs = LOCAL_HOST.test(url.hostname);
  if (origin.startsWith('https://') && url.protocol === 'ws:' && !(allowLocal && localWs)) {
    bad(
      `NEXT_ORIGIN 은 https 인데 ${name} 이 ws:// 다: ${url.origin}`,
      'https 로 열린 화면에서 ws:// 는 브라우저가 막는다. wss:// 로 바꿀 것.',
    );
  } else if (allowLocal && localWs) {
    warn(
      `${name} 이 로컬 주소다 — 넘어간다 (--allow-local)`,
      '배포본이 브라우저에 내려주는 ws 주소는 워커 비밀 WORLD_WS_URL 에서 온다.',
      '확인:  npx wrangler secret list | grep WORLD_WS_URL',
    );
  }
}

/** 배포 전에 한 번 두드려 본다. 터널이 내려가 있으면 배포해도 방이 비어 보인다. */
async function probe(origin) {
  const url = `${origin}/api/internal/world-room?room_id=probe`;
  try {
    // 비밀 없이 부르면 404 가 정상이다 (route.ts 의 notFound). 상태값이 아니라
    // "응답이 돌아온다"는 사실만 본다 — Next 가 살아 있고 밖에서 닿는다는 뜻이다.
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    console.log(`  ✅ NEXT_ORIGIN 응답 확인 (${res.status})`);
  } catch (e) {
    warn(
      `NEXT_ORIGIN 에 닿지 못했다: ${e instanceof Error ? e.message : String(e)}`,
      '지금 꺼져 있을 뿐이라면 그대로 배포해도 된다. 다만 켜기 전에는 방이 비어 보인다.',
      `확인:  curl -sI ${origin}/world`,
    );
  }
}

async function main() {
  console.log('\n워커 배포 — .env.local 의 NEXT_ORIGIN 을 실어 보낸다\n');

  const env = readEnvFile(ENV_FILE);
  if (!env) {
    console.error(`  ❌ 환경 파일이 없다 (${ENV_FILE})`);
    console.error('     .env.local.example 을 복사해 만들고 값을 채울 것');
    process.exit(1);
  }

  const raw = env.NEXT_ORIGIN?.trim();
  if (!raw) {
    console.error(`  ❌ ${ENV_FILE} 에 NEXT_ORIGIN 이 없다`);
    console.error('     워커가 좌석 명단을 물어볼 Next 주소다. .env.local.example 의 3D 월드 블록 참고');
    process.exit(1);
  }

  const origin = parseOrigin(raw);
  if (origin) {
    // ★ 이름이 둘이다. WORLD_WS_URL 이 지금 쓰는 이름이고(런타임에 읽힌다),
    //   NEXT_PUBLIC_WORLD_WS_URL 은 옛 이름이다 — 빌드에 박혀서 고치려면 재빌드가
    //   필요했다. 티켓 라우트가 같은 순서로 고르므로 여기도 같은 순서로 본다.
    const wsName = env.WORLD_WS_URL ? 'WORLD_WS_URL' : 'NEXT_PUBLIC_WORLD_WS_URL';
    const wsRaw = env.WORLD_WS_URL ?? env.NEXT_PUBLIC_WORLD_WS_URL;
    console.log(`  NEXT_ORIGIN              ${origin}`);
    console.log(`  ${wsName.padEnd(24)} ${wsRaw ?? '(없음)'}\n`);
    checkWsUrl(wsRaw?.trim(), origin, wsName);
  }

  if (!env.WORLD_SHARED_SECRET) {
    warn(
      '.env.local 에 WORLD_SHARED_SECRET 이 없다',
      '워커는 이 값으로 티켓 서명을 검증한다. 없으면 모두 unauthorized 로 막힌다.',
    );
  }

  if (failed || !origin) {
    console.error('\n배포하지 않았다. 위 항목을 고치고 다시 실행할 것.\n');
    process.exit(1);
  }

  await probe(origin);

  // ★ --config 를 빼지 않는다. 저장소 루트에 Next 앱용 wrangler.jsonc 가 생긴 뒤로,
  //   cwd 가 worker/ 여도 wrangler 는 루트 설정을 집어간다 (worker/wrangler.toml 이
  //   바로 옆에 있는데도 그렇다). 그러면 이 명령이 월드 워커가 아니라 Next 앱 워커를
  //   NEXT_ORIGIN 만 붙여 배포하려 든다 — 이름이 다르니 조용히 엉뚱한 걸 덮어쓴다.
  const wrangler = spawnSync(
    'npx',
    [
      'wrangler',
      'deploy',
      '--config',
      'wrangler.toml',
      '--var',
      `NEXT_ORIGIN:${origin}`,
      ...passthrough,
    ],
    { cwd: WORKER_DIR, stdio: 'inherit' },
  );
  if (wrangler.status !== 0) process.exit(wrangler.status ?? 1);

  console.log('\n다음 —');
  console.log('  1. 비밀은 --var 로 못 넣는다. 처음 한 번:');
  console.log('       cd worker && npx wrangler secret put WORLD_SHARED_SECRET   # .env.local 과 같은 값');
  console.log('  2. 전체 왕복 확인 (브라우저 없이, 진짜 방을 하나 만든다):');
  console.log(`       NEXT_URL=${origin} npm run world:verify`);
  console.log(`  3. 다른 컴퓨터에서:  ${origin}/world\n`);
  console.log('  터널 주소가 바뀌면 .env.local 을 고치고 이 명령을 다시 실행한다.\n');
}

main().catch((e) => {
  console.error(`\n배포를 끝내지 못했다: ${e.message}\n`);
  process.exit(1);
});
