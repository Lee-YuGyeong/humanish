# 사람인 척 (whois-human)

최대 9자리(사람 8 + AI 1)인 채팅방에서 누가 AI인지 찾는 웹 게임. 방을 만들 때 고르는 값은 **이름뿐이다** — 정원도 모드도 고르지 않는다 (2026-08-06 결정, SPEC §18.1 머리말).
사람은 8자리까지 들어오고, **2명만 모이면 전원이 준비를 눌렀을 때 언제든 시작한다.** 시작하는 순간 **AI 1대**가 합류한다.
**AI가 몇인지는 규칙으로 공개돼 있고(언제나 1), 어느 자리인지는 끝까지 숨긴다** (SPEC §15-3, §18.1).
사람 중 일부는 AI인 척하는 **연기자**이고, **그 수는 랜덤이라 아무도 모른다** (SPEC §18.2).
판의 결론은 투표로 **지목된 한 명의 정체**다 — 그게 AI면 시민 승, 연기자면 연기자 승, 시민이면 AI 승 (SPEC §18.4).

상세 설계는 [`docs/SPEC.md`](docs/SPEC.md)가 유일한 기준이다. 이 파일과 어긋나면 SPEC이 맞다.
**게임 규칙은 SPEC §18이 기준이다.** 2026-08-02에 확정했고 §0~§17의 앞선 서술을 여러 군데 뒤집는다(대조표는 §18.7).
**대부분 아직 코드에 반영되지 않았다** — 규칙과 코드가 다르면 규칙이 맞고, 손대는 순서는 §18.7에 있다.
**예외는 §18.1이다.** 인원표는 2026-08-06에 폐기됐고(사람 8 고정 + AI 1), 그건 코드에 들어가 있다.

## 명령

```bash
npm run dev            # 개발 서버
npm run build          # 프로덕션 빌드 (타입 검사 포함)
npx tsc --noEmit       # 타입만 빠르게 검사
npm run lint
npm test               # 순수 함수 · 화면 조각 (vitest, tests/ 아래)
./supabase/test.sh     # 스키마 · RLS · 상태머신 (일회용 로컬 Postgres)
./supabase/e2e.sh      # 라우트 왕복 (개발 서버 + 실제 Supabase가 필요하다)
```

**DB가 하는 일은 목으로 흉내 내지 않는다.** `npm test`는 DB를 모르고, DB 동작은
`supabase/test.sh`가 진짜 Postgres에 물어본다. 이 저장소는 목 때문이 아니라
**검사 목록이 두 군데로 갈려서** 두 번 데였다 — 새 스키마 검사는 반드시
`supabase/checks.sh`에 넣는다. 거기 하나만 고치면 로컬과 배포가 같이 걸린다.

## 절대 어기면 안 되는 것

번호는 SPEC 「불변 규칙」의 I1~I10과 같다. 근거와 위반 시 증상은 거기 있다.
**I7(폴더 소유권)은 뺐다.** 나머지 번호는 SPEC과 맞추려고 그대로 둔다.

- **I1. 어느 자리가 봇인지 내보내지 않는다.** 클라이언트는 `players`가 아니라 `public_players` 뷰를 읽는다. 이게 새면 게임이 즉시 끝난다. **뷰에 컬럼을 더할 때마다 "이걸로 봇을 골라낼 수 있나"를 먼저 묻는다** (SPEC §7.2).
  **봇이 몇인지(총 수)는 공개해도 된다** — §15-3에서 그렇게 정했다. 금지되는 건 **자리와 묶이는 것**이다: `is_bot` 행, `created_at`처럼 역산되는 값, 자리 단위로 드러나는 봇 타이밍, 그리고 **`user_id`**(§15-2-결정 — 봇에게는 계정이 없어서 `null`인 자리가 곧 봇 명단이다).
