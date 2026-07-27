# SPEC — 사람인 척 (whois-human)

기술 설계 문서. 팀 공용 계약서이자 AI 코딩 에이전트가 읽을 컨텍스트다.
게임 기획은 별도 문서 참조. 이 문서는 **무엇을 어떤 모양으로 만들 것인가**만 다룬다.

---

## 0. 한 줄 요약

5인 채팅방에서 누가 AI인지 찾는 웹 게임. 빈자리는 AI 봇이 채우며 그 사실은 공개되지 않는다. 인간 중 한 명은 AI인 척해야 하는 스파이다.

---

## 1. 스택

| 영역 | 선택 | 비고 |
|---|---|---|
| 프레임워크 | Next.js 15 (App Router) + TypeScript | |
| 스타일 | Tailwind CSS | |
| DB / 실시간 | Supabase (Postgres + Realtime) | |
| 서버 로직 | Supabase Edge Function + Next.js Route Handler | |
| 3D | react-three-fiber + drei | 게임이 끝까지 돌아간 뒤에 도입. 그 전에는 2D |
| LLM | NVIDIA NIM API | 프록시는 Route Handler 경유 |
| 배포 | Vercel | 첫날부터 URL 유지 |

**금지 사항**
- 클라이언트에서 LLM API 직접 호출 금지 (키 노출)
- 클라이언트 시계로 페이즈 전환 판단 금지 (전부 서버 `now()`)
- `lib/game` 안에서 DB·네트워크 접근 금지 (순수 함수만)

---

## 2. 폴더 구조와 소유권

```
app/
  page.tsx                 랜딩 · 방 만들기 / 입장
  room/[code]/page.tsx     게임 화면 (페이즈에 따라 분기)
  api/
    agent/route.ts         LLM 프록시 (A가 껍데기, B가 내용)
components/                UI 컴포넌트
lib/
  game/                    ★ B 단독 소유 — 순수 함수만
    rules.ts               역할 배정, 점수 계산, 승패 판정
    questions.ts           질문 30개
    types.ts               도메인 타입 (전 팀 공유)
  agent/                   ★ B 단독 소유
    persona.ts             페르소나 · 시스템 프롬프트
    disguise.ts            타이핑 지연, 메시지 분할, 오타
    generate.ts            LLM 호출 및 응답 파싱
  server/                  ★ A 단독 소유
    room.ts                방 생성 · 입장
    phase.ts               페이즈 전환 로직
    supabase.ts            클라이언트 팩토리
supabase/
  schema.sql               테이블 · 인덱스
  policies.sql             RLS
  functions/               Edge Function
mock/
  room.json                목 데이터 (C 전용)
docs/
  SPEC.md                  이 문서
```

**규칙: 자기 폴더 밖의 파일은 수정하지 않는다.** 필요하면 소유자에게 요청한다. 예외는 `lib/game/types.ts` — 여기만 셋이 함께 편집하되, 변경 시 팀 채널에 공지한다.

---

## 3. 도메인 타입

`lib/game/types.ts`. 이 파일이 프론트·백·에이전트의 공통 언어다.

```ts
export type Phase =
  | 'lobby'
  | 'question'   // round 1, 2
  | 'target'     // 지목 질문
  | 'chat'       // 자유 채팅
  | 'vote'
  | 'reveal'
  | 'replay';

export type Role = 'citizen' | 'spy' | 'ai';

export interface Room {
  id: string;
  code: string;          // 4자 대문자
  phase: Phase;
  phase_seq: number;     // 전환마다 +1. 중복 전환 방지 키
  phase_ends_at: string; // ISO. null이면 무기한(lobby)
  round: number;         // question 페이즈에서만 의미 있음
  host_id: string;
}

export interface Player {
  id: string;
  room_id: string;
  nickname: string;      // '익명1' ~ '익명5'
  mask_id: string;
  seat: number;          // 1~5. 표시 순서 고정
  is_bot: boolean;
  connected: boolean;
}

export interface Question {
  id: string;
  room_id: string;
  round: number;
  kind: 'common' | 'target';
  text: string;
  asked_by: string | null;   // target일 때만
  target_id: string | null;  // target일 때만
}

export interface Answer {
  id: string;
  question_id: string;
  player_id: string;
  text: string;
  visible_at: string;    // 이 시각 이후에만 노출
}

export interface Message {
  id: string;
  room_id: string;
  player_id: string;
  text: string;
  visible_at: string;    // 봇의 타이핑 지연 구현
}

export interface Vote {
  room_id: string;
  voter_id: string;
  target_id: string;
  reason: string;
}

export interface AgentLog {
  id: string;
  room_id: string;
  player_id: string;
  ref_id: string;        // 해당 message 또는 answer id
  reasoning: string;
  suspicion: number;     // 0~1
  action: 'answer' | 'deflect' | 'accuse' | 'silent';
}
```

