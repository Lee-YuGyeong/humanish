# 보안

이 문서는 「무엇을 막고 있는가」와 **「무엇을 아직 못 막고 있는가」**를 같이 적는다.
모든 항목에 파일·줄 번호를 달았다 — 저장소에서 바로 확인할 수 있어야 주장이 된다.

기준: 2026-08-09, `main`.

## 1. 위협 모델

이 게임의 최대 위협은 외부 침입이 아니라 **AI 자리 노출**이다 (`CLAUDE.md` 불변 규칙 I1).
누가 봇인지 한 비트라도 새면 그 판은 즉시 끝난다. 그래서 방어의 1순위는 기밀성이 아니라
**"자리와 묶이는 신호를 만들지 않는 것"** 이다.

두 번째 위협은 조금 특이하다 — **플레이어의 승리 조건이 곧 「AI에게 자백시키기」**다.
즉 모든 사용자가 상시 프롬프트 인젝션 공격자이고, 인젝션은 예외 상황이 아니라
정상 플레이의 일부다 (`docs/ai-usage.html` §인젝션 방어 3겹).

## 2. 계층별 방어

| 계층 | 무엇 | 근거 |
|---|---|---|
| DB 권한 | `question_pool` · `bot_line_pool` · `player_roles` · `agent_logs` · `world_agent_logs` · `world_ai_seats` · `room_bans` 를 anon·authenticated 에서 전면 revoke | `supabase/policies.sql:54-67` |
| 컬럼 화이트리스트 | `players` 직접 접근 차단, 가공된 `public_players` 뷰만 노출 (I1) | `supabase/policies.sql:74-118` |
| 본인 행 한정 | `profiles` · `match_results` | `supabase/policies.sql:238-` |
| 쓰기 경로 단일화 (I9) | 모든 쓰기는 service role 서버 경유. 클라이언트 anon 키는 읽기 전용 | `lib/server/auth.ts` |
| 세션 쿠키 | `httpOnly` + `sameSite=lax` + 프로덕션 `secure` | `lib/server/auth.ts:84-86` |
| 토큰 검증 | `getSession()`(쿠키를 그대로 믿음) 대신 **`getUser()`** 로 Auth 서버에 서명 확인 | `lib/server/auth.ts:125-137` |
| 워커 간 공유 비밀 | 상수 시간 비교. 불일치는 401 이 아니라 **404** — 라우트 존재 자체를 숨긴다 | `app/api/internal/world-{room,match,agent}/route.ts` (`timingSafeEqual`) |
| 내부 라우트 | 프로덕션에서 404 | `app/api/internal/world-log/route.ts:29` |
| 브라우저 노출 화이트리스트 | `process.env` 를 전개하지 않고 **이름을 손으로 적은 2개만** 내려보낸다 | `app/api/config/route.ts` |
| LLM 키 (I4) | 서버에서만 읽고 호출 경로는 하나. 월드 워커는 키도 페르소나 프롬프트도 모른다 | `app/api/agent/` |
| 응답 헤더 | nosniff · `X-Frame-Options: DENY` · Referrer-Policy · Permissions-Policy · HSTS · COOP · CSP(Report-Only) | `next.config.ts` `headers()`, `public/_headers` |

## 3. 비밀 취급

3중으로 막는다.

1. `.gitignore` — `.env*` · `dev.vars` · `.dev.vars` · `secrets.*` (예외는 `.env.local.example` 하나)
2. `.claude/settings.json` 의 `permissions.deny` — AI 코딩 도구의 읽기·쓰기 차단
3. `.claude/hooks/deny-secrets.mjs` (PreToolUse 훅) — **셸 우회까지** 차단. 훅 자체에 테스트가 붙어 있다 (`.claude/hooks/deny-secrets.test.mjs`)

**git 이력 전수 검사 결과: 비밀 파일 0건.** 이력에 등장하는 고유 경로 283개 중 이름이 걸리는 것은
`.env.local.example`(값 없는 예시)과 훅 파일 3개뿐이다. 재현:

