# 3D 월드 멀티플레이 워커

방 하나 = Durable Object 하나. 사람 소켓을 릴레이하고, **빈자리를 채운 봇 아바타를
서버가 직접 조종한다.** 게임 규칙·DB는 여기 없다 — 그건 Supabase와 `app/api/`가 맡는다.

```
브라우저 ─WS→ Worker(라우팅) ─→ RoomDO("<room_id>")
                                   ├ 사람 소켓 N개 (좌표는 소켓 attachment)
                                   └ 봇 아바타 M기 (100ms 시뮬레이션)
```

## 왜 별도 서버인가

봇 아바타를 **누군가의 브라우저가 대신 움직이면 그 브라우저는 누가 봇인지 안다.**
호스트 한 명이 정답을 들고 게임하는 셈이라 게임이 성립하지 않는다 (CLAUDE.md I1).
서버 권위가 필요한 건 이 한 가지 때문이고, 그래서 인프라를 하나 늘렸다.

SPEC §11의 "별도 WebSocket 서버를 쓰지 않는다"에 대한 의도적 예외다.
Supabase 스키마·RLS·Realtime은 **한 줄도 건드리지 않는다.**

## 준비

```bash
cd worker && npm install          # wrangler · workers-types
```

비밀은 파일이 아니라 두 곳에 넣는다.

```bash
# 로컬 — worker/.dev.vars 를 직접 만든다 (.gitignore 에 이미 있다)
#   WORLD_SHARED_SECRET=<openssl rand -hex 32 로 뽑은 값>
#   .env.local 의 WORLD_SHARED_SECRET 과 **같은 값**이어야 한다

# 배포
npx wrangler secret put WORLD_SHARED_SECRET
```

`NEXT_ORIGIN`은 비밀이 아니라 `wrangler.toml`의 `[vars]`에 있다. 배포할 때 Vercel 주소로 바꾼다.

## 실행

```bash
# 워커만 검사 — Next도 Supabase도 필요 없다 (wrangler dev 를 직접 띄웠다 내린다)
npm run world:smoke

# 전체
npm run dev          # 터미널 1 — Next (티켓 발급 + 좌석 명단 제공)
npm run world:dev    # 터미널 2 — 워커
npm run world:verify # 터미널 3 — 2인 왕복 검증 (브라우저 없이)
```

## 경로

| 경로 | 용도 |
|---|---|
| `GET /health` | 배포 확인 |
| `GET /rooms/<uuid>/info` | 로비용 `{ capacity, occupied, phase }` |
| `GET /rooms/<uuid>/ws?t=<티켓>&v=1` | 방 접속 (WebSocket 업그레이드) |

`<uuid>`는 `rooms.id`다. **4자 방 코드를 쓰지 않는다** — 추측 가능하고 재사용된다 (SPEC §16.4).

## 절대 어기면 안 되는 것

1. **클라이언트로 나가는 어떤 메시지에도 사람/봇을 가를 정보를 넣지 않는다** (I1).
   봇 좌표는 사람과 **같은** `player_moved` 스트림을, **같은** 10Hz 주기로 탄다.
   "A→B로 4초간 이동" 같은 계획으로 보내면 devtools에서 한눈에 갈린다.
2. `/api/internal/world-room` 응답(= `is_bot` 포함)은 **워커 밖으로 나가지 않는다.**
3. 프로토콜은 `lib/mp/protocol.ts` 한 곳에서만 정의한다. 워커에 복붙하지 않는다.
4. `PROTOCOL_VERSION`을 올렸으면 **워커를 클라이언트보다 먼저 배포한다.**
   반대로 하면 새 클라이언트가 구 워커에 `version_mismatch`로 막힌다.
5. `[[migrations]]`의 `tag`를 바꾸거나 지우지 않는다.

## 알아둘 것

- **틱 루프가 있다.** 순수 릴레이라면 없어야 맞지만 봇 조종 때문에 필요하다.
  사람이 1명 이상 + 봇이 1기 이상일 때만 돌고, 마지막 사람이 나가면 즉시 멈춘다.
  DO가 evict돼 타이머가 날아가도 30초 알람과 다음 수신 메시지가 되살린다.
- **하트비트는 DO를 깨우지 않는다.** `setWebSocketAutoResponse("ping","pong")`을
  플랫폼이 대신 처리한다. 죽은 소켓은 30초 알람이 청소한다.
- **채팅은 저장하지 않는다.** 릴레이만 한다 — 방이 사라지면 로그도 없다.
  게임의 대화 기록은 Supabase `messages`가 따로 갖는다 (SPEC §6.1).