---

## 4. 데이터베이스

`supabase/schema.sql`

```sql
create table rooms (
  id            uuid primary key default gen_random_uuid(),
  code          text unique not null,
  phase         text not null default 'lobby',
  phase_seq     int  not null default 0,
  phase_ends_at timestamptz,
  round         int  not null default 0,
  host_id       uuid,
  created_at    timestamptz not null default now()
);

create table players (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references rooms(id) on delete cascade,
  nickname   text not null,
  mask_id    text not null,
  seat       int  not null,
  is_bot     boolean not null default false,
  connected  boolean not null default true,
  created_at timestamptz not null default now(),
  unique (room_id, seat)
);

-- 절대 클라이언트에 노출되지 않는다
create table player_roles (
  player_id uuid primary key references players(id) on delete cascade,
  room_id   uuid not null references rooms(id) on delete cascade,
  role      text not null
);

create table questions (
  id        uuid primary key default gen_random_uuid(),
  room_id   uuid not null references rooms(id) on delete cascade,
  round     int  not null,
  kind      text not null,
  text      text not null,
  asked_by  uuid references players(id),
  target_id uuid references players(id)
);

create table answers (
  id          uuid primary key default gen_random_uuid(),
  question_id uuid not null references questions(id) on delete cascade,
  room_id     uuid not null references rooms(id) on delete cascade,
  player_id   uuid not null references players(id) on delete cascade,
  text        text not null,
  visible_at  timestamptz not null default now(),
  unique (question_id, player_id)
);

create table messages (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references rooms(id) on delete cascade,
  player_id  uuid not null references players(id) on delete cascade,
  text       text not null,
  visible_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table votes (
  room_id   uuid not null references rooms(id) on delete cascade,
  voter_id  uuid not null references players(id) on delete cascade,
  target_id uuid not null references players(id) on delete cascade,
  reason    text not null default '',
  primary key (room_id, voter_id)
);

create table agent_logs (
  id        uuid primary key default gen_random_uuid(),
  room_id   uuid not null references rooms(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  ref_id    uuid,
  reasoning text not null,
  suspicion real not null default 0,
  action    text not null
);

create index on players (room_id);
create index on messages (room_id, visible_at);
create index on answers  (room_id, question_id);
```

---

## 5. 페이즈 상태머신

**A의 본체.** 여기가 꼬이면 전부 멈춘다.

### 5.1 전환표

| 현재 | 다음 | 길이 | 전환 조건 |
|---|---|---|---|
| lobby | question(1) | — | 방장이 시작 |
| question(1) | question(2) | 60초 | 시간 만료 **또는** 사람 전원 제출 |
| question(2) | target | 60초 | 시간 만료 **또는** 사람 전원 제출 |
| target | chat | 60초 | 시간 만료 **또는** 대상자 제출 |
| chat | vote | 120초 | 시간 만료만 |
| vote | reveal | 30초 | 시간 만료 **또는** 사람 전원 투표 |
| reveal | replay | — | 클라이언트 조작 |

**"사람 전원"이 핵심.** 봇은 즉시 제출하므로 봇을 포함해 세면 조건이 항상 참이 된다. `is_bot = false`인 플레이어만 센다.

### 5.2 전환 트리거

상주 서버가 없으므로 클라이언트가 만료를 감지해 호출하고, 서버가 다시 검증한다.