- **I2. 페이즈 전환 판정에 클라이언트 시계를 쓰지 않는다.** 전부 서버 `now()`. 클라이언트 카운트다운은 표시용이다.
- **I3. `lib/game/` 안에서 DB·네트워크·`Date.now()`·랜덤을 쓰지 않는다.** 순수 함수만. 랜덤이 필요하면 인자로 받는다.
- **I4. LLM API 키는 서버에서만 읽는다.** 호출 경로는 `app/api/agent/` 하나뿐이다.
- **I5. 조기 종료 인원은 `is_bot = false`만 센다.** 봇을 포함해 세면 모든 페이즈가 시작 즉시 끝난다. **조기 종료가 있는 페이즈는 question·vote·revote뿐이다** — target은 대상이 사람이든 봇이든 30초를 채운다. 봇일 때만 늦추면 그게 다시 신호가 되기 때문이다 (SPEC §5.3).
- **I6. `advance_phase`는 항상 `expected_seq`와 함께 부른다.** 낙관적 잠금 키다.
- **I8. 도메인 타입은 `lib/game/types.ts`에서만 정의한다.**
- **I9. 쓰기는 전부 service role 서버 경유.** 클라이언트 anon 키는 읽기 전용이다. 서버는 `player_id`를 그대로 믿지 말고 **쿠키의 `player_token`으로 되찾는다** (SPEC §17.4).
- **I10. 모든 구독·채널·쿼리를 방으로 스코프한다.** 필터 없는 구독은 다른 방의 전환 이벤트를 받아서 엉뚱한 타이밍에 화면이 넘어간다. 구독 코드를 **처음 쓸 때** 지킨다 (SPEC §6.3, §16).

## 코드 지도

어디에 뭐가 있는지. **경계는 사람이 아니라 계층으로 나눈다.**

| 경로 | 무엇 |
|---|---|
| `lib/server/`, `supabase/`, `app/api/` | 방 · 페이즈 상태머신 · DB |
| `lib/game/`, `lib/agent/` | 규칙(순수 함수) · 에이전트 |
| `app/`(api 제외), `components/`, `mock/` | 화면 |
| `lib/mp/`, `worker/`, `tools/verify-world.mjs` | 3D 월드 멀티플레이 (프로토콜 · Durable Object) |
| `wrangler.jsonc`, `open-next.config.ts`, `tools/deploy-*.mjs` | 배포 (Cloudflare Workers) |
| `lib/api/`, `lib/queries/`, `lib/store/` | 상태 계층 (아래 「상태는 어디에 두는가」) |
| `lib/auth/`, `app/api/auth/` | 계정 (익명 인증 · 구글 연결, SPEC §15-2-결정) |
| `lib/game/types.ts` | 도메인 타입 (I8) |

폴더가 갈려 있는 이유는 **한쪽만 고치면 티가 나게** 하려는 것이다. 특히
`lib/mp/`(클라이언트와 워커가 같이 읽는다)와 `lib/game/types.ts`는 한쪽에 복붙하는
순간 갈린다.

## 상태는 어디에 두는가

**서버가 아는 값을 `useState`에 담지 않는다.** 방·좌석·질문·답변·투표는 전부 캐시(react-query)에 있고, 화면은 그걸 읽기만 한다. 이 경계가 흐려지면 같은 값이 두 군데 살고, 둘이 어긋날 때 어느 쪽이 맞는지 알 수 없어진다.

| 무엇 | 어디 | 예 |
|---|---|---|
| 서버가 아는 값 | `lib/queries/` (react-query) | 방 · 좌석 · 질문 · 답변 · 투표 · 내 정보 |
| 서버가 모르는 값 | `lib/store/<slice>/` (zustand 4계층) | 입력 초안 · 고른 자리 · 실패 배너 · 요청 잠금 |
| 요청 그 자체 | `lib/api/` | fetch 래퍼 · 라우트별 함수 · anon 읽기 |

스토어는 `actions → reducer → store → selectors` 순으로 나눈다. reducer와 selector는 **순수 함수**라 `npm test`가 직접 검사한다 — 화면을 띄우지 않고 규칙을 확인할 수 있는 게 이렇게 나눈 이유다. 화면은 `@/lib/store/room`처럼 **폴더만** import한다(안쪽 파일을 직접 가리키면 계층을 건너뛰게 된다).

