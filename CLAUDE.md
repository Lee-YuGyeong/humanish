# 사람인 척 (whois-human)

3~8인 채팅방에서 누가 AI인지 찾는 웹 게임. 정원은 방을 만들 때 정한다(기본 5).
빈자리는 AI 봇이 채운다. **봇이 몇인지는 공개하고, 어느 자리인지는 끝까지 숨긴다** (SPEC §15-3 결정).
인간 중 한 명은 AI인 척해야 하는 스파이다.

상세 설계는 [`docs/SPEC.md`](docs/SPEC.md)가 유일한 기준이다. 이 파일과 어긋나면 SPEC이 맞다.

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

- **I1. 어느 자리가 봇인지 내보내지 않는다.** 클라이언트는 `players`가 아니라 `public_players` 뷰를 읽는다. 이게 새면 게임이 즉시 끝난다. **뷰에 컬럼을 더할 때마다 "이걸로 봇을 골라낼 수 있나"를 먼저 묻는다** (SPEC §7.2).
  **봇이 몇인지(총 수)는 공개해도 된다** — §15-3에서 그렇게 정했다. 금지되는 건 **자리와 묶이는 것**이다: `is_bot` 행, `created_at`처럼 역산되는 값, 자리 단위로 드러나는 봇 타이밍.
- **I2. 페이즈 전환 판정에 클라이언트 시계를 쓰지 않는다.** 전부 서버 `now()`. 클라이언트 카운트다운은 표시용이다.
- **I3. `lib/game/` 안에서 DB·네트워크·`Date.now()`·랜덤을 쓰지 않는다.** 순수 함수만. 랜덤이 필요하면 인자로 받는다.
- **I4. LLM API 키는 서버에서만 읽는다.** 호출 경로는 `app/api/agent/` 하나뿐이다.
- **I5. 조기 종료 인원은 `is_bot = false`만 센다.** 봇을 포함해 세면 모든 페이즈가 시작 즉시 끝난다. **조기 종료가 있는 페이즈는 question·vote 둘뿐이다** — target은 대상이 사람이든 봇이든 30초를 채운다. 봇일 때만 늦추면 그게 다시 신호가 되기 때문이다 (SPEC §5.3).
- **I6. `advance_phase`는 항상 `expected_seq`와 함께 부른다.** 낙관적 잠금 키다.
- **I7. 자기 소유 폴더 밖의 파일은 수정하지 않는다.** 예외는 `lib/game/types.ts`. 아래 「폴더 소유권」 참고.
- **I8. 도메인 타입은 `lib/game/types.ts`에서만 정의한다.**
- **I9. 쓰기는 전부 service role 서버 경유.** 클라이언트 anon 키는 읽기 전용이다. 서버는 `player_id`를 그대로 믿지 말고 **쿠키의 `player_token`으로 되찾는다** (SPEC §17.4).
- **I10. 모든 구독·채널·쿼리를 방으로 스코프한다.** 필터 없는 구독은 다른 방의 전환 이벤트를 받아서 엉뚱한 타이밍에 화면이 넘어간다. 구독 코드를 **처음 쓸 때** 지킨다 (SPEC §6.3, §16).

## 폴더 소유권

**자기 폴더 밖의 파일은 수정하지 않는다.** 필요하면 소유자에게 요청한다.

| 경로 | 소유 |
|---|---|
| `lib/server/`, `supabase/`, `app/api/` | **A** — 방 · 페이즈 상태머신 · DB |
| `lib/game/`, `lib/agent/` | **B** — 규칙(순수 함수) · 에이전트 |
| `app/`(api 제외), `components/`, `mock/` | **C** — 화면 |
| `lib/mp/`, `worker/`, `tools/verify-world.mjs` | **A** — 3D 월드 멀티플레이 (프로토콜 · Durable Object) |
| `lib/game/types.ts` | 공동. 고치면 팀 채널에 공지 |

이 저장소에서 작업하는 세션은 **A 영역**을 맡는다. B·C 영역 파일이 필요하면 스텁만 두고 사용자에게 알린다.