```bash
git log --all --name-only --pretty=format: | sort -u | grep -i "env\|vars\|secret"
```

## 4. 의존성 취약점 현황

기준 2026-08-09, `npm audit`.

| 범위 | critical | high | moderate |
|---|---|---|---|
| 런타임 (`--omit=dev`) | 0 | 4 | 0 |
| 전체 (dev 포함) | 0 | 6 | 0 |

런타임 4건은 `nanoid` · `next` · `postcss` · `sharp` 이고 **전부 `next@16` 메이저 업그레이드로만 해소된다**
(`npm audit fix --force` 가 breaking change 로 경고한다). 해커톤 기간 중 프레임워크 메이저 업그레이드는
얻는 것보다 잃을 것이 커서 **의도적으로 보류**했다. 판단 근거:

- `postcss` · `sharp` 는 **빌드 타임 도구 체인**이다. 런타임 요청 경로에 없다.
- `sharp` 는 그나마도 실행되지 않는다 — `next.config.ts` 의 `images.unoptimized: true` 로 이미지 최적화
  라우트를 끄고 `/public` 원본을 그대로 내보낸다 (Workers 에는 Next 의 최적화 서버가 없다).

dev 쪽 undici·miniflare 체인은 **wrangler 를 4.115.0/4.33.0 → 4.120.0 으로 올려 해소**했다
(루트와 `worker/` 를 같은 버전으로 맞췄다). moderate 2건이 이때 함께 사라졌다.

## 5. 알려진 위험 (아직 안 막은 것)

### 5-1. `/api/admin/rooms` 가 무인증이다

`app/api/admin/rooms/route.ts` 의 `GET` 은 인자조차 받지 않는다 — 세션·베어러 검사가 없다.
최근 50개 방의 **방 코드 · 정원 · 페이즈 · 남은 시간**이 나간다.

- **새지 않는 것**: 정체 · 봇 자리 · 역할. 같은 파일이 `players` 에서 `room_id` 만 select 하므로
  I1 이 깨지지는 않는다.
- **새는 것의 실제 영향**: 아직 로비인 방의 코드로 남의 방에 입장할 수 있다.
- **조치안**: `app/api/internal/world-room/route.ts:40` 과 같은 `timingSafeEqual` 베어러 검사.
  불일치 시 404.
- **왜 아직 안 했나**: 심사 데모 중 `/admin` 점검 화면을 열어 보여야 해서 미뤘다. 심사 직후 적용한다.

### 5-2. CSP 가 Report-Only 다

`next.config.ts` 의 `Content-Security-Policy-Report-Only`. three.js·@react-three 와 Next 의 인라인
부트스트랩이 섞여 있어 강제로 걸면 화면이 깨질 수 있다. **수집 엔드포인트가 없어 위반은 브라우저
콘솔에만 남는다.** `/world` 에서 위반 목록을 확인한 뒤 강제로 전환하는 것이 다음 단계다.

### 5-3. 레이트리밋이 없다

쓰기 API 는 전부 서버를 거치고 신원을 다시 확인하지만(I9), 호출 빈도 제한은 없다.
게임 자체가 페이즈 시간에 묶여 있어 악용 폭이 좁다는 판단으로 넘겼다.

## 6. 검사

| 무엇으로 | 확인하는 것 |
|---|---|
| `npm run check` | 타입 · lint · 순수 함수/화면 조각 696개 |
| `./supabase/test.sh` | **권한(RLS)과 상태머신을 진짜 Postgres에** — DB가 하는 일은 목으로 흉내 내지 않는다 |
| `./supabase/e2e.sh` | 라우트 왕복 · anon 침투 |
| `npm run world:verify` | 실제 소켓 2개 왕복 (타입 체크는 동작한다는 증거가 못 된다) |

## 7. 취약점 신고

이 저장소의 이슈로 알려 주세요. 공개 전 조율이 필요하면 이슈에 연락 방법만 남겨 주시면 됩니다.