- **쿼리 키는 `lib/queries/keys.ts`에서만 만든다.** 배열 리터럴을 호출부에 적으면 읽는 쪽과 무효화하는 쪽이 조용히 갈린다 — 타입도 통과하고 에러도 없이 화면만 갱신되지 않는다. 방에 속한 키는 전부 `scope(roomId)`로 시작해서 **I10이 키 모양으로 강제된다.**
- **`app/world/store.ts`는 이 4계층을 따르지 않는다.** 좌표를 Map 안에서 제자리 변형한다 — 8인 × 10Hz를 불변 업데이트로 바꾸면 초당 80번 리렌더가 난다. 그 파일 머리말에 이유가 있다. **거기에 reducer를 들이지 않는다.**
- **DB 동작은 여전히 목으로 흉내 내지 않는다.** `tests/components/room-view.test.tsx`가 대신 세우는 건 `lib/api/*`(네트워크 경계)뿐이고, RLS·상태머신은 `supabase/test.sh`가 진짜 Postgres에 물어본다.

## 작업 보드 (`/`)

`/`는 게임 화면이 아니라 진입 버튼 목록이다.

| 라우트 | 폴더 | 무엇 |
|---|---|---|
| `/intro` | `app/intro/` | 제목 · 역할 소개 |
| `/main` | `app/main/` | 방 만들기 · 입장 |
| `/room/[code]` | `app/room/` | 게임 화면 |
| `/lab` | `app/lab/` | 규칙 · 봇 응답 확인 · 모델 비교 |
| `/world` | `app/world/` | 3D 멀티플레이 (`docs/MULTIPLAYER.md`) |
| `/admin` | `app/admin/` | 방 · 페이즈 점검 |
| `/login` | `app/login/` | 구글 로그인 (SPEC §15-2-결정) |
| `/account` | `app/account/` | 이름 짓기 · 바꾸기 |
| 목록 자체 | `app/workspaces.ts` | 진입 버튼 목록 |

새 작업 공간은 `app/workspaces.ts`에 한 줄 추가 + `app/<경로>/page.tsx` 생성.

**게임 화면(`/main` · `/room`)은 로그인해야 열린다** (`components/require-login.tsx`). 실제 진입은 `/intro` 의 「게임 접속하기」이고 그 버튼이 로그인을 건다. `/` · `/intro` · `/lab` · `/world` · `/admin` 은 감싸지 않는다 — 게임 계정과 무관하게 돌아야 한다.

## 비밀 파일

`dev.vars` · `.dev.vars` · `.env*` · `secrets.*`는 **Claude가 읽지도 쓰지도 못한다.**
`.claude/settings.json`의 `permissions.deny` + `.claude/hooks/deny-secrets.mjs`(PreToolUse 훅)가 Bash 우회까지 막는다.

- 키 이름만 알아야 하면 `.env.local.example`을 읽는다. 값은 사용자에게 요청한다.
- 보호 대상을 늘리려면 `deny-secrets.mjs` 위쪽 정규식만 고치고 `node .claude/hooks/deny-secrets.test.mjs`로 확인한다.
- **경로를 개인 절대경로로 쓰지 않는다.** `deny` 규칙은 `/**/…`(프로젝트 루트 기준) 형태여야
  팀원 각자의 체크아웃 위치에서 똑같이 걸린다. `//Users/…` 로 쓰면 그 사람 머신에서만 동작한다.

## 작업할 때

**지금은 AI 없이 먼저 완주시킨다 (SPEC §17).** 봇은 LLM이 아니라 DB의 문구 풀에서 말한다. 이 코드는 나중에 AI를 붙여도 폴백 경로로 그대로 남는다. LLM 공급자(§15-1)는 아무것도 막지 않는다.

