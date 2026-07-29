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

**로컬은 따로 넣을 게 없다.** `npm run dev`가 `--env-file ../.env.local`로 저장소 루트의
`.env.local`을 그대로 읽는다. 거기 `WORLD_SHARED_SECRET`만 있으면 된다
(`openssl rand -hex 32`). Next와 워커가 **같은 파일**을 보므로 두 값이 갈릴 수 없다 —
예전엔 `worker/.dev.vars`를 따로 만들어야 했고, 그걸 잊으면 워커가 `Bearer undefined`를
보내 `/api/internal/world-room`이 404를 주고 화면엔 `room_unavailable`만 떴다.

배포는 파일이 없으니 Cloudflare에 직접 넣는다. **한 번만** 하면 된다.

```bash
# 저장소 루트에서. --config 를 반드시 붙인다 (바로 아래 「★ --config」 참고)
npx wrangler secret put WORLD_SHARED_SECRET --config worker/wrangler.toml
```

> **★ `--config` 를 빼지 않는다.** 저장소 루트에 Next 앱용 `wrangler.jsonc`가 생긴 뒤로,
> `cd worker` 를 해도 wrangler 는 **루트 설정을 집어간다** — 바로 옆에 `wrangler.toml`이
> 있는데도 그렇다. 즉 `cd worker && npx wrangler secret put ...` 은 월드 워커가 아니라
> **Next 앱 워커에 비밀을 넣는다.** 에러도 안 난다.
>
> ```bash
> cd worker && npx wrangler secret list          # → Worker "humanish" not found  ← 루트를 봤다는 증거
> npx wrangler secret list --config worker/wrangler.toml   # → humanish-world 의 목록
> ```
>
> `npm run world:dev` · `world:deploy` · `world:smoke` 는 이미 `--config` 를 박아 뒀다.
> 손으로 부를 때만 조심하면 된다.

`NEXT_ORIGIN`은 비밀이 아니다. `wrangler.toml`의 `[vars]`에 있는 값은 **로컬 기본값일 뿐**이고,
배포할 때는 `npm run world:deploy`가 `.env.local`의 `NEXT_ORIGIN`을 `--var`로 덮어쓴다.

## 다른 컴퓨터와 같이 하기

세 주소가 **전부 공개**여야 한다. 하나라도 로컬이면 그 지점에서만 조용히 끊긴다.

| 방향 | 값 | 안 맞으면 |
|---|---|---|
| 브라우저 → Next | 사람들이 여는 주소 | 애초에 화면이 안 뜬다 |
| 브라우저 → 워커 | `NEXT_PUBLIC_WORLD_WS_URL` (`wss://`) | `connection_failed` |
| **워커 → Next** | `NEXT_ORIGIN` | `room_unavailable` ← **여기서 제일 많이 막힌다** |

세 번째가 잘 안 보이는 이유: 워커는 Cloudflare 엣지에서 돈다. 거기서 `127.0.0.1`은
이 컴퓨터가 아니다. 그래도 `/health`는 200이고 소켓도 열려서 "워커는 멀쩡한데
방만 비어 있는" 모양이 된다. 확인하는 법은 아래 한 줄이다.

```bash
curl https://<worker>.<계정>.workers.dev/rooms/<room_id>/info
# {"capacity":0,...}  ← 0이면 워커가 NEXT_ORIGIN에 못 닿은 것이다
```

### 순서 — Cloudflare Workers (권장)

Next 앱도 워커로 올린다. 그러면 대시보드에 워커가 **둘** 선다. 이 둘을 헷갈리면 아무것도
안 맞는다.

| 워커 | 설정 파일 | 하는 일 | 주소 |
|---|---|---|---|
| `humanish` | `wrangler.jsonc` (루트) | 화면 · API 라우트 · Supabase | `https://humanish.<계정>.workers.dev` |
| `humanish-world` | `worker/wrangler.toml` | 좌표 릴레이 · 봇 아바타 | `wss://humanish-world.<계정>.workers.dev` |

`<계정>`은 이미 아는 값이다 — 이미 배포된 `humanish-world` 주소에서 그대로 딴다.

```bash
# 1. 로그인 (처음 한 번)
npx wrangler login

# 2. .env.local 의 NEXT_ORIGIN 을 맞춘다 (월드 워커가 부를 Next 주소. 아래 표 참고)
#    NEXT_ORIGIN=https://humanish.<계정>.workers.dev

# 3. Next 앱 배포 — next build → OpenNext 번들 → wrangler deploy
#    ★ 비밀보다 먼저 한다. `secret put` 은 **이미 있는 워커**에만 넣을 수 있어서,
#      배포 전에 부르면 Worker "humanish" not found 로 막힌다.
npm run app:deploy

# 4. 런타임 값을 humanish 워커에 넣는다 (한 번만). 값은 .env.local 과 같다.
#    재배포는 필요 없다 — 넣는 즉시 적용되고, deploy 가 지우지도 않는다.
#    .env.local 을 그대로 밀어 넣어도 된다:  npx wrangler secret bulk .env.local
npx wrangler secret put NEXT_PUBLIC_SUPABASE_URL
npx wrangler secret put NEXT_PUBLIC_SUPABASE_ANON_KEY
npx wrangler secret put NEXT_PUBLIC_WORLD_WS_URL   # wss://humanish-world.<계정>.workers.dev
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put WORLD_SHARED_SECRET

# 5. 월드 워커. 비밀은 이미 들어 있으면 건너뛴다 — 먼저 확인할 것:
#      npx wrangler secret list --config worker/wrangler.toml
npx wrangler secret put WORLD_SHARED_SECRET --config worker/wrangler.toml
npm run world:deploy

# 6. 브라우저 없이 전체 왕복 확인 — 진짜 방을 하나 만든다
NEXT_URL=https://humanish.<계정>.workers.dev npm run world:verify

# 7. 다른 컴퓨터에서 https://humanish.<계정>.workers.dev/world
```