```
클라이언트: phase_ends_at 경과 감지
  → rpc('advance_phase', { room_id, expected_seq: 현재 phase_seq })

서버(advance_phase):
  1. 행 잠금 (select ... for update)
  2. expected_seq !== rooms.phase_seq  → 아무것도 안 하고 종료
  3. now() < phase_ends_at 이고 조기종료 조건 미충족 → 종료
  4. 다음 페이즈 계산, phase_seq += 1, phase_ends_at 갱신
  5. 새 페이즈 진입 훅 실행 (아래)
  6. Realtime이 rooms 변경을 자동 브로드캐스트
```

`phase_seq` 하나로 중복 호출이 전부 무력화된다. 5명이 동시에 호출해도 첫 호출만 성공한다.

### 5.3 페이즈 진입 훅

| 진입 페이즈 | 서버가 하는 일 |
|---|---|
| question | 질문 1개 선택 후 insert. **봇 답변을 즉시 생성**하고 `visible_at`을 공개 시점으로 설정 |
| target | 지목 대상 결정. 대상이 봇이면 답변 생성 |
| chat | 봇별 쿨다운 초기화 |
| vote | 봇 투표 생성 |
| reveal | `calcScore` 호출, 결과 확정 |

**봇 답변은 페이즈 시작 시 한꺼번에 만든다.** 함수가 6초를 기다릴 수 없으므로, 지연은 `visible_at`에 시각으로 박고 클라이언트가 그 시점에 띄운다.

### 5.4 자유 채팅 예외

chat 페이즈만 실시간 반응이 필요하다. 사람 메시지가 insert될 때마다 봇 응답 여부를 판단한다.

- 봇당 쿨다운 최소 8초
- 한 사람 메시지에 반응하는 봇은 최대 1명
- 이 구간이 API 호출이 가장 몰리는 지점 — 호출 수를 로그로 남긴다

---

## 6. Realtime 이벤트

Supabase Realtime의 Postgres Changes를 그대로 쓴다. 별도 이벤트 버스를 만들지 않는다.

| 구독 대상 | 클라이언트 반응 |
|---|---|
| `rooms` (update) | 페이즈 전환, 타이머 재설정 |
| `players` (insert/update) | 참가자 목록 갱신 |
| `answers` (insert) | `visible_at` 이후에만 화면에 노출 |
| `messages` (insert) | `visible_at` 이후에만 노출 |

**클라이언트는 `visible_at`이 미래인 레코드를 받아도 즉시 보여주지 않는다.** 타이머를 걸어 그 시각에 렌더한다. 이것이 봇 타이핑 지연의 구현이다.

---

## 7. RLS — 보안이 아니라 게임 규칙

이 게임에서 RLS가 뚫리면 게임 자체가 성립하지 않는다.

| 테이블 | 정책 |
|---|---|
| `player_roles` | **select 전면 금지.** reveal 시점에 Edge Function이 계산해 반환 |
| `answers` | 해당 질문이 공개 페이즈로 넘어간 뒤에만 select 허용. 본인 답변은 항상 허용 |
| `votes` | reveal 페이즈에서만 select 허용. insert는 본인 것만 |
| `messages` | 같은 방이면 select 허용 |
| `players` | 같은 방이면 select 허용. **`is_bot` 컬럼은 뷰에서 제외** |

**`is_bot`이 클라이언트로 새어나가면 게임이 즉시 끝난다.** 클라이언트가 읽는 것은 `players` 테이블이 아니라 `is_bot`을 제외한 뷰다.

**검증 방법:** 다른 계정으로 로그인해 직접 뚫어본다. 이 테스트 기록이 그대로 AI 활용 기술 문서의 내용이 된다.

---

## 8. 규칙 계층 인터페이스

`lib/game/rules.ts` — B가 작성, A가 호출. DB를 모른다.

```ts
export function assignRoles(humanCount: number, total: number): Role[];
// 반환: seat 순서대로의 역할 배열
// 규칙: 봇은 전부 'ai'. 인간이 2명 이상이면 1명만 'spy', 나머지 'citizen'

export function calcScores(
  votes: { voterId: string; targetId: string }[],
  roles: Record<string, Role>
): Record<string, number>;

export function mostSuspectedHuman(
  votes: { targetId: string }[],
  roles: Record<string, Role>
): string | null;
```

