#!/usr/bin/env node
/**
 * 워커 격리 검증 — Supabase 없이 RoomDO 만 검사한다. 소유: A
 *
 *   npm run world:smoke
 *
 * wrangler dev 를 직접 띄우고, 좌석 명단 엔드포인트(/api/internal/world-room)만 흉내 내는
 * 임시 HTTP 서버를 물려 소켓 2개로 왕복시킨다. 끝나면 둘 다 내린다.
 *
 * ┌─ 왜 "흉내"가 여기서는 괜찮은가 ────────────────────────────────────────────┐
 * │ 이 저장소는 **DB가 하는 일을 목으로 흉내 내지 않는다** (CLAUDE.md). 그건    │
 * │ 좌석 배정·RLS·상태머신처럼 Postgres 가 판정하는 것들 얘기고, 그건 여전히    │
 * │ supabase/test.sh 가 진짜 Postgres 에 물어본다.                             │
 * │                                                                          │
 * │ 여기서 대신하는 건 DB 가 아니라 **HTTP 응답 한 건의 모양**이다. 검사 대상은 │
 * │ 워커의 입장 판정·릴레이·검증·봇 조종이고, 그건 Supabase 와 아무 상관이 없다. │
 * │ 명단이 진짜인지까지 보려면 tools/verify-world.mjs 를 쓴다 (실제 Next + DB). │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const WORKER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'worker');

/** 일회용 비밀. 진짜 값이 아니어야 한다 — 이 파일은 커밋된다 */
const SECRET = 'smoke-secret-0123456789';
/** 방 id 는 uuid 형태여야 워커의 라우팅 정규식을 통과한다 */
const ROOM = '11111111-2222-4333-8444-555555555555';
/** 평소 개발용 워커(8787)와 부딪히지 않게 다른 포트를 쓴다 */
const WORKER_PORT = 8788;
const FAKE_PORT = 8799;
const WS = `ws://127.0.0.1:${WORKER_PORT}`;
const PROTOCOL_VERSION = 1;

/** 정원 5 · 사람 2 · 봇 3 */
const SEATS = [
  { id: 'aaaaaaaa-0000-4000-8000-000000000001', seat: 1, nickname: '익명1', mask_id: 'mask-01', is_bot: false },
  { id: 'aaaaaaaa-0000-4000-8000-000000000002', seat: 2, nickname: '익명2', mask_id: 'mask-02', is_bot: false },
  { id: 'bbbbbbbb-0000-4000-8000-000000000003', seat: 3, nickname: '익명3', mask_id: 'mask-03', is_bot: true },
  { id: 'bbbbbbbb-0000-4000-8000-000000000004', seat: 4, nickname: '익명4', mask_id: 'mask-04', is_bot: true },
  { id: 'bbbbbbbb-0000-4000-8000-000000000005', seat: 5, nickname: '익명5', mask_id: 'mask-05', is_bot: true },
];

const enc = new TextEncoder();
const b64u = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** lib/mp/ticket.ts 의 signTicket 과 같은 형식 */
async function sign(payload) {
  const full = { ...payload, exp: Math.floor(Date.now() / 1000) + 60 };
  const body = b64u(enc.encode(JSON.stringify(full)));
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return `${body}.${b64u(new Uint8Array(sig))}`;
}

let failures = 0;
const ok = (l) => console.log(`  ✅ ${l}`);
const bad = (l, d) => {
  failures++;
  console.log(`  ❌ ${l}${d ? ` — ${d}` : ''}`);
};

async function check(label, fn) {
  try {
    await fn();
    ok(label);
  } catch (e) {
    bad(label, e.message);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(label) {
    this.label = label;
    this.msgs = [];
  }

  connect(ticket, version = PROTOCOL_VERSION) {
    return new Promise((resolve_, reject) => {
      const ws = new WebSocket(`${WS}/rooms/${ROOM}/ws?t=${encodeURIComponent(ticket)}&v=${version}`);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error(`${this.label}: 응답 없음`)), 8000);

      ws.addEventListener('message', (e) => {
        if (e.data === 'pong') return;
        const m = JSON.parse(e.data);
        this.msgs.push(m);
        if (m.t === 'welcome') {
          this.selfId = m.selfId;
          clearTimeout(timer);
          resolve_(m);
        }
        if (m.t === 'error') {
          clearTimeout(timer);
          reject(new Error(m.code));
        }
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('연결 실패'));
      });
    });
  }

  send(o) {
    this.ws.send(JSON.stringify(o));
  }

  close() {
    this.ws.close();
  }

  wait(pred, ms, label) {
    const hit = this.msgs.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const h = this.msgs.find(pred);
        if (h) {
          clearInterval(iv);
          res(h);
        } else if (Date.now() - t0 > ms) {
          clearInterval(iv);
          rej(new Error(`${label} 을(를) ${ms}ms 안에 못 받았다`));
        }
      }, 50);
    });
  }
}