#### 무엇이 언제 들어가는가 — 여기서 헷갈리면 조용히 깨진다

**이 앱의 값은 전부 런타임 조회다. 빌드 시점에 굳는 값은 하나도 없다.**

`NEXT_PUBLIC_` 접두사를 보면 "빌드 때 굳는다"고 읽기 쉽지만(그리고 예전에 이 문서가
그렇게 적혀 있었지만), 굳는 건 **브라우저 번들에서 그 이름을 직접 읽을 때**뿐이다.
이 저장소의 서버 코드는 `process.env.NEXT_PUBLIC_SUPABASE_URL` 을 런타임에 읽고,
브라우저는 그 이름을 아예 읽지 않는다 — `GET /api/config` 로 서버에 물어본다
(`app/api/config/route.ts` · `lib/server/supabase.ts` 머리말).

그래서 **모든 값을 워커 변수/비밀로 넣을 수 있다.** 배포 전에 채워 둬야 하는 값이 없고,
값을 바꿀 때 다시 빌드하지 않아도 된다.

빌드 산출물로 확인할 수 있다. `process.env.X` 로 남아 있으면 워커 변수가 먹는다:

```bash
grep -rho 'process\.env\.[A-Z_]*' .open-next/server-functions --include='*.js' | sort -u
#   process.env.NEXT_PUBLIC_SUPABASE_URL   ← 남았다 = 워커 변수로 넣는다
#   process.env.WORLD_SHARED_SECRET        ← 남았다 = 워커 비밀로 넣는다
```

> **★ 브라우저에 새 값을 보내야 하면 `app/api/config/route.ts` 에 한 줄 더한다.**
> 거기 화이트리스트에 이름을 손으로 적은 것만 나간다. `process.env` 를 전개하거나
> 필터로 만들지 않는다 — service role 키가 같이 새면 RLS 가 통째로 무의미해진다 (I9).

| 변수 | 어디에 | 왜 |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | `wrangler secret put` | 서버 라우트 전용. 브라우저로 절대 안 나간다 (I9) |
| `WORLD_SHARED_SECRET` | `wrangler secret put` **워커 둘 다** | Next 가 티켓에 서명하고 월드 워커가 검증한다 — **두 값이 같아야 한다** |
| `NEXT_PUBLIC_SUPABASE_URL` · `..._ANON_KEY` | `wrangler secret put` | 서버가 읽고, 브라우저에는 `/api/config` 가 내려준다. 원래 공개값이라 anon 키는 RLS 가 지킨다 |
| `NEXT_PUBLIC_WORLD_WS_URL` | `wrangler secret put` | `/api/world/ticket` 이 서버에서 읽어 티켓에 실어 준다. 브라우저는 이 이름을 안 본다 |
| `AGENT_SELF_URL` | `wrangler.jsonc` 의 `vars` | 봇 답변 재생성이 `/api/agent` 를 self-fetch 할 자기 공개 주소. 비밀이 아니다 |
| `NEXT_ORIGIN` | `.env.local` (로컬 전용) | Next 는 안 읽는다. `next.config.ts` 의 dev 설정과, `world:deploy` 가 월드 워커에 `--var` 로 실어 보낼 때만 쓴다 |
| `SUPABASE_DB_URL_DIRECT` | 넣지 않는다 | 마이그레이션 전용 (SPEC §12.2) |
| `NVIDIA_NIM_*` | 선택 (`secret put`) | `/api/agent` 를 쓸 때만. 지금은 봇이 DB 문구 풀로 말한다 (SPEC §17) |

#### 그 밖에 알아둘 것

- **배포 순서.** `NEXT_ORIGIN` 은 `humanish` 가 이미 있다고 가정한다. 아주 처음이라면
  4번(앱 배포)을 먼저 하고 5번(월드 워커)을 뒤에 한다. 위 순서가 그렇게 돼 있다.
- **`npm run build` 는 배포에 쓰지 않는다.** 그건 Node 용 산출물이다. Workers 로 가는 건
  `npm run app:build`(= `next build` + OpenNext 번들)뿐이다.
- **크기 한도.** 무료 플랜의 워커 스크립트 상한은 gzip 3 MB 다. 지금 약 1.6 MB.
  `npx wrangler deploy --dry-run --outdir /tmp/x` 로 배포 없이 재 볼 수 있다.
- **이미지 최적화는 꺼져 있다** (`next.config.ts` 의 `images.unoptimized`).
  이유와 되살리는 법은 그 파일 주석에 있다.

### 순서 — 빠른 터널 (잠깐 띄워볼 때)

계정을 만들기 싫거나 한 번만 같이 해볼 때. 주소가 **재시작할 때마다 바뀌고**, 내 노트북이
켜져 있어야 한다.

```bash
cloudflared tunnel --url http://127.0.0.1:3000
#    → https://<무작위>.trycloudflare.com

# .env.local 의 NEXT_ORIGIN 을 그 주소로 바꾸고
npm run world:deploy
NEXT_URL=https://<무작위>.trycloudflare.com npm run world:verify
```

주소가 바뀌면 `.env.local` 수정 + `world:deploy`를 다시 한다(배포는 몇 초다).

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