**A는 이 함수들의 내부를 모르고, B는 DB를 모른다.** 이 경계가 유지되어야 두 사람이 서로를 기다리지 않는다.

---

## 9. 에이전트 인터페이스

`lib/agent/generate.ts`

```ts
export interface AgentContext {
  persona: Persona;
  phase: Phase;
  question?: string;
  visibleHistory: { speaker: string; text: string }[];
  styleProfile: StyleProfile;  // 관측된 인간 말투
  suspicionOnMe: number;
}

export interface AgentOutput {
  messages: string[];
  delaysMs: number[];
  reasoning: string;
  suspicionOnMe: number;
  action: 'answer' | 'deflect' | 'accuse' | 'silent';
}

export async function generate(ctx: AgentContext): Promise<AgentOutput>;
```

**프롬프트 인젝션 방어는 이 계층의 책임이다.** 사용자 발화는 명령이 아니라 관측 데이터로 감싸 전달하고, 정체·지침 관련 요청에는 페르소나 내에서 반응만 한다.

---

## 10. 코딩 컨벤션

- 파일명 kebab-case, 컴포넌트 PascalCase
- 서버 전용 코드에 `'use client'` 금지. Canvas는 `dynamic(..., { ssr: false })`
- 시각은 전부 ISO 문자열로 주고받고, 비교는 서버 시각 기준
- 타입은 `lib/game/types.ts`에서만 정의. 각자 파일에서 중복 선언 금지
- 커밋은 각자 계정으로. 한 사람 기기에서 몰아 커밋하지 않는다 (역할 기술서 근거)

---

## 11. 기술 선택 확정

"유행하는 것"이 아니라 **3인 2주라는 조건에서 장애가 덜 나는 것**을 기준으로 골랐다.

| 영역 | 선택 | 이유 |
|---|---|---|
| 프레임워크 | Next.js 15 App Router | Vercel · Supabase 양쪽 공식 예제가 전부 이 조합 |
| 언어 | TypeScript strict | 타입이 세 사람의 계약서 역할을 한다 |
| DB 접근 | Supabase JS v2 + **Supavisor 트랜잭션 풀러** | 서버리스에서 커넥션 고갈 방지 |
| 방 상태 동기화 | Realtime **Postgres Changes** (`rooms`만) | 초당 수 건. 변경이 드물어 안전 |
| 채팅·답변 동기화 | Realtime **Broadcast** | 고빈도 구간. Postgres Changes보다 훨씬 가볍다 |
| 페이즈 전환 | Edge Function + `phase_seq` 낙관적 잠금 | 중복 호출이 구조적으로 무력화됨 |
| 전환 안전망 | **pg_cron 정기 sweep** | 클라이언트가 전부 죽어도 방이 안 멈춘다 |
| LLM 프록시 | Next.js Route Handler (**Edge Runtime**) | 콜드스타트가 Node 런타임보다 짧다 |
| 클라이언트 상태 | React state + Zustand 1개 스토어 | Redux·RTK 불필요. 상태 대부분이 서버에 있다 |
| 3D | react-three-fiber + drei | 게임 완주 후 도입 |
| 배포 | Vercel + Supabase | 둘 다 무료 티어로 충분 |

**의도적으로 쓰지 않는 것**

Redis, 메시지 큐, 별도 WebSocket 서버, Docker, 모노레포 툴링, 상태머신 라이브러리(XState). 전부 이 규모에서는 관리 비용이 얻는 것보다 크다. **인프라를 하나 늘릴 때마다 장애 지점이 하나 늘어난다.**

---

## 12. 병목과 장애 대응

### 12.1 백그라운드 탭에서 게임이 멈춘다 — 최우선

**증상.** 모바일 브라우저나 비활성 탭에서 `setInterval`이 초당 1회에서 분당 1회 수준으로 스로틀링된다. 페이즈 만료를 감지하지 못해 `advance_phase`가 호출되지 않고, 방이 그 자리에서 멈춘다. **아무도 입력하지 않는 chat 페이즈에서 특히 잘 터진다.**

**대응 세 겹**

1. **정상 경로** — 클라이언트가 만료를 감지해 호출
2. **복귀 즉시 재동기화** — `visibilitychange` 이벤트에서 방 상태를 다시 읽고, 이미 만료됐으면 즉시 호출
3. **안전망** — pg_cron이 주기적으로 만료된 방을 훑어 강제 전환