/* ─────────────────────────────── 준비 ─────────────────────────────── */

const fake = http.createServer((req, res) => {
  // 공유 비밀이 없으면 404. 진짜 라우트와 같은 규칙이다
  if (req.headers.authorization !== `Bearer ${SECRET}`) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ capacity: 5, phase: 'question', seats: SEATS, bot_lines: ['테스트 문구'] }));
});

const worker = spawn(
  'npx',
  [
    'wrangler',
    'dev',
    '--port',
    String(WORKER_PORT),
    '--var',
    `WORLD_SHARED_SECRET:${SECRET}`,
    '--var',
    `NEXT_ORIGIN:http://127.0.0.1:${FAKE_PORT}`,
  ],
  { cwd: WORKER_DIR, stdio: 'ignore' },
);

function shutdown(code) {
  worker.kill('SIGTERM');
  fake.close();
  process.exit(code);
}
process.on('SIGINT', () => shutdown(1));

async function waitForWorker() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${WORKER_PORT}/health`);
      if (res.ok) return;
    } catch {
      // 아직 안 떴다
    }
    await sleep(1000);
  }
  throw new Error('wrangler dev 가 60초 안에 뜨지 않았다 (cd worker && npm install 확인)');
}

/* ─────────────────────────────── 검사 ─────────────────────────────── */

async function main() {
  await new Promise((r) => fake.listen(FAKE_PORT, '127.0.0.1', r));
  console.log(`\n워커 격리 검증 — ${WS}\n  wrangler dev 를 띄우는 중…`);
  await waitForWorker();
  console.log('');

  const tA = await sign({ rid: ROOM, pid: SEATS[0].id, seat: 1, nick: '익명1', mask: 'mask-01' });
  const tB = await sign({ rid: ROOM, pid: SEATS[1].id, seat: 2, nick: '익명2', mask: 'mask-02' });
  const tBot = await sign({ rid: ROOM, pid: SEATS[2].id, seat: 3, nick: '익명3', mask: 'mask-03' });

  const a = new Client('A');
  const b = new Client('B');

  await check('A 입장 — 명부에 봇 3기가 있다 (정원 5 · 사람 1)', async () => {
    const w = await a.connect(tA);
    if (w.players.length !== 3) throw new Error(`명부가 ${w.players.length}명이다`);
    // ★ 사람/봇을 가르는 필드가 새지 않았는지 본다. 새면 게임이 즉시 끝난다 (I1)
    const leaked = w.players.flatMap((p) => Object.keys(p).filter((k) => /bot|role|ai/i.test(k)));
    if (leaked.length) throw new Error(`정체가 새는 필드: ${leaked.join(',')}`);
  });

  await check('B 입장 — 명부에 A가 있다', async () => {
    const w = await b.connect(tB);
    if (!w.players.some((p) => p.id === a.selfId)) throw new Error('B의 welcome에 A가 없다');
  });

  await check('A는 B의 입장을 통보받는다', () =>
    a.wait((m) => m.t === 'player_joined' && m.player.id === b.selfId, 3000, 'player_joined'),
  );

  await check('프로토콜 버전이 다르면 거절한다', async () => {
    try {
      await new Client('V').connect(tA, 99);
      throw new Error('통과돼 버렸다');
    } catch (e) {
      if (e.message !== 'version_mismatch') throw e;
    }
  });

  await check('봇 좌석의 티켓으로는 들어올 수 없다', async () => {
    // 티켓을 위조해도 좌석 명단에서 걸린다
    try {
      await new Client('BOT').connect(tBot);
      throw new Error('통과돼 버렸다');
    } catch (e) {
      if (e.message !== 'unauthorized') throw e;
    }
  });

  await check('A가 움직이면 B가 받는다', async () => {
    a.send({ t: 'move', x: 1.25, z: -2.5, heading: 0.75, anim: 'walk' });
    const g = await b.wait((m) => m.t === 'player_moved' && m.id === a.selfId, 3000, 'player_moved');
    if (Math.abs(g.x - 1.25) > 1e-6) throw new Error(`x가 ${g.x}로 왔다`);
  });

  await check('월드 밖 · NaN · 모르는 anim 은 릴레이되지 않는다', async () => {
    const before = b.msgs.length;
    // 사이를 띄운다. 붙여 보내면 이동 속도 제한에 먼저 걸려서 **검증을 통과했는지
    // 아닌지 알 수 없게 된다** — 통과는 하지만 아무것도 검사하지 않는 테스트가 된다.
    for (const bad of [
      { t: 'move', x: 9999, z: 0, heading: 0, anim: 'walk' },
      { t: 'move', x: null, z: 0, heading: 0, anim: 'walk' },
      { t: 'move', x: 0, z: 0, heading: 0, anim: 'fly' },
    ]) {
      a.send(bad);
      await sleep(120);
    }
    const relayed = b.msgs.slice(before).filter((m) => m.t === 'player_moved' && m.id === a.selfId);
    if (relayed.length) throw new Error(`${relayed.length}건이 그대로 나갔다`);
  });

  await check('이동을 쏟아부어도 서버가 바닥을 깐다', async () => {
    // 막지 않으면 소켓 하나가 방 전원에게 N배로 증폭돼 뿌려진다 (프레임 저하 · 워커 요금).
    const before = b.msgs.filter((m) => m.t === 'player_moved' && m.id === a.selfId).length;
    for (let i = 0; i < 60; i++) {
      a.send({ t: 'move', x: i * 0.05, z: 0, heading: 0, anim: 'walk' });
    }
    await sleep(700);
    const passed =
      b.msgs.filter((m) => m.t === 'player_moved' && m.id === a.selfId).length - before;
    // 700ms · 50ms 바닥 → 최대 15건 남짓. 60건이 다 나가면 상한이 없는 것이다
    if (passed > 20) throw new Error(`60건 중 ${passed}건이 통과했다`);
    if (passed === 0) throw new Error('한 건도 안 나갔다 — 너무 빡빡하다');
  });

  await check('채팅은 본인을 포함해 전달된다', async () => {
    a.send({ t: 'chat', text: '들리나' });
    const g = await b.wait((m) => m.t === 'chat' && m.id === a.selfId, 3000, 'chat');
    if (g.text !== '들리나') throw new Error(`text가 "${g.text}"로 왔다`);
    if (typeof g.ts !== 'number') throw new Error('ts가 서버 시각이 아니다');
    // 본인 에코가 없으면 내 화면과 남의 화면에서 메시지 순서가 달라진다
    await a.wait((m) => m.t === 'chat' && m.id === a.selfId, 2000, '본인 에코');
  });

  await check('채팅 속도 제한이 걸린다 (600ms)', async () => {
    await sleep(700); // 직전 검사에서 방금 말했다. 제한이 풀린 뒤부터 센다
    const before = b.msgs.filter((m) => m.t === 'chat').length;
    a.send({ t: 'chat', text: '1' });
    a.send({ t: 'chat', text: '2' });
    a.send({ t: 'chat', text: '3' });
    await sleep(600);
    const passed = b.msgs.filter((m) => m.t === 'chat').length - before;
    if (passed !== 1) throw new Error(`3건 중 ${passed}건이 통과했다 (1건을 기대)`);
  });

  await check('봇이 스스로 움직인다 (서버가 조종한다)', async () => {
    // 이 검사가 이 스크립트의 핵심이다. 봇 조종을 클라이언트가 대신하면
    // 그 브라우저가 정답을 알게 된다 (I1). 봇은 최대 7초 서 있다가 출발한다
    const humans = new Set([a.selfId, b.selfId]);
    await b.wait((m) => m.t === 'player_moved' && !humans.has(m.id), 12_000, '봇의 player_moved');
  });

  await check('A가 끊기면 B가 안다', async () => {
    a.close();
    await b.wait((m) => m.t === 'player_left' && m.id === a.selfId, 4000, 'player_left');
  });

  b.close();
  console.log(failures === 0 ? '\n전부 통과\n' : `\n실패 ${failures}건\n`);
  shutdown(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\n검증을 끝내지 못했다: ${e.message}\n`);
  shutdown(1);
});