- **자리 수는 두 상수에서 온다 (SPEC §18.1 머리말, 2026-08-06).** `lib/game/rules.ts` 의
  `MAX_HUMANS_PER_ROOM`(사람 8) · `AI_SEATS_PER_ROUND`(AI 1) 하나뿐이고, 시작 조건도
  거기 `startBlock`(사람 2~8 + 전원 준비) 하나다 — **화면과 서버가 같은 함수를 본다.**
  좌석 배열·`PlayerGrid`·`Array(5)`처럼 **숫자를 하드코딩하지 않는다.** 사람 자리는
  DB에서 `room_capacity()`, 코드에서 `room.capacity` 다 (옛 방이 3~5로 남아 있어 상수로
  접지 않는다). `rooms`를 select할 때 그 컬럼을 빠뜨리면 그리드가 0칸이 된다.
  **`players.seat` 은 1~9다** — AI 는 사람 정원 밖 한 자리를 더 쓴다. 3D 월드의 좌석 원도
  정원이 아니라 `lib/mp/constants.ts` 의 `WORLD_SEAT_SLOTS`(9)로 나눈다. 정원으로 나누면
  9번 자리가 1번과 겹친다.
  **`capacity`/`seat_count` 로 수를 둘로 나누던 §18.1 인원표는 폐기됐다.**
- **시작하는 순간 자리를 다시 섞는다. AI도 그 순열 안에 있다 (2026-08-08).** 2D는
  `shuffle_seats`, 월드는 `start_world_seats` 다 (`supabase/functions/room.sql`). 사람 셋이면
  익명1~4 이고 어느 칸이 AI 인지는 무작위다 — **사람만 1..N 으로 정리하면 AI 가 언제나
  방에서 제일 큰 번호가 되어 그것만 찍으면 맞는 판이 된다** (I1). 월드 AI 는 `players`
  행이 없어서 자리를 스스로 못 붙든다: 뽑은 번호를 `world_ai_seats` 에 적고
  `buildWorldRoster`·`pick_free_seat` 이 그걸 읽는다. **그 테이블은 정답 그 자체라
  anon 에게 한 칸도 열지 않는다** — `rooms` 컬럼으로 두지 않은 이유가 이것이다.
  자세한 내용은 `docs/MULTIPLAYER.md`.
- **손대기 전에** SPEC에서 해당 섹션을 읽는다. 섹션 번호(`§5.2` 등)는 코드 주석이 참조하므로 **재번호를 매기지 않는다.**
- **막히면 추측하지 말고 SPEC §15(미결정 사항)를 확인한다.** 거기 있는 항목은 사용자에게 물어볼 것.
- 코드를 고쳤으면 `npm run build`로 끝낸다. 타입 에러를 남기지 않는다.
- `supabase/` 아래를 고쳤으면 `./supabase/test.sh`로 끝낸다. 일회용 로컬 Postgres에서 SPEC §14를 검사한다.
- **3D 월드는 `lib/mp/`부터 본다** (`docs/MULTIPLAYER.md`). 프로토콜 · 상수 · 월드 경계가 거기 하나뿐이고 클라이언트와 워커가 **같이 읽는다** — 한쪽에 복붙하면 그 순간 갈린다. `worker/` 를 고쳤으면 `npm run world:typecheck` 와 `npm run world:verify`(소켓 2개 왕복)로 끝낸다. 타입체크는 멀티플레이가 동작한다는 증거가 못 된다.
- **배포는 워커 둘이다.** `npm run app:deploy`(Next 앱 = `humanish`)와 `npm run world:deploy`(월드 = `humanish-world`). **`npm run build` 산출물은 배포에 쓰지 않는다** — 그건 Node 용이고, Workers 로 가는 건 `app:build`(= `next build` + OpenNext 번들)뿐이다. 그리고 **배포본은 `.env.local` 을 보지 않는다 — 값은 전부 워커 변수/비밀에서 온다.** 빌드에 굳는 값은 없다: 서버는 `process.env` 를 런타임에 읽고, 브라우저가 필요로 하는 supabase 주소·anon 키는 `GET /api/config` 가 내려준다. **브라우저에 새 값을 보내야 하면 `app/api/config/route.ts` 의 화이트리스트에 이름을 손으로 적는다** — `process.env` 를 전개하면 service role 키가 같이 새어 I9·I4가 무너진다. 전체 순서와 변수 표는 `worker/README.md`.
- 시각은 전부 ISO 문자열로 주고받는다.
- 파일명 kebab-case, 컴포넌트 PascalCase.