```sql
select cron.schedule(
  'phase-watchdog', '15 seconds',
  $$ select advance_expired_rooms() $$
);
```

`advance_expired_rooms()`는 `phase_ends_at < now()`인 방을 찾아 각각 전환한다. `phase_seq` 검증을 그대로 통과하므로 클라이언트 호출과 겹쳐도 중복 전환되지 않는다.

**3번이 없으면 심사 중에 게임이 멈춘다.** 이건 선택이 아니라 필수다.

### 12.2 서버리스 커넥션 고갈

**증상.** 동시 요청이 몰리면 `remaining connection slots are reserved` 에러. Postgres 커넥션이 바닥난다.

**대응.** 서버 측 DB 접근은 반드시 **Supavisor 트랜잭션 모드 풀러**(포트 6543)를 쓴다. 직결 포트(5432)는 마이그레이션에만 사용한다. 요청마다 클라이언트를 새로 만들지 말고 모듈 스코프에서 재사용한다.

### 12.3 LLM 호출이 게임을 세운다

**증상.** 봇 답변 생성이 8초 걸리면 페이즈 전환이 8초 늦어진다. API가 죽으면 게임이 영원히 멈춘다.

**대응 네 가지**

- **선생성.** 다음 페이즈에 쓸 봇 답변을 **현재 페이즈가 진행되는 동안** 미리 만들어둔다. chat 120초가 곧 다음 준비 시간이다
- **병렬.** 봇 4명을 `Promise.allSettled`로 동시 호출. 순차 호출은 4배 느리다
- **타임아웃.** `AbortController`로 8초 컷. 초과하면 폐기
- **폴백.** 실패한 봇은 미리 준비한 무해한 응답 풀에서 하나 꺼내 쓴다 ("ㅇㅇ", "아 잠깐만", "나도 몰루"). **LLM 실패가 게임 진행을 막아서는 안 된다**

### 12.4 Realtime 부하

**증상.** Postgres Changes는 변경 한 건마다 구독자별로 RLS를 평가한다. 채팅이 활발한 구간에서 지연이 눈에 띈다.

**대응.** 채팅과 답변은 DB 트리거에서 `realtime.broadcast_changes()`로 쏘고, 클라이언트는 Broadcast 채널을 구독한다. `rooms` 테이블만 Postgres Changes를 유지한다. **방 상태는 정확성이, 채팅은 속도가 중요하다.**

### 12.5 시계 어긋남

**증상.** 클라이언트 시계가 3초 빠르면 그 사람만 먼저 화면이 넘어간다.

**대응.** 접속 시 서버 시각을 한 번 받아 오프셋을 계산하고, 모든 카운트다운을 `serverNow() = Date.now() + offset`으로 계산한다. 판정은 어차피 서버가 하므로 클라이언트 카운트다운은 표시용이다.

### 12.6 비용 폭주

**증상.** chat 페이즈에서 사람이 도배하면 봇 응답이 그만큼 생성된다.

**대응.** 봇당 쿨다운 8초, 한 메시지에 반응하는 봇은 최대 1명, 방당 총 호출 상한 40회. 상한 도달 시 폴백 풀로 전환한다. 호출 수와 토큰을 `agent_logs`에 남겨 기술 문서 근거로 쓴다.

### 12.7 우선순위

전부 하려 하지 말고 이 순서로 넣는다.

| 순위 | 항목 | 시점 |
|---|---|---|
| 1 | pg_cron 안전망 (12.1) | 상태머신 직후 |
| 2 | LLM 타임아웃 + 폴백 (12.3) | LLM 연동과 동시 |
| 3 | Supavisor 풀러 (12.2) | 첫 배포 때 |
| 4 | 시계 오프셋 (12.5) | 타이머 붙일 때 |
| 5 | Broadcast 전환 (12.4) | 채팅 구현 후, 느리면 |
| 6 | 호출 상한 (12.6) | 플레이테스트 전 |

**1번과 2번은 없으면 데모가 멈춘다.** 나머지는 느려지는 정도라 나중에 해도 된다.