## 작업 보드 (`/`)

여러 명이 동시에 작업하므로 **한 사람이 한 라우트 폴더를 소유한다.** `/`는 게임 화면이 아니라 진입 버튼 목록이다.

| 라우트 | 폴더 | 소유 |
|---|---|---|
| `/intro` | `app/intro/` | 원상 — 제목 · 역할 소개 |
| `/main` | `app/main/` | C — 방 만들기 · 입장 |
| `/room/[code]` | `app/room/` | C — 게임 화면 |
| `/lab` | `app/lab/` | B — 규칙 · 봇 응답 확인 |
| `/world` | `app/world/` | 원상 — 3D 멀티플레이 (`docs/MULTIPLAYER.md`) |
| `/admin` | `app/admin/` | A — 방 · 페이즈 점검 |
| 목록 자체 | `app/workspaces.ts` | 공동. **한 줄씩만** 고친다 |

새 작업 공간은 `app/workspaces.ts`에 한 줄 추가 + `app/<경로>/page.tsx` 생성. 남의 폴더는 열지 않는다.

## 비밀 파일

`dev.vars` · `.dev.vars` · `.env*` · `secrets.*`는 **Claude가 읽지도 쓰지도 못한다.**
`.claude/settings.json`의 `permissions.deny` + `.claude/hooks/deny-secrets.mjs`(PreToolUse 훅)가 Bash 우회까지 막는다.

- 키 이름만 알아야 하면 `.env.local.example`을 읽는다. 값은 사용자에게 요청한다.
- 보호 대상을 늘리려면 `deny-secrets.mjs` 위쪽 정규식만 고치고 `node .claude/hooks/deny-secrets.test.mjs`로 확인한다.
- **경로를 개인 절대경로로 쓰지 않는다.** `deny` 규칙은 `/**/…`(프로젝트 루트 기준) 형태여야
  팀원 각자의 체크아웃 위치에서 똑같이 걸린다. `//Users/…` 로 쓰면 그 사람 머신에서만 동작한다.

## 작업할 때

**지금은 AI 없이 먼저 완주시킨다 (SPEC §17).** 봇은 LLM이 아니라 DB의 문구 풀에서 말한다. 이 코드는 나중에 AI를 붙여도 폴백 경로로 그대로 남는다. LLM 공급자(§15-1)는 아무것도 막지 않는다.

- **정원은 방마다 다르다 (`rooms.capacity`, 3~8, 기본 5 — SPEC §17.6).** 좌석 배열·`PlayerGrid`·`Array(5)`처럼 **5를 하드코딩하지 않는다.** DB에서는 `room_capacity()`를, 코드에서는 `room.capacity`를 쓴다. `rooms`를 select할 때 컬럼 목록에 `capacity`를 빠뜨리면 그리드가 0칸이 된다.
- **손대기 전에** SPEC에서 해당 섹션을 읽는다. 섹션 번호(`§5.2` 등)는 코드 주석이 참조하므로 **재번호를 매기지 않는다.**
- **막히면 추측하지 말고 SPEC §15(미결정 사항)를 확인한다.** 거기 있는 항목은 사용자에게 물어볼 것.
- 코드를 고쳤으면 `npm run build`로 끝낸다. 타입 에러를 남기지 않는다.
- `supabase/` 아래를 고쳤으면 `./supabase/test.sh`로 끝낸다. 일회용 로컬 Postgres에서 SPEC §14를 검사한다.
- **3D 월드는 `lib/mp/`부터 본다** (`docs/MULTIPLAYER.md`). 프로토콜 · 상수 · 월드 경계가 거기 하나뿐이고 클라이언트와 워커가 **같이 읽는다** — 한쪽에 복붙하면 그 순간 갈린다. `worker/` 를 고쳤으면 `npm run world:typecheck` 와 `npm run world:verify`(소켓 2개 왕복)로 끝낸다. 타입체크는 멀티플레이가 동작한다는 증거가 못 된다.
- 시각은 전부 ISO 문자열로 주고받는다.
- 파일명 kebab-case, 컴포넌트 PascalCase.
