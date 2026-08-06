#!/usr/bin/env node
/**
 * 3D 월드 2인 왕복 검증 (브라우저 없이). 소유: A
 *
 * 타입체크가 통과했다는 건 멀티플레이가 **동작한다는 증거가 못 된다.**
 * 실제로 소켓 두 개를 붙여 서로가 보이는지, 이동·채팅·퇴장이 전달되는지 확인한다.
 *
 *   npm run dev        # 터미널 1 — Next
 *   npm run world:dev  # 터미널 2 — 워커
 *   npm run world:verify
 *
 * Node 22+ 내장 WebSocket을 쓴다. 의존성이 없다.
 *
 * 검사 항목
 *   1. 두 사람이 서로를 본다 (welcome / player_joined)
 *   2. A가 움직이면 B가 받는다 (player_moved)
 *   3. A가 말하면 B가 받는다 (chat — 본인 포함 브로드캐스트)
 *   4. **봇이 스스로 움직인다** (서버가 조종하는 아바타. 사람 둘 중 누구도 아닌 id)
 *   5. A가 끊기면 B가 안다 (player_left)
 *
 * 4번이 이 스크립트의 핵심이다. 봇 조종을 클라이언트가 대신하면 그 브라우저가
 * 정답을 알게 되므로(I1) 서버가 직접 움직여야 하고, 그건 여기서만 확인된다.
 */

const NEXT = process.env.NEXT_URL ?? 'http://127.0.0.1:3000';
const PROTOCOL_VERSION = 4;

let failures = 0;

function ok(label) {
  console.log(`  ✅ ${label}`);
}
function fail(label, detail) {
  failures++;
  console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
}

/** 쿠키 한 사람 몫. fetch는 쿠키를 저장하지 않으므로 직접 들고 다닌다. */
class Jar {
  constructor(name) {
    this.name = name;
    this.cookies = new Map();
  }

  header() {
    return Array.from(this.cookies, ([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(res) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  async post(path, body) {
    const res = await fetch(`${NEXT}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: this.header() },
      body: JSON.stringify(body),
    });
    this.absorb(res);
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${path} 응답이 JSON이 아니다 (${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok) throw new Error(`${path} ${res.status}: ${data.error ?? text.slice(0, 200)}`);
    return data;
  }
}

/** 워커에 붙어 받은 메시지를 전부 모아 두는 클라이언트. */
class Client {
  constructor(label) {
    this.label = label;
    this.messages = [];
    this.selfId = null;
    this.closed = false;
  }

  connect(wsUrl, roomId, ticket) {
    return new Promise((resolve, reject) => {
      const url = `${wsUrl.replace(/\/$/, '')}/rooms/${roomId}/ws?t=${encodeURIComponent(ticket)}&v=${PROTOCOL_VERSION}`;
      const ws = new WebSocket(url);
      this.ws = ws;

      const timer = setTimeout(() => reject(new Error(`${this.label}: welcome이 오지 않는다`)), 8000);

      ws.addEventListener('message', (e) => {
        if (e.data === 'pong') return;
        const msg = JSON.parse(e.data);
        this.messages.push(msg);
        if (msg.t === 'welcome') {
          this.selfId = msg.selfId;
          clearTimeout(timer);
          resolve(msg);
        }
        if (msg.t === 'error') {
          clearTimeout(timer);
          reject(new Error(`${this.label}: 서버가 거절했다 — ${msg.code}`));
        }
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`${this.label}: 워커에 붙지 못했다 (npm run world:dev 확인)`));
      });
      ws.addEventListener('close', () => {
        this.closed = true;
      });
    });
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  close() {
    this.ws.close();
  }

  /** 조건을 만족하는 메시지를 기다린다. 이미 받은 것부터 훑는다. */
  waitFor(pred, ms, label) {
    const found = this.messages.find(pred);
    if (found) return Promise.resolve(found);

    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = setInterval(() => {
        const hit = this.messages.find(pred);
        if (hit) {
          clearInterval(tick);
          resolve(hit);
        } else if (Date.now() - started > ms) {
          clearInterval(tick);
          reject(new Error(`${this.label}: ${label} 을(를) ${ms}ms 안에 못 받았다`));
        }
      }, 50);
    });
  }
}

async function check(label, fn) {
  try {
    await fn();
    ok(label);
  } catch (e) {
    fail(label, e.message);
  }
}

async function main() {
  console.log(`\n3D 월드 검증 — Next ${NEXT}\n`);

  const a = new Jar('A');
  const b = new Jar('B');

  // 1) 방을 만들고 둘이 들어간 뒤 게임을 시작한다.
  //    시작해야 AI 자리가 생긴다 (POST /api/room/start — 2026-08-06 부터 **1대**다).
  //    ★ 명부의 길이는 정원이 아니라 **사람 + AI** 다 — welcome 은 접속 여부와
  //      무관하게 전 좌석을 담는다. 여기서는 사람 둘 + AI 하나 = 3이다.
  const HUMANS = 2;
  const AI_SEATS = 1;
  const SEATS = HUMANS + AI_SEATS;
  const created = await a.post('/api/room');
  const roomId = created.room.id;
  const code = created.room.code;
  console.log(`  방 ${code} (${roomId})`);

  await b.post('/api/room/join', { code });

  // ★ 2026-08-06 부터 **전원이 준비를 눌러야** 시작된다 (lib/game/rules.ts 의 startBlock).
  //   빠뜨리면 아래 start 가 409 로 떨어지고 검증이 통째로 멈춘다 — 실제로 그렇게 걸렸다.
  await a.post('/api/lobby/ready', { room_id: roomId, ready: true });
  await b.post('/api/lobby/ready', { room_id: roomId, ready: true });
  await a.post('/api/room/start', { room_id: roomId });

  const ticketA = await a.post('/api/world/ticket', { room_id: roomId });
  const ticketB = await b.post('/api/world/ticket', { room_id: roomId });
  console.log(`  워커 ${ticketA.ws_url}\n`);

  const clientA = new Client('A');
  const clientB = new Client('B');

  const welcomeA = await clientA.connect(ticketA.ws_url, roomId, ticketA.ticket);
  const welcomeB = await clientB.connect(ticketB.ws_url, roomId, ticketB.ticket);

  await check('welcome 은 **전 좌석**이다 (미접속 사람 포함)', async () => {
    /*
     * ★ 예전엔 여기서 "봇 3"을 기대했다. 그게 곧 누출이었다 —
     *   welcome 이 **접속한 사람 + 봇 전부**였으므로, 방에 제일 먼저 들어가면
     *   명부에 있는 id 가 전부 봇이었다. 첫 프레임만 보면 정답이 나왔다 (I1).
     *
     *   지금 명부는 **좌석 명단**이다: 자리가 셋이면 아직 아무도 안 붙어도 3명이다.
     *   미접속 사람은 마지막 자세(없으면 spawnFor 자리)로 들어가고, 봇 좌석과
     *   필드 모양이 완전히 같다. 그래서 "명부에 있다"로는 아무것도 못 가른다.
     */
    if (welcomeA.players.length !== SEATS) {
      throw new Error(`명부가 ${welcomeA.players.length}명이다 (전 좌석 ${SEATS}을 기대)`);
    }
    // 본인도 명부에 들어 있어야 한다. 본인만 빠지면 "빠진 자리 = 나"가 아니라
    // 남의 화면에서 내 자리가 통째로 비어 보인다 (아바타가 안 그려진다).
    if (!welcomeA.players.some((p) => p.id === clientA.selfId)) {
      throw new Error('명부에 본인이 없다');
    }
    // ★ 사람/봇을 가르는 필드가 새지 않았는지 본다. 이게 새면 게임이 즉시 끝난다 (I1)
    const leaked = welcomeA.players.flatMap((p) =>
      Object.keys(p).filter((k) => /bot|role|ai/i.test(k)),
    );
    if (leaked.length) throw new Error(`정체가 새는 필드: ${leaked.join(',')}`);
  });

  await check('B의 명부에 A가 있다', async () => {
    if (!welcomeB.players.some((p) => p.id === clientA.selfId)) {
      throw new Error('B의 welcome에 A가 없다');
    }
  });

  await check('사람이 붙어도 player_joined 가 나가지 않는다 (I1)', async () => {
    /*
     * ★ 이 검사는 **뒤집혔다.** 예전엔 "A는 B의 입장을 통보받는다"였는데,
     *   player_joined 가 사람에게만 나가는 이벤트라 거기 한 번 등장한 id 는
     *   그 순간 사람 확정이었다. 4분짜리 판에서 새로고침 한 번이면 아웃이다.
     *
     *   지금은 좌석이 이미 welcome 에 들어 있으므로 붙고 끊는 것으로는
     *   아무 이벤트도 나지 않는다. 입퇴장은 **좌석 명단이 바뀔 때만** 난다
     *   (ensureMeta 의 diff — 사람·봇 구분 없이).
     */
    const leaked = await clientA
      .waitFor((m) => m.t === 'player_joined' && m.player.id === clientB.selfId, 1500, 'player_joined')
      .then(() => true)
      .catch(() => false);
    if (leaked) throw new Error('B 가 붙자 player_joined 가 나갔다 — 그 id 는 사람 확정이다');
  });

  await check('A가 움직이면 B가 받는다 (점프 높이 포함)', async () => {
    clientA.send({ t: 'move', x: 1.25, z: -2.5, y: 0.8, heading: 0.75, anim: 'walk' });
    const got = await clientB.waitFor(
      (m) => m.t === 'player_moved' && m.id === clientA.selfId,
      3000,
      'player_moved',
    );
    if (Math.abs(got.x - 1.25) > 1e-6) throw new Error(`x가 ${got.x}로 왔다`);
    // y가 빠지면 남의 점프가 바닥에 붙어 보인다. 타입체크로는 안 잡힌다
    if (Math.abs((got.y ?? 0) - 0.8) > 1e-6) throw new Error(`y가 ${got.y}로 왔다`);
  });

  await check('월드 밖 좌표는 거절된다', async () => {
    const before = clientB.messages.length;
    clientA.send({ t: 'move', x: 9999, z: 0, y: 0, heading: 0, anim: 'walk' });
    clientA.send({ t: 'move', x: Number.NaN, z: 0, y: 0, heading: 0, anim: 'walk' });
    // 천장 위를 떠다니는 아바타도 같은 문으로 막힌다
    clientA.send({ t: 'move', x: 0, z: 0, y: 50, heading: 0, anim: 'walk' });
    await new Promise((r) => setTimeout(r, 500));
    const relayed = clientB.messages
      .slice(before)
      .filter((m) => m.t === 'player_moved' && m.id === clientA.selfId);
    if (relayed.length) throw new Error(`${relayed.length}건이 그대로 릴레이됐다`);
  });

  await check('A가 말하면 B가 받는다', async () => {
    clientA.send({ t: 'chat', text: '들리나' });
    const got = await clientB.waitFor((m) => m.t === 'chat' && m.id === clientA.selfId, 3000, 'chat');
    if (got.text !== '들리나') throw new Error(`text가 "${got.text}"로 왔다`);
    if (typeof got.ts !== 'number') throw new Error('ts가 서버 시각이 아니다');
  });

  await check('봇이 스스로 움직인다 (서버 조종)', async () => {
    const humans = new Set([clientA.selfId, clientB.selfId]);
    // 봇은 최대 7초를 서 있다가 출발한다 (BOT_IDLE_MAX_MS).
    await clientB.waitFor(
      (m) => m.t === 'player_moved' && !humans.has(m.id),
      12_000,
      '봇의 player_moved',
    );
  });

  await check('사람이 끊겨도 player_left 가 나가지 않는다 (I1)', async () => {
    /*
     * ★ 이것도 뒤집혔다. player_left 는 사람에게만 나던 이벤트라, 봇은 영원히
     *   나가지 않는 반면 사람은 새로고침 한 번에 자기를 드러냈다.
     *   지금은 끊긴 사람의 자리가 마지막 자세로 명부에 남는다 —
     *   "가만히 서 있는 사람"과 구분되지 않는 게 요점이다.
     */
    clientA.close();
    const leaked = await clientB
      .waitFor((m) => m.t === 'player_left' && m.id === clientA.selfId, 2500, 'player_left')
      .then(() => true)
      .catch(() => false);
    if (leaked) throw new Error('A 가 끊기자 player_left 가 나갔다 — 그 id 는 사람 확정이다');
  });

  clientB.close();

  await verifyGate();

  console.log(failures === 0 ? '\n전부 통과\n' : `\n실패 ${failures}건\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * 집결 게이트 — **방 사람이 전부 들어와야 판이 열린다** (lib/mp/protocol.ts 의 t:'gate').
 *
 * 위 흐름과 방을 **같이 쓸 수 없다.** 저긴 2D 시작(/api/room/start)이라 phase 가
 * 넘어가 있고, 월드 시작(/api/room/start-world)은 phase 가 'lobby' 인 방만 받는다.
 * 게이트가 걸리는 조건 자체가 "방장이 월드 시작을 눌렀나"라서 새 방이 필요하다.
 *
 * 브라우저로는 사람 둘을 서로 다른 시각에 붙여야 재현되는 흐름이고, 틀렸을 때의
 * 증상이 **"방이 영원히 시작 안 됨"** 이라 여기서 잡는 게 제일 싸다.
 */
async function verifyGate() {
  console.log('\n  ── 집결 게이트 ──\n');

  const a = new Jar('GA');
  const b = new Jar('GB');

  // 정원은 이제 고르지 않는다 (2026-08-06 — 사람 8 고정 + AI 1).
  const created = await a.post('/api/room');
  const roomId = created.room.id;
  await b.post('/api/room/join', { code: created.room.code });

  // ★ 월드 시작도 **전원 준비**를 요구한다 (lib/game/rules.ts 의 startBlock — 2D 시작과
  //   같은 함수다). 빠뜨리면 start-world 가 409 로 떨어지고 게이트 검사가 통째로 멈춘다.
  await a.post('/api/lobby/ready', { room_id: roomId, ready: true });
  await b.post('/api/lobby/ready', { room_id: roomId, ready: true });

  // 2D 시작이 아니다 — 이쪽만 world_started_at 을 찍고 게이트를 만든다.
  await a.post('/api/room/start-world', { room_id: roomId });

  const ticketA = await a.post('/api/world/ticket', { room_id: roomId });
  const ticketB = await b.post('/api/world/ticket', { room_id: roomId });

  const clientA = new Client('GA');
  await clientA.connect(ticketA.ws_url, roomId, ticketA.ticket);

  await check('혼자 들어오면 게이트가 안 열린다 (startsAt 이 null)', async () => {
    const gate = await clientA.waitFor((m) => m.t === 'gate', 4000, 'gate');
    if (gate.startsAt !== null) throw new Error(`혼자인데 startsAt 이 ${gate.startsAt} 이다`);
    if (gate.total !== 2) throw new Error(`total 이 ${gate.total} 이다 (사람 2명이어야 한다)`);
    if (gate.present !== 1) throw new Error(`present 가 ${gate.present} 이다`);
  });

  await check('게이트에는 좌석이 실리지 않는다 — 숫자 둘뿐이다 (I1)', async () => {
    const gate = await clientA.waitFor((m) => m.t === 'gate', 2000, 'gate');
    const allowed = new Set(['t', 'present', 'total', 'startsAt']);
    const extra = Object.keys(gate).filter((k) => !allowed.has(k));
    if (extra.length) throw new Error(`모르는 필드가 실려 있다: ${extra.join(', ')}`);
  });

  await check('게이트가 닫혀 있으면 intro_done 으로도 판이 안 열린다', async () => {
    clientA.send({ t: 'intro_done' });
    const opened = await clientA
      .waitFor((m) => m.t === 'round', 2500, 'round')
      .then(() => true)
      .catch(() => false);
    if (opened) throw new Error('혼자 보낸 intro_done 하나로 판이 열렸다');
  });

  const clientB = new Client('GB');
  await clientB.connect(ticketB.ws_url, roomId, ticketB.ticket);

  await check('전원이 들어오면 게이트가 열린다 (startsAt 이 서버 시각)', async () => {
    const gate = await clientA.waitFor(
      (m) => m.t === 'gate' && m.startsAt !== null,
      5000,
      '열린 gate',
    );
    if (gate.present !== 2) throw new Error(`present 가 ${gate.present} 이다`);
    if (typeof gate.startsAt !== 'number') throw new Error('startsAt 이 숫자가 아니다');
    // 인트로 준비 시간(WORLD_INTRO_MS=20초) 뒤여야 한다. 지금이면 카운트다운이 없다.
    if (gate.startsAt <= Date.now()) throw new Error('startsAt 이 이미 지난 시각이다');
  });

  await check('늦게 들어온 사람도 게이트 상태를 받는다', async () => {
    const gate = await clientB.waitFor((m) => m.t === 'gate', 3000, 'gate');
    if (gate.startsAt === null) throw new Error('B 는 대기 상태로 굳는다');
  });

  clientA.close();
  clientB.close();
}

main().catch((e) => {
  console.error(`\n검증을 끝내지 못했다: ${e.message}\n`);
  process.exit(1);
});
