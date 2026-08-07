# SPEC — 사람인 척 (whois-human)

기술 설계 문서. 팀 공용 계약서이자 AI 코딩 에이전트가 읽을 컨텍스트다.
게임 기획은 별도 문서 참조. 이 문서는 **무엇을 어떤 모양으로 만들 것인가**만 다룬다.

---

## 이 문서를 읽는 법

| 대상 | 읽는 순서 |
|---|---|
| 처음 합류한 사람 | 「불변 규칙」 → 「용어」 → §2 소유권 → 자기 담당 섹션 |
| 코딩 에이전트 | 「불변 규칙」 → 「용어」 → 손댈 파일에 해당하는 섹션 → §13 완료 조건 → §14 검증 |
| 막혔을 때 | §15 미결정 사항. 여기 있는 항목은 **추측하지 말고 사람에게 물어본다** |

세 가지 규칙이 있다.

1. **섹션 번호는 고정이다.** 코드 주석이 `SPEC §5.2` 형태로 참조한다. 내용을 고치는 건 자유지만 **재번호를 매기지 않는다.** 새 내용은 §13 이후에 붙인다.
2. **"~한다"는 지켜야 할 규칙, "~때문이다"는 근거다.** 근거에 동의하지 않아도 규칙은 지킨다. 바꾸고 싶으면 문서를 먼저 고친다.
3. **코드와 문서가 어긋나면 문서가 맞다.** 코드를 고치거나, 문서를 고치고 팀에 공지한다. 어긋난 채로 두지 않는다.

---

## 불변 규칙 (INVARIANTS)

이 열 개가 이 프로젝트의 뼈대다. 나머지는 전부 이것들을 지키기 위한 수단이다.

| # | 규칙 | 위반 시 증상 | 적용 위치 |
|---|---|---|---|
| **I1** | **어느 자리가 봇인지** 노출하지 않는다. 클라이언트는 `players`가 아니라 `public_players` 뷰를 읽는다. 봇이 **몇인지**는 공개해도 된다 (§15-3) | 누가 봇인지 즉시 드러나 **게임 자체가 성립하지 않는다** | `supabase/policies.sql`, 모든 클라이언트 쿼리 |
| **I2** | 페이즈 전환 판정은 서버 시각만 쓴다. 클라이언트 카운트다운은 표시용이다 | 시계가 3초 빠른 사람만 화면이 먼저 넘어간다 | `lib/server/phase.ts`, `supabase/functions/` |
| **I3** | `lib/game/**`는 순수 함수만. DB·네트워크·`Date.now()`·랜덤 금지 | 테스트가 불가능해지고, A와 B가 서로를 기다리게 된다 | `lib/game/` |
| **I4** | LLM API 키는 서버에서만 읽는다. 호출 경로는 `app/api/agent/` 하나뿐이다 | 키가 클라이언트 번들에 실려 유출된다 | `app/api/agent/route.ts` |
| **I5** | 조기 종료 인원은 `is_bot = false`인 플레이어만 센다. **§18.6에서 `and connected`가 붙었다** | 봇은 즉시 제출하므로 **모든 페이즈가 시작하자마자 끝난다.** `connected`를 안 보면 반대로 **한 명만 나가도 매 페이즈가 시간을 꽉 채운다** | `advance_phase` |
| **I6** | `advance_phase`는 항상 `expected_seq`와 함께 호출한다 | 5명이 동시에 호출해 페이즈가 두세 칸 건너뛴다 | 클라이언트 타이머, pg_cron sweep |
| **I7** | 자기 소유 폴더 밖의 파일은 수정하지 않는다 (예외: `lib/game/types.ts`) | 머지 충돌. 커밋 이력을 역할 기술서 근거로 못 쓰게 된다 | §2 |
| **I8** | 도메인 타입은 `lib/game/types.ts`에서만 정의한다 | 같은 개념이 세 군데서 다르게 정의돼 런타임에 깨진다 | 전 파일 |
| **I9** | 쓰기(insert/update)는 전부 service role 서버를 거친다. 클라이언트 anon 키는 읽기 전용이다 | 익명 플레이라 DB가 요청자를 식별할 수 없어 남의 투표·답변 위조를 못 막는다 | `lib/server/`, `supabase/policies.sql` |
| **I10** | 모든 구독·채널·쿼리를 방으로 스코프한다. 방 필터 없는 `select`나 구독을 만들지 않는다 | **다른 방의 전환 이벤트가 내 화면에 들어와 엉뚱한 타이밍에 페이즈가 넘어간다.** 방이 늘수록 심해진다 | §16, 모든 클라이언트 쿼리 |

---

## 용어

같은 단어를 다르게 이해하면 코드가 어긋난다. 헷갈리기 쉬운 것만 모았다.

| 용어 | 뜻 | 헷갈리기 쉬운 것 |
|---|---|---|
| `seat` | 1~정원. 화면 표시 순서 | **입장 순서가 아니다.** 한 번 정해지면 게임 내내 안 바뀐다. **정원은 방마다 다르다 — 5로 하드코딩하지 않는다** (§17.6) |
| `nickname` | '익명1' ~ '익명<정원>' | seat 숫자와 일치할 필요는 없다 |
| `capacity` | 그 방 **총 자리의 상한**. 3~10 중 **6을 뺀 값**, 기본 5 | 현재 인원도 실제 좌석 수도 아니다. **사람 상한은 여기서 유도한다** — 총 자리 8이면 사람 6명까지 (§18.1). 만든 뒤로 바뀌지 않는다 (§17.6) |
| `seat_count` | 그 판의 **실제 총 자리**. 3~10 | 시작할 때 모인 사람 수로 정해진다. 그전에는 `null`. **좌석 그리드는 이 수로 그린다** (§18.1) |
| `mask_id` | 아바타·가면 에셋 키 | 정체와 무관하다. 노출돼도 안전하다 |
| `phase_seq` | 페이즈 전환마다 +1 되는 정수 | **라운드 번호가 아니다.** 중복 전환을 막는 낙관적 잠금 키다 |
| `round` | question 페이즈의 1 또는 2 | question 외 페이즈에서는 의미 없다 |
| `visible_at` | 이 시각 **이후에만** 화면에 띄운다 | `created_at`이 아니다. 미래 시각일 수 있다 |
| **사람 전원** | `is_bot = false`인 플레이어 전원 | 봇 포함이 아니다 (I5) |
| **조기 종료** | 시간 만료 전에 조건을 충족해 넘어가는 것 | **question·vote에만 있다.** target·chat은 시간을 꽉 채운다 (§5.3) |
| **봇 / AI** | `is_bot = true`인 플레이어. 역할은 `'ai'` | 연기자(`'actor'`)는 사람이다. 헷갈리면 게임 규칙이 깨진다 |
| **연기자** | AI인 척하는 사람. 역할은 `'actor'` | 예전 이름은 '스파이'였다 (§18.2). **수는 랜덤이고 서로를 모른다** |
| **지목** | 투표 끝에 뽑힌 한 자리 | target 페이즈의 '지목 질문'과 다르다. 판의 승패를 정하는 건 이쪽이다 (§18.4) |

---

## 0. 한 줄 요약

최대 10자리(사람 8 + AI 2)인 채팅방에서 누가 AI인지 찾는 웹 게임. 방을 만들 때 **총 자리**를 정하고(3~10 중 6 제외, 기본 5), 실제 자리 수와 AI 수는 **시작할 때 모인 사람 수**로 정해진다 (§18.1). **AI가 몇인지는 그렇게 공개되지만, 어느 자리인지는 끝까지 숨긴다** (§15-3). 사람 중 일부는 AI인 척해야 하는 **연기자**이고, **그 수는 랜덤이라 아무도 모른다** (§18.2).

**게임 규칙의 기준은 §18이다.** 진영 구성·승패·투표는 거기서 확정했다. 앞 섹션과 어긋나면 §18이 맞다.

---

## 1. 스택

| 영역 | 선택 | 비고 |
|---|---|---|
| 프레임워크 | Next.js 15 (App Router) + TypeScript strict | |
| 스타일 | Tailwind CSS v4 | |
| DB / 실시간 | Supabase (Postgres + Realtime) | |
| 서버 로직 | Supabase Edge Function + Next.js Route Handler | |
| 3D | react-three-fiber + drei | 게임이 끝까지 돌아간 뒤에 도입. 그 전에는 2D |
| LLM | **NVIDIA NIM API — §15-1-결정** | OpenAI 호환 REST. 프록시는 `/api/agent`(edge) 경유 |
| 배포 | Vercel | 첫날부터 URL 유지 |

**금지 사항** (근거는 「불변 규칙」)

- 클라이언트에서 LLM API 직접 호출 금지 — **I4**
- 클라이언트 시계로 페이즈 전환 판단 금지 — **I2**
- `lib/game` 안에서 DB·네트워크 접근 금지 — **I3**

---

## 2. 폴더 구조와 소유권

```
app/
  page.tsx                 랜딩 · 방 만들기 / 입장                    [C]
  room/[code]/page.tsx     게임 화면 (페이즈에 따라 분기)              [C]
  api/
    agent/route.ts         LLM 프록시 (A가 껍데기, B가 내용)          [A/B]
components/                UI 컴포넌트                                [C]
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
supabase/                  ★ A 단독 소유
  schema.sql               테이블 · 인덱스
  policies.sql             RLS
  functions/               Edge Function
mock/
  room.json                목 데이터                                  [C]
docs/
  SPEC.md                  이 문서
CLAUDE.md                  에이전트 세션마다 자동으로 읽히는 요약
```

**규칙: 자기 폴더 밖의 파일은 수정하지 않는다 (I7).** 필요하면 소유자에게 요청한다. 예외는 `lib/game/types.ts` — 여기만 셋이 함께 편집하되, 변경 시 팀 채널에 공지한다.

---

## 3. 도메인 타입

`lib/game/types.ts`. 이 파일이 프론트·백·에이전트의 공통 언어다. **여기 없는 도메인 타입을 각자 파일에서 새로 만들지 않는다 (I8).**

```ts
export type Phase =
  | 'lobby'
  | 'question'   // round 1, 2
  | 'target'     // 지목 질문
  | 'chat'       // 자유 채팅
  | 'vote'
  | 'revote'     // ★ §18.3 — 최다 득표가 동점일 때만. 20초, 후보는 동점자
  | 'reveal'
  | 'replay';

// ★ §18.2 — 'spy'를 'actor'(연기자)로 바꿨다. 아래 두 줄은 아직 코드에 반영되지 않았다
export type Role = 'citizen' | 'actor' | 'ai';

export type AgentAction = 'answer' | 'deflect' | 'accuse' | 'silent';

export interface Room {
  id: string;
  code: string;                 // 4자 대문자
  phase: Phase;
  phase_seq: number;            // 전환마다 +1. 중복 전환 방지 키
  phase_ends_at: string | null; // ISO. null이면 무기한(lobby)
  round: number;                // question 페이즈에서만 의미 있음
  host_id: string;
  capacity: number;             // 총 자리의 상한. 3~10 중 6 제외, 기본 5 (§18.1). 만든 뒤로 바뀌지 않는다 (§17.6)
  seat_count: number | null;    // ★ §18.1 — 그 판의 실제 총 자리(3~10). 시작할 때 확정. 그전에는 null
}

export interface Player {
  id: string;
  room_id: string;
  nickname: string;      // '익명1' ~ '익명<정원>'
  mask_id: string;
  seat: number;          // 1~그 방의 capacity. 표시 순서 고정
  is_bot: boolean;       // ★ 클라이언트에 절대 내려가지 않는다 (I1)
  connected: boolean;
}

/** 클라이언트가 실제로 받는 모양. is_bot이 없다. public_players 뷰와 1:1 대응. */
export type PublicPlayer = Omit<Player, 'is_bot'>;

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
  action: AgentAction;
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
  -- 방마다 정하는 정원. 하한 3·상한 8의 근거는 §17.6
  capacity      int  not null default 5 check (capacity between 3 and 8),
  created_at    timestamptz not null default now()
);

create table players (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references rooms(id) on delete cascade,
  nickname   text not null,
  mask_id    text not null,
  -- 상한 8은 정원의 상한이다. 그 방의 실제 상한은 room_capacity(room_id)가 본다 (§17.6)
  seat       int  not null check (seat between 1 and 8),
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

create index on players    (room_id);
create index on messages   (room_id, visible_at);
create index on answers    (room_id, question_id);
create index on questions  (room_id, round);
create index on agent_logs (room_id);

-- pg_cron 워치독이 15초마다 훑는다. 없으면 방이 쌓일수록 전체 스캔이 된다 (§16.3)
create index on rooms (phase_ends_at) where phase_ends_at is not null;
```

**정원을 읽는 자리는 SQL 함수 두 개뿐이다.** `default_room_capacity()`가 기본값(5)을, `room_capacity(p_room_id uuid)`가 그 방의 정원을 돌려준다. 좌석 배정·봇 채우기·정원 초과 판정은 전부 후자를 부른다. **숫자를 다시 적지 않는다** — 한 군데만 고치면 되도록 함수로 뺐다. `create_room(p_code text, p_capacity int default null)`은 인자가 없으면 기본값을 쓴다.

**적용 순서.** `schema.sql` → `policies.sql`. 직결 포트(5432)로 적용한다 (§12.2).

**§18에서 바뀌기로 한 것 (아직 반영 전).** `capacity` 제약을 `between 3 and 10 and capacity <> 6`으로(뜻과 기본값 5는 그대로 — §18.1), `seat` 제약을 `between 1 and 10`으로 고치고, `rooms`에 `seat_count int`(그 판의 실제 총 자리, 시작 전 `null`)를 더하고, `phase` 체크에 `'revote'`를 더한다. 위 SQL은 **현재 코드 그대로**라 일부러 안 고쳤다 — 스키마를 옮길 때 여기도 같이 고친다 (§18.7의 손대는 순서 2번).

**`room_capacity()`도 둘로 갈린다.** 지금은 이 함수 하나가 "몇 자리인가"와 "몇 명까지 받나"를 겸하는데, §18.1이 그 둘을 다른 수로 만들었다. **입장 판정은 `capacity`에서 유도한 사람 상한**을, **시작 뒤의 좌석·초과 판정은 `seat_count`**를 본다. 한 함수가 계속 둘을 겸하면 정확히 여기서 섞인다.

---

## 5. 페이즈 상태머신

**A의 본체.** 여기가 꼬이면 전부 멈춘다.

### 5.1 전환표

| 현재 | 다음 | 길이 | 전환 조건 |
|---|---|---|---|
| lobby | question(1) | — | 방장이 시작 |
| question(1) | question(2) | 60초 | 시간 만료 **또는** 사람 전원 제출 |
| question(2) | target | 60초 | 시간 만료 **또는** 사람 전원 제출 |
| target | chat | 30초 | 시간 만료만. **대상이 사람이든 봇이든 조기 종료가 없다** (§5.3) |
| chat | vote | 120초 | 시간 만료만 |
| vote | reveal **또는** revote | 30초 | 시간 만료 **또는** 사람 전원 투표. **사람 표**의 최다 득표가 동점이면 revote로 간다 (§18.3) |
| revote | reveal | 20초 | 시간 만료 **또는** 사람 전원 투표. 후보는 동점자뿐. 여기서도 동점이면 **동점자 중 무작위**로 지목한다 |
| reveal | replay | — | 클라이언트 조작 |

**"사람 전원"이 핵심 (I5).** 봇은 즉시 제출하므로 봇을 포함해 세면 조건이 항상 참이 된다. `is_bot = false`인 플레이어만 센다.

### 5.2 전환 트리거

상주 서버가 없으므로 클라이언트가 만료를 감지해 호출하고, 서버가 다시 검증한다.

```
클라이언트: phase_ends_at 경과 감지
  → POST /api/phase/advance { room_id, expected_seq: 현재 phase_seq }
     (쿠키의 player_token으로 본인 확인 후, 서버가 service role로 RPC 호출)

서버(advance_phase):
  1. 행 잠금 (select ... for update)
  2. expected_seq !== rooms.phase_seq  → 아무것도 안 하고 종료
  3. now() < phase_ends_at 이고 조기종료 조건 미충족 → 종료
  4. 다음 페이즈 계산, phase_seq += 1, phase_ends_at 갱신
  5. 새 페이즈 진입 훅 실행 (5.3)
  6. Realtime이 rooms 변경을 자동 브로드캐스트
```

`phase_seq` 하나로 중복 호출이 전부 무력화된다. 5명이 동시에 호출해도 첫 호출만 성공한다 (I6).

**`advance_phase` RPC는 anon에게 열지 않는다.** 방장 확인(lobby → question)이 필요한데, 호출자가 넘긴 `actor_id`는 호출자가 마음대로 적을 수 있는 값이라 그것만으로는 아무것도 확인하지 못한다. `host_id`는 `rooms`로 누구나 읽는다. 그래서 **쿠키의 `player_token`으로 `player_id`를 되찾은 뒤**(§17.4) service role로 RPC를 부르는 `/api/phase/advance` 하나만 통로로 둔다. I9와 같은 이유다.

**호출자는 세 종류다.** 전부 같은 RPC를 같은 방식으로 부른다.

1. 만료를 감지한 클라이언트 타이머
2. `visibilitychange`로 복귀한 클라이언트 (§12.1)
3. pg_cron sweep (§12.1)

**여러 방이 동시에 돌 때 1번 잠금이 문제가 된다.** sweep이 이미 전환 중인 방에서 `for update`를 기다리면 뒤쪽 방들이 통째로 밀린다. sweep은 `for update skip locked`로 잠긴 방을 건너뛴다 (§16.2).

### 5.3 페이즈 진입 훅

| 진입 페이즈 | 서버가 하는 일 |
|---|---|
| question | 질문 1개 선택 후 insert. **봇 답변을 즉시 생성**하고 `visible_at`을 공개 시점으로 설정. 문구는 **그 질문에 달린 것**을 봇끼리 겹치지 않게 배정한다 (§17.2) |
| target | 지목 대상 결정. 대상이 봇이면 답변 생성 (역시 그 질문에 달린 문구) |
| chat | 봇별 쿨다운 초기화 |
| vote | 봇 투표 생성 |
| reveal | 결과 확정. **`calcScores`는 TS 순수 함수라 DB 안에서 못 부른다** — reveal 화면이 `/api/reveal`을 부를 때 계산한다 (§17.2) |

**봇 답변은 페이즈 시작 시 한꺼번에 만든다.** 함수가 6초를 기다릴 수 없으므로, 지연은 `visible_at`에 시각으로 박고 클라이언트가 그 시점에 띄운다.

**이 훅을 누가 실행하는지는 §17.2에서 확정했다.** 지금은 전환 함수(plpgsql)가 DB 안의 문구 풀에서 뽑아 넣는다. LLM을 붙인 뒤에는 §12.3의 선생성 층이 미리 넣어두고, 이 훅은 준비된 게 없을 때만 폴백으로 돈다. **§12.3의 "선생성"과 여기의 "즉시 생성"은 순서가 다른 게 아니라 층이 다르다.** 이렇게 둬야 워치독이 전환한 방에서도 봇이 말한다.

**target 페이즈에는 조기 종료가 아예 없다.** 대상이 사람이든 봇이든 30초를 꽉 채운다.

여기까지 오는 데 두 번을 고쳤다. 기록해둔다 — 같은 함정에 세 번째로 빠지지 않기 위해서다.

1. 처음에는 "대상자가 제출하면 넘어간다"였다. 봇은 진입 즉시 답변이 생기므로(위 훅) **페이즈가 0초에 끝나 대상이 봇임이 그대로 드러났다.** I5와 똑같은 함정인데, I5는 "인원을 센다"는 문장이라 이 경우를 못 잡는다.
2. 그래서 "대상이 봇이면 조기 종료하지 않는다"로 바꿨다. 그런데 이 처방은 **누수의 방향만 뒤집었다.** 봇이 대상이면 항상 30초를 채우고 사람이 대상이면 답하는 즉시 넘어가니, "빨리 넘어갔다"가 곧 "대상은 사람"이라는 확정 신호가 된다. 아래 문단이 스스로 적어둔 경고 — "봇일 때만 짧게 하면 그게 다시 신호가 된다" — 의 거울상이다.

**교훈: 페이즈 길이가 대상의 정체에 따라 달라지면 어느 방향이든 샌다.** 대칭을 만드는 방법은 하나뿐이다 — 양쪽 다 시간을 채운다.

**그 대가가 target 30초다.** 한 사람만 답하는데 나머지는 할 일이 없고, 이제 그 시간을 매번 꽉 채운다. 죽은 시간을 줄이려고 60초에서 내렸다. **여기서 더 줄이거나 조건부로 짧게 만들 수는 없다** — 조건부는 곧 신호다. 답을 뜯어보는 시간은 바로 뒤 chat 120초가 맡는다.

**같은 이유로 봇도 반드시 답한다.** 답이 빈 자리는 사람만 만들 수 있으므로, 봇 답변이 하나라도 비면 그 자리가 사람으로 확정된다. 그래서 문구가 봇 수보다 모자라면 진입 훅이 조용히 넘어가지 않고 예외를 던진다 (§17.2).

**→ §18.5에서 앞 문단의 앞부분이 뒤집혔다.** 빈칸이 사람 쪽에서만 생기는 게 문제였으므로, **봇도 약 15% 확률로 답을 거른다.** 뒷부분(문구 풀 부족은 예외를 던진다)은 그대로다 — 일부러 거르는 침묵과 풀이 모자라서 비는 것은 원인이 다르다.

### 5.4 자유 채팅 예외

chat 페이즈만 실시간 반응이 필요하다. 사람 메시지가 insert될 때마다 봇 응답 여부를 판단한다.

- 봇당 쿨다운 최소 8초
- 한 사람 메시지에 반응하는 봇은 최대 1명
- 이 구간이 API 호출이 가장 몰리는 지점 — 호출 수를 `agent_logs`에 남긴다

**→ §18.5에서 "반응만 한다"가 깨졌다.** 봇마다 8~15초 사이의 **서로 다른** 침묵 임계를 갖고, 아무 말도 안 오는 시간이 그만큼 이어지면 봇 하나가 **먼저 말을 꺼낸다.** 임계를 봇끼리 같게 두면 그 간격이 다시 신호가 된다.

---

## 6. Realtime 동기화

**두 경로를 쓴다. 목적이 다르다.**

| 대상 | 전송 방식 | 이유 |
|---|---|---|
| `rooms` (update) | **Postgres Changes** | 초당 수 건. 변경이 드물고 **정확성**이 중요하다 |
| `answers` (insert) | **보내지 않는다** | 페이즈가 끝나야 공개된다. 전환은 `rooms`가 알려주므로 그때 다시 읽으면 된다 |
| `messages` (insert) | **`public_messages` 뷰를 1.5초 폴링** | 실시간이 필요하지만 **Broadcast는 도착 시각으로 봇을 드러낸다** (§6.1) |
| `players` (insert/update) | **`rooms.roster_seq` 신호 + 재조회** | 참가자 목록 갱신. **뷰는 구독할 수 없다** — 아래 이유 |

**`players`는 직접 구독할 수 없다.** Postgres Changes는 논리 복제 publication을 타는데 **publication에는 테이블만 넣을 수 있고 뷰는 넣을 수 없다.** `public_players`는 뷰라서 WAL을 만들지 않는다. 그렇다고 `players` 테이블을 구독하면 `is_bot`이 실려 나가고(I1), 애초에 anon에게서 revoke했으므로 배달 평가에서 전부 걸러진다.

**대신 신호만 보낸다.** `players`가 바뀌면 트리거가 `rooms.roster_seq`를 +1 한다. 클라이언트는 이미 걸어둔 `rooms` 구독에서 그 변화를 보고 `public_players`를 다시 읽는다. 새 채널도 새 정책도 필요 없고, 방 필터(I10)는 `rooms` 구독에 이미 걸려 있다.

### 6.1 왜 답변·채팅은 Broadcast여야 하는가

Postgres Changes는 **배달 시점에 RLS를 평가한다.** 그런데 answers·messages의 select 정책은 `visible_at <= now()`다 (§7). 즉 **`visible_at`이 미래인 행은 구독자에게 아예 전달되지 않는다.**

봇의 타이핑 지연은 "미래 `visible_at`을 가진 행을 미리 받아두고 그 시각에 렌더"하는 방식이다. Postgres Changes로는 이 행이 오지 않으므로 **지연 연출이 통째로 깨진다.**

Broadcast는 트리거가 직접 쏘므로 RLS 배달 평가를 거치지 않는다. 페이로드에 `visible_at`이 실려 오고, 클라이언트가 그 시각에 렌더한다.

**그 대가로 도착 시각이 새어나간다.** Broadcast는 RLS를 우회하므로 devtools에서 페이로드가 그대로 보이고, **행이 언제 insert됐는지가 그대로 드러난다.** 봇 답변은 페이즈 진입 시 한꺼번에 들어가고 사람 답변은 각자 제출할 때 들어가므로, 도착 시각만 늘어놓아도 봇이 갈린다 (I1).

**그래서 답변은 Broadcast로 쏘지 않는다.** 답변은 실시간이 필요 없다 — 어차피 페이즈가 끝나야 공개된다. 페이즈가 넘어가면 `rooms` 구독이 알려주고, 그때 클라이언트가 다시 읽는다.

**채팅도 Broadcast를 쓰지 않기로 했다.** 같은 이유가 더 세게 걸린다. 봇 메시지는 타이핑 지연 때문에 미래 `visible_at`을 갖는데 브로드캐스트는 insert 순간에 나간다. 도착과 표시 사이의 간격이 봇만 유독 길어서, devtools를 열면 그것만으로 봇이 갈린다. 사람 메시지에도 같은 지연을 주는 방법은 채팅을 굼뜨게 만들고, 표시 시각에 맞춰 쏘려면 1초 단위 스케줄러가 필요하다.

**대신 `public_messages` 뷰를 1.5초마다 읽는다.**

```sql
create view public_messages as
  select id, room_id, player_id, text, visible_at
    from messages where visible_at <= now();
```

- **`created_at`을 뷰에서 뺀다.** 봇은 `created_at`과 `visible_at`이 몇 초 벌어지고 사람은 같다. 그 간격이 곧 봇 표시다 — `public_players`에서 `created_at`을 뺀 것과 같은 이유다 (§7.2)
- **행 필터를 뷰 안에 박는다.** 클라이언트 선의가 아니라 서버가 막는다. 아직 시간이 안 된 메시지는 애초에 나오지 않는다
- **대가는 최대 1.5초 지연이다.** 봇이 일부러 2~8초를 끄는 판에서 문제가 되지 않는다. 자리 상한인 10인 × 1.5초 폴링도 부하가 아니다 (§18.1에서 8에서 10으로 올랐다)

**속도보다 I1이 먼저다.** §12.4가 Broadcast를 고른 이유는 속도였는데, 그 속도가 게임을 깨면 의미가 없다.

### 6.2 클라이언트 계약

**클라이언트는 `visible_at`이 미래인 레코드를 받아도 즉시 보여주지 않는다.** 타이머를 걸어 그 시각에 렌더한다. 이것이 봇 타이핑 지연의 구현이다.

`visible_at` 비교는 서버 시각 오프셋을 적용한 `serverNow()`로 한다 (§12.5).

### 6.3 방 스코프 — 구독에 반드시 필터를 건다 (I10)

**필터 없는 구독은 다른 방의 이벤트를 받는다.** `rooms` 테이블을 통째로 구독하면 B방이 vote로 넘어갈 때 A방 사람 화면도 같이 넘어간다. 방이 두 개만 돼도 바로 터진다.

| 대상 | 필터 |
|---|---|
| `rooms` | `filter: 'id=eq.<room_id>'` |
| `players` / `public_players` | `filter: 'room_id=eq.<room_id>'` |
| Broadcast 채널 | 채널 이름을 `room:<room_id>`로. 방마다 다른 채널 |

REST 조회도 같다. `.eq('room_id', roomId)` 없는 `select`를 만들지 않는다.

**채널 이름에 `code`가 아니라 `room_id`를 쓴다.** 코드는 4자라 추측 가능하고, 방이 정리되면 재사용될 수 있다 (§16.4).

---

## 7. RLS — 보안이 아니라 게임 규칙

이 게임에서 RLS가 뚫리면 게임 자체가 성립하지 않는다.

### 7.1 전제 — 익명 플레이라 "본인"을 식별할 수 없다

Supabase Auth를 쓰지 않으므로 DB는 "지금 이 요청이 어느 player인지"를 모른다. 따라서 "본인 답변은 항상 허용", "insert는 본인 것만" 같은 규칙은 **DB 정책으로 표현할 수 없다.**

**결론 (I9): 클라이언트는 읽기만 한다.** 모든 쓰기는 service role을 쥔 서버(Route Handler / Edge Function)를 거치고, 거기서 `player_id`를 검증한다. RLS는 "읽으면 안 되는 것"만 막는 역할로 좁힌다.

**단, 서버도 `player_id`만으로는 본인을 확인할 수 없다.** `player_id`는 `public_players`로 누구나 읽는다. 그대로 두면 남의 이름으로 답변·투표를 넣을 수 있다. 그래서 **입장할 때 `player_token`을 발급해 httpOnly 쿠키로 내려주고, 모든 쓰기 라우트가 그 토큰으로 `player_id`를 되찾는다** (§17.4). 토큰은 `players` 테이블에만 있고 `public_players` 뷰에는 넣지 않는다.

### 7.2 정책

| 테이블 | select 정책 |
|---|---|
| `player_roles` | **전면 금지.** 정책을 만들지 않는다. reveal 시점에 Edge Function이 계산해 반환 |
| `agent_logs` | **전면 금지.** 기술 문서용 데이터라 서버에서만 읽는다 |
| `players` | **테이블 접근 자체를 revoke.** `is_bot`을 뺀 `public_players` 뷰만 grant (I1) |
| `answers` | `visible_at <= now()` |
| `messages` | `visible_at <= now()` |
| `votes` | 방의 phase가 `reveal` 또는 `replay`일 때만 |
| `rooms` | 허용 (코드로 방을 찾아야 한다) |
| `questions` | 허용 |

**`is_bot`이 클라이언트로 새어나가면 게임이 즉시 끝난다.** 클라이언트가 읽는 것은 `players` 테이블이 아니라 `is_bot`을 제외한 뷰다.

**뷰에서 뺄 것은 `is_bot`만이 아니다.** `created_at`도 빼야 한다 — 봇은 시작 순간 한꺼번에 생성되므로 생성 시각이 몇 ms 안에 뭉치고, 사람은 몇 분에 걸쳐 들어온다. **`select created_at from public_players` 한 번으로 봇이 전부 특정된다.** `player_token`도 당연히 뺀다. 뷰에 컬럼을 더할 때는 매번 "이걸로 봇을 골라낼 수 있나"를 먼저 묻는다.

### 7.3 RLS는 방을 가르지 못한다 — 알고 쓴다

위 정책 어디에도 "내 방만"이라는 조건이 없다. 7.1과 같은 이유다. DB가 요청자를 모르니 **어느 방 사람인지도 모른다.**

**헤더나 GUC로 방을 넘겨 정책에 쓰는 방법은 쓰지 않는다.** Realtime Postgres Changes는 배달 시점에 RLS를 평가하는데 그 경로에는 REST 요청 헤더가 없다. `rooms`·`players`에 그런 정책을 걸면 **실시간 이벤트가 아무에게도 배달되지 않는다.** §6이 통째로 죽는다.

따라서 방 격리는 지금 **클라이언트 계약(§6.3, I10)으로만** 유지된다. DB로 강제하려면 익명 인증이 필요하다 (§15-2).

**현재 노출 범위를 정확히 알고 있을 것.** anon 키로 다른 방의 닉네임·좌석·질문·공개된 답변·채팅을 읽을 수 있다. 반면 **`is_bot`, 역할, 미공개 답변, reveal 이전 투표, `agent_logs`는 어느 방에서도 안 보인다.** 게임의 승패를 가르는 정보는 전부 막혀 있고, 새는 것은 익명 대화 내용이다.

### 7.4 검증

§14.2의 침투 쿼리를 anon 키로 직접 돌려본다. 이 테스트 기록이 그대로 AI 활용 기술 문서의 내용이 된다.

---

## 8. 규칙 계층 인터페이스

`lib/game/rules.ts` — B가 작성, A가 호출. **DB를 모른다 (I3).**

> **★ §18.4에서 채점이 폐기됐다.** 판의 결론은 진영 승패 하나뿐이다. 아래 `calcScores`와 `mostSuspectedHuman`은 **더 이상 규칙이 아니고**, `lib/server/fallback-rules.ts`와 함께 지워질 대상이다. 이 자리에 새로 들어올 것은 셋이다 — 인원표를 읽는 함수(§18.1), 역할 배열을 만드는 `assignRoles`(연기자 수 랜덤 반영), 지목된 자리의 역할로 승리 진영을 내놓는 함수(§18.4). 셋 다 DB를 모르므로 이 파일이 맞는 자리다.
>
> **`assignRoles`의 주석도 틀렸다.** "사람이 2명 이상이면 그중 1명만 `'spy'`"는 스파이가 정확히 한 명이던 시절의 규칙이다. 지금은 **연기자가 0~2명이고 그 수 자체가 랜덤**이다 (§18.2). 다만 시그니처는 그대로 살아남는다 — 이 함수는 인원수가 아니라 `isBotBySeat` 배열을 받고 `seed`로 무작위를 받으므로, **연기자 수를 뽑는 난수도 같은 `seed`에서 나온다.** 아래 §8 본문이 자랑한 설계가 여기서 한 번 더 값을 한 셈이다.

```ts
export function assignRoles(
  isBotBySeat: boolean[],  // seat 1..N 순서. 어느 자리가 봇인지는 호출자(A)가 안다
  seed: number,            // 스파이를 고르는 난수. 함수 안에서 만들지 않는다 (I3)
): Role[];
// 반환: seat 순서대로의 역할 배열. 입력과 길이가 같다
// 규칙: 봇 자리는 전부 'ai'. 사람이 2명 이상이면 그중 1명만 'spy', 나머지 'citizen'

export function calcScores(
  votes: { voterId: string; targetId: string }[],
  roles: Record<string, Role>
): Record<string, number>;
// 채점 규칙 (§8.1에서 확정). **사람이 던진 표만 센다.**
//   시민   — 진짜 AI에게 투표했으면 +2
//   스파이 — 사람 표를 한 장이라도 받으면 +4 (표 수에 비례하지 않는다)
//   AI     — 사람 표를 한 장도 안 받으면 +3
//   봇이 던진 표는 세지 않는다 — 무작위라서 실력이 아니다
//
// ★ 지금 이 규칙을 실제로 굴리는 것은 lib/server/fallback-rules.ts다.
//   B가 여기를 구현하면 그 파일을 지우고 규칙을 그대로 옮긴다.

export function mostSuspectedHuman(
  votes: { targetId: string }[],
  roles: Record<string, Role>
): string | null;
```

**정원이 방마다 달라져도 이 함수들은 안 바뀐다.** `assignRoles`가 받는 것은 정원이 아니라 `isBotBySeat` 배열이고, 반환도 "입력과 같은 길이"로만 정의돼 있다. 길이가 3이든 8이든 규칙("봇은 'ai', 사람이 2명 이상이면 그중 1명이 'spy'")이 그대로 성립한다. §17.6에서 정원을 3~8로 열 때 `lib/game/`을 한 줄도 고치지 않은 것이 이 설계의 성과다 — **개수가 아니라 배열을 받았기 때문이다.**

**A는 이 함수들의 내부를 모르고, B는 DB를 모른다.** 이 경계가 유지되어야 두 사람이 서로를 기다리지 않는다.

순수 함수이므로 랜덤이 필요하면 **인자로 받는다.** 함수 안에서 `Math.random()`을 부르지 않는다 (I3). `assignRoles`의 `seed`가 그 예다 — 이 인자가 없으면 스파이를 못 고른다.

### 8.1 봇 투표는 무작위다 — 그래서 점수에서 뺀다

> **★ 점수는 §18.4에서 사라졌지만 이 절의 결론은 살아남았다.** "봇 표는 세지 않는다"가 이제 **승패 판정**에 적용된다 (§18.3). 아래는 그 판단이 어떻게 나왔는지의 기록이다. 마지막 문단의 "봇이 0대인 방" 구멍은 §18.1이 없앴다 — AI가 항상 1대 이상이다.

**문제.** 봇은 자기 아닌 아무나 그냥 고른다 (`on_enter_phase`의 vote 훅). 사람 2명이 들어온 정원 5인 방이면 5표 중 3표가 그 무작위 표이고, **정원이 커질수록 나빠진다** — 정원 8인 방에서는 최악이 8표 중 6표다 (§17.6). 점수가 실력이 아니라 주사위를 재는 자가 된다.

특히 옛 규칙("스파이는 받은 표 하나당 +2")에서는 **스파이 점수가 통째로 운이었다.** 게다가 표 수에 비례했으므로 스파이 상한이 정원에 딸려 올라가, 정원 8인 방에서 최대 14점 — 시민 상한(2점)의 7배였다.

**결정: 사람이 던진 표만 센다.** 두 선택지 중 후자를 골랐다.

- ~~봇이 근거를 갖고 투표한다~~ — LLM을 붙일 때 `agent_logs`의 `suspicion`을 근거로 고르게 하는 안이다 (§9). AI를 얹기 전에는 쓸 수 없어서 접었다. §17.5에서 다시 본다
- **봇 표를 점수에서 뺀다** ← 이걸 골랐다. 운이 사라진다

**같이 정한 것: 스파이 점수를 표 수에 비례시키지 않는다.** "사람 표를 한 장이라도 받으면 +4"로 고정한다. 비례하면 상한이 정원에 딸려 올라가 정원만 큰 방에서 스파이가 자동으로 1등이 된다.

**대가.** 사람이 적은 방에서는 점수가 잘 안 움직인다. 사람 2명 · 봇 3명인 방이면 오가는 표가 2장뿐이다. 이건 §8.1이 처음부터 예고한 대가이고, 그래도 주사위보다는 낫다.

**남은 구멍: 봇이 0대인 방.** 사람이 정원을 다 채우면 역할 `'ai'`가 하나도 없어 **시민이 +2를 받을 방법이 사라진다** (시민 전원 0점, 스파이만 득점). §15-3-결정이 "0명일 수도 있다"를 긴장 요소로 남겨두면서 이 경우의 채점을 정하지 않았다. 고치는 방법은 둘이다 — 입장을 정원−1까지만 받아 봇을 최소 1대 보장하거나, 그 판에서만 "스파이를 지목하면 시민 +2"를 켜거나. **정해지지 않았다.**

**`assignRoles`는 seat 배열을 받지 플레이어 수를 받지 않는다.** 개수만 받으면 "앞쪽 seat이 사람"이라는 가정이 함수 안에 숨는다. 그 가정은 §17.4에서 깬다 — 봇 자리를 섞기 때문이다.

---

## 9. 에이전트 인터페이스

`lib/agent/generate.ts`. **이 인터페이스는 LLM 공급자와 무관하다.** 공급자가 바뀌어도 이 시그니처는 그대로다 (§15-1).

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
  action: AgentAction;
}

// call은 route가 넘겨주는 LLM 호출 함수(§9.2, LlmCall — lib/game/types.ts).
// 없으면 즉시 폴백 — 키가 없어도 게임은 돈다 (§13-5).
export async function generate(ctx: AgentContext, call?: LlmCall | null): Promise<AgentOutput>;
```

### 9.1 프롬프트 인젝션 방어는 이 계층의 책임이다

- 사용자 발화는 **명령이 아니라 관측 데이터로 감싸** 전달한다. 프롬프트에 그대로 이어붙이지 않는다.
- 정체·지침을 캐묻는 요청에는 **페르소나 안에서 반응만** 한다. 시스템 프롬프트를 그대로 뱉거나 "저는 AI입니다"라고 답하지 않는다.
- 운영 지시(페이즈 전환 등)와 플레이어 발화는 **분리된 채널로** 넣는다.

### 9.2 공급자에 의존하는 것 / 하지 않는 것

| 공급자와 무관 (여기 고정) | 공급자마다 다름 (어댑터에 격리) |
|---|---|
| `AgentContext` / `AgentOutput` 모양 | SDK, 모델 ID, 인증 방식 |
| 8초 타임아웃, 폴백 풀, 병렬 호출 (§12.3) | 타임아웃·재시도 설정 방법 |
| `agent_logs` 기록 항목 | 토큰 사용량 필드 이름 |
| 인젝션 방어 원칙 (9.1) | 구조화 출력 구현 방식 |

**공급자에 의존하는 코드는 `app/api/agent/route.ts` 한 파일에만 둔다.** SDK 초기화, 모델 ID, 요청·응답 모양 변환이 전부 여기다. `lib/agent/generate.ts`는 `AgentContext`를 프롬프트로 빚고 응답을 `AgentOutput`으로 파싱하는 **공급자 무관 층**이며, 실제 호출은 route가 넘겨준 함수로 한다(타입은 `lib/game/types.ts`의 `LlmCall`). 공급자를 바꿀 때 `generate.ts`를 열게 된다면 격리에 실패한 것이다.

공급자는 **NVIDIA NIM으로 확정했다** (§15-1-결정). OpenAI 호환 REST라 SDK 없이 fetch로 부르고, 런타임은 edge다.

---

## 10. 코딩 컨벤션

- 파일명 kebab-case, 컴포넌트 PascalCase
- 서버 전용 코드에 `'use client'` 금지. Canvas는 `dynamic(..., { ssr: false })`
- 시각은 전부 ISO 문자열로 주고받고, 비교는 서버 시각 기준
- 타입은 `lib/game/types.ts`에서만 정의 (I8)
- 커밋은 각자 계정으로. 한 사람 기기에서 몰아 커밋하지 않는다 (역할 기술서 근거)
- 구현 전인 함수는 시그니처를 남기고 `throw new Error('...: 미구현')`. 인자는 `_` 접두사를 붙인다

---

## 11. 기술 선택 확정

"유행하는 것"이 아니라 **3인 2주라는 조건에서 장애가 덜 나는 것**을 기준으로 골랐다.

| 영역 | 선택 | 이유 |
|---|---|---|
| 프레임워크 | Next.js 15 App Router | Vercel · Supabase 양쪽 공식 예제가 전부 이 조합 |
| 언어 | TypeScript strict | 타입이 세 사람의 계약서 역할을 한다 |
| DB 접근 | Supabase JS v2 (PostgREST) | 서버리스에서 커넥션을 직접 잡지 않는다 (§12.2 주의) |
| 방 상태 동기화 | Realtime Postgres Changes (`rooms`) | 초당 수 건. 변경이 드물어 안전 |
| 채팅·답변 동기화 | Realtime Broadcast | 고빈도 구간이자, RLS 배달 평가를 피해야 한다 (§6.1) |
| 페이즈 전환 | Edge Function + `phase_seq` 낙관적 잠금 | 중복 호출이 구조적으로 무력화됨 |
| 전환 안전망 | pg_cron 정기 sweep | 클라이언트가 전부 죽어도 방이 안 멈춘다 |
| LLM 프록시 | Next.js Route Handler | 런타임은 §15-1에서 확정 |
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

**여러 방이 동시에 돌면 이 함수가 병목이 된다.** 반드시 §16.2의 세 가지(잠긴 방 건너뛰기, 방별 예외 격리, 중복 실행 방지)를 함께 넣는다. 안 넣으면 방 하나가 느려질 때 나머지 방이 전부 같이 멈춘다 — 안전망이 오히려 단일 장애점이 된다.

**3번이 없으면 심사 중에 게임이 멈춘다.** 이건 선택이 아니라 필수다.

### 12.2 서버리스 커넥션 고갈

**증상.** 동시 요청이 몰리면 `remaining connection slots are reserved` 에러.

**적용 범위 주의.** `supabase-js`는 PostgREST(HTTP)로 붙으므로 Postgres 커넥션을 직접 잡지 않는다. **이 항목은 Edge Function이나 스크립트에서 `pg`·`postgres.js` 같은 드라이버를 직접 쓸 때만 해당한다.**

**대응.** 드라이버로 직접 접속할 때는 **Supavisor 트랜잭션 모드 풀러**(포트 6543)를 쓴다. 직결 포트(5432)는 마이그레이션 전용이다. 어느 경우든 클라이언트를 요청마다 새로 만들지 말고 **모듈 스코프에서 재사용**한다.

### 12.3 LLM 호출이 게임을 세운다

**증상.** 봇 답변 생성이 8초 걸리면 페이즈 전환이 8초 늦어진다. API가 죽으면 게임이 영원히 멈춘다.

**대응 네 가지 — 공급자와 무관하게 전부 적용한다.**

- **선생성.** 다음 페이즈에 쓸 봇 답변을 **현재 페이즈가 진행되는 동안** 미리 만들어둔다. chat 120초가 곧 다음 준비 시간이다
- **병렬.** 봇 4명을 `Promise.allSettled`로 동시 호출. 순차 호출은 4배 느리다
- **타임아웃.** 8초 컷. 초과하면 폐기한다. **재시도가 켜져 있으면 실제 대기가 8초 × (재시도+1)이 된다** — SDK 기본 재시도 설정을 반드시 확인하고 0 또는 1로 낮춘다
- **폴백.** 실패한 봇은 미리 준비한 무해한 응답 풀에서 하나 꺼내 쓴다 ("ㅇㅇ", "아 잠깐만", "나도 몰루"). **LLM 실패가 게임 진행을 막아서는 안 된다**

### 12.4 Realtime 부하

**증상.** Postgres Changes는 변경 한 건마다 구독자별로 RLS를 평가한다. 채팅이 활발한 구간에서 지연이 눈에 띈다.

**대응.** §6에 확정. 채팅·답변은 Broadcast, `rooms`만 Postgres Changes. **방 상태는 정확성이, 채팅은 속도가 중요하다.**

### 12.5 시계 어긋남

**증상.** 클라이언트 시계가 3초 빠르면 그 사람만 먼저 화면이 넘어간다.

**대응.** 접속 시 서버 시각을 한 번 받아 오프셋을 계산하고, 모든 카운트다운과 `visible_at` 비교를 `serverNow() = Date.now() + offset`으로 한다. 판정은 어차피 서버가 하므로 클라이언트 카운트다운은 표시용이다 (I2).

**어긋나는 시계는 둘이 아니라 셋이다.** 브라우저 · 앱 서버(Vercel) · DB. 그런데 `phase_ends_at`도 `visible_at`도 전부 **DB가 찍는다.** 그래서 `/api/time`은 앱 서버의 `new Date()`가 아니라 **DB의 `now()`를 돌려줘야 한다** (`server_now()` RPC). 앱 서버 시각을 주면 클라이언트는 엉뚱한 시계에 맞춰놓고 DB가 찍은 시각과 비교하게 된다.

**실제로 밟았다.** 개발 기계에서 DB가 앱 서버보다 2.26초 앞서 있었고, 모든 카운트다운이 그만큼 밀려 있었다. 사람 메시지의 `visible_at`을 Route Handler에서 만들었더니 `created_at`보다 과거로 찍히기도 했다.

**규칙: 시각을 만드는 일은 전부 DB에서 한다.** Route Handler에서 `new Date()`로 DB에 넣을 시각을 만들지 않는다. 필요하면 SQL 함수를 하나 더 만든다.

### 12.6 비용 폭주

**증상.** chat 페이즈에서 사람이 도배하면 봇 응답이 그만큼 생성된다.

**대응.** 봇당 쿨다운 8초, 한 메시지에 반응하는 봇은 최대 1명, **방당 총 호출 상한.** 상한 도달 시 폴백 풀로 전환한다. 호출 수와 토큰을 `agent_logs`에 남겨 기술 문서 근거로 쓴다.

**상한 숫자는 LLM을 붙이는 시점에 계산해서 정한다.** 원래 적혀 있던 40회는 chat 한 판을 못 버틴다 — 봇 4명 × (120초 ÷ 쿨다운 8초) = 최대 60회에, 다른 페이즈 선생성 12~13회가 더 붙는다. 상한을 올리든 쿨다운을 늘리든 **둘을 같이 맞춘다.** 지금은 AI를 쓰지 않으므로(§17) 이 항목 전체가 놀고 있다.

**기록할 자리도 그때 만든다.** 지금 `agent_logs`에는 호출 시각도 토큰 수도 폴백 여부도 넣을 컬럼이 없고, `AgentAction`에 `'fallback'`이 없다. §4에 `created_at`·`tokens`·`fallback`을 더한다.

**방당 상한만으로는 부족하다.** API rate limit은 방이 아니라 **계정 전체**에 걸린다. 방 10개가 동시에 chat이면 봇 40명이 한꺼번에 호출해 전부 429를 맞고, 모든 방이 같이 폴백으로 떨어진다. 전역 동시 호출 상한이 함께 필요하다 — §16.5.

### 12.7 우선순위

전부 하려 하지 말고 이 순서로 넣는다.

| 순위 | 항목 | 시점 |
|---|---|---|
| 1 | pg_cron 안전망 (12.1) | 상태머신 직후 |
| 2 | LLM 타임아웃 + 폴백 (12.3) | LLM 연동과 동시 |
| 3 | 시계 오프셋 (12.5) | 타이머 붙일 때 |
| 4 | Broadcast (12.4) | 채팅 구현과 동시 (§6.1 때문에 선택이 아니다) |
| 5 | 호출 상한 (12.6) | 플레이테스트 전 |
| 6 | Supavisor 풀러 (12.2) | 드라이버를 직접 쓰게 되면 |

**1번과 2번은 없으면 데모가 멈춘다.**

---

## 13. 구현 순서와 완료 조건

각 단계는 **완료 조건을 눈으로 확인한 뒤** 다음으로 넘어간다. "코드를 다 썼다"는 완료가 아니다.

| # | 단계 | 완료 조건 (이걸 직접 해본다) |
|---|---|---|
| 1 | 방 생성 · 입장 | 브라우저 두 개에서 같은 코드로 들어가면 서로의 닉네임과 seat이 보인다. **정원 3인 방과 8인 방을 각각 만들어** 좌석 칸이 그 수만큼 그려지고, 정원이 찬 방에 더 들어가려 하면 거절된다 (§17.6) |
| 2 | 페이즈 상태머신 | 탭 5개에서 **동시에** `advance_phase`를 불러도 `phase_seq`가 정확히 1만 증가한다 |
| 3 | pg_cron 안전망 | **모든 탭을 닫고** 90초 뒤 방을 조회하면 페이즈가 넘어가 있다 |
| 4 | 질문 · 답변 | 제출 전에는 남의 답이 안 보이고, 페이즈가 넘어가면 보인다 |
| 5 | 봇 답변 | **LLM 키를 일부러 틀리게 넣어도** 게임이 끝까지 진행된다 (폴백 풀로 대체) |
| 6 | 자유 채팅 + 봇 반응 | 사람이 10초에 5번 도배해도 봇 응답이 쿨다운을 지킨다. `agent_logs`에 호출 수가 남는다 |
| 7 | 투표 · 공개 | reveal 이전에 anon 키로 `votes`를 조회하면 0행. reveal 이후에만 보인다 |
| 8 | RLS 침투 테스트 | §14.2의 여섯 쿼리가 전부 0행 또는 에러 |
| 9 | **다중 방** | §14.4를 통과한다. 방 두 개를 나란히 띄우고 한쪽을 진행시켜도 다른 쪽 화면이 꿈쩍 안 한다 |
| 10 | 3D 도입 | 위 9단계가 전부 끝난 뒤에만 시작한다 |

**9번은 마지막에 몰아서 하지 않는다.** §16의 계약(구독 필터, 채널 이름)은 2·6번을 짤 때 **처음부터** 지켜야 한다. 나중에 필터를 끼워 넣는 건 구독 코드를 다시 쓰는 일이다.

---

## 14. 검증

### 14.1 코드

작업을 끝내기 전에 항상 돌린다.

```bash
npx tsc --noEmit    # 타입
npm run lint
npm test            # 순수 함수 · 화면 조각 (vitest). tests/ 아래에 소스 구조 그대로 둔다
npm run build       # 최종. 이게 통과해야 끝난 것
```

`npm test`가 맡는 것은 **DB를 모르는 것들**이다 — 전환표·지속시간·조기종료표(§5.1, §5.3),
임시 채점 규칙, 좌석 그리드의 정원 처리(§17.6). DB 동작을 목으로 흉내 내면 로컬만
초록불이 되므로 그쪽은 아래 `test.sh`가 진짜 Postgres에 물어본다.

**DB 쪽은 `./supabase/test.sh`가 돌린다.** 일회용 로컬 Postgres를 띄워 `supabase/`의 SQL을 전부 올리고 아래 §14.2 · §14.3 · §14.4를 검사한 뒤 지운다. Supabase 프로젝트도 인터넷도 필요 없다. 스키마나 전환 함수를 고쳤으면 이걸로 끝낸다.

### 14.2 RLS 침투 (anon 키로 실행)

**전부 0행 또는 에러여야 한다.** 하나라도 데이터가 나오면 게임이 깨진 것이다.

```sql
select * from player_roles;                     -- 역할 노출
select is_bot from players;                     -- 봇 노출 (I1)
select * from players;                          -- 테이블 직접 접근
select * from answers where visible_at > now(); -- 미공개 답변
select * from votes;                            -- reveal 이전 방에서
select * from agent_logs;                       -- 봇 내부 판단
```

### 14.3 상태머신 동시성

`expected_seq`를 같은 값으로 넣어 `advance_phase`를 5번 동시에 호출하고, `phase_seq` 증가폭이 1인지 확인한다. 2 이상이면 I6이 깨진 것이다.

### 14.4 다중 방 격리

방 두 개(A, B)를 만들고 브라우저 창을 나란히 띄운다.

| 확인 | 통과 기준 |
|---|---|
| **전환 격리** | A방을 vote까지 진행시키는 동안 **B방 화면의 페이즈·타이머가 전혀 변하지 않는다.** 이게 깨지면 I10 위반 |
| **채팅 격리** | A방에 메시지를 보내도 B방 채팅창에 안 뜬다 |
| **워치독 격리** | A방을 일부러 막아둔(전환 중 잠긴) 상태에서, B방이 만료되면 15~30초 안에 전환된다 |
| **코드 충돌** | `rooms`에 코드를 강제로 중복 insert해 보고, `createRoom`이 에러 대신 다른 코드로 재시도하는지 확인 |

브라우저를 여러 개 못 띄우면 시크릿 창이나 다른 브라우저를 쓴다. **같은 창의 탭 두 개로는 안 된다** — 같은 Realtime 연결을 공유해서 격리가 검증되지 않는다.

---

## 15. 미결정 사항

**여기 있는 항목은 추측해서 구현하지 않는다. 사람에게 물어본다.**

| # | 항목 | 결정해야 하는 것 | 막히는 작업 |
|---|---|---|---|
| **15-1** | ~~LLM 공급자~~ **결정: NVIDIA NIM API.** OpenAI 호환 REST라 SDK 없이 fetch로 부르고, Route Handler 런타임은 `edge`로 확정한다. 어댑터는 `app/api/agent/route.ts` 한 파일에만 둔다 (§9.2). 근거는 §15-1-결정 | — |
| **15-2** | ~~익명 인증 도입 여부~~ **결정: 구글 로그인으로 들어온다.** `/login` 을 지나야 게임에 닿는다. 자동 익명 로그인은 걷어냈다. 기존 방 테이블의 RLS는 손대지 않는다. 근거는 §15-2-결정 | — |
| **15-3** | ~~봇을 채우는 시점 · 봇 수 공개~~ **결정: 공개한다.** 봇이 **몇인지**는 화면에 띄운다. 어느 자리인지는 여전히 숨긴다 (I1). 근거는 §15-3-결정 | — |
| **15-4** | ~~이탈 · 재접속 처리~~ **결정: 자리를 그대로 둔다.** 좌석과 역할이 유지되고 돌아오면 이어서 한다. 봇이 이어받지 않는다. 근거는 §18.6 | — |
| **15-5** | ~~replay 페이즈 동작~~ **결정: 같은 방에서 역할만 다시 뽑는다.** 방 코드·참가자는 유지, 역할·연기자 수·봇 자리는 새로. 근거는 §18.6 | — |
| **15-6** | 방 격리를 DB로 강제할지 | 지금은 클라이언트 계약(§6.3)으로만 유지된다. anon 키로 다른 방의 닉네임·좌석·질문·공개 답변·채팅을 읽을 수 있다. 승패 정보(`is_bot`·역할·미공개 답변·reveal 이전 투표)는 이미 막혀 있다. **선행 조건이던 15-2는 끝났다** — 이제 막는 것은 §7.3의 함정뿐이다: `rooms`에 `auth.uid()` 조건을 걸면 Realtime 이벤트가 **에러 없이** 안 배달된다. 조인 테이블을 따로 두고 `advance_expired_rooms` 경로까지 검증해야 한다 | 데모 공개 범위를 정할 때 |

---

### 15-1-결정 — NVIDIA NIM API

**결정: NVIDIA NIM API를 쓴다. 런타임은 edge.** (2026-07-29)

- **OpenAI 호환 REST**(`{base}/chat/completions`)라 SDK가 필요 없다. fetch만 쓰므로 Route Handler는 `edge`로 확정한다. fetch에는 기본 재시도가 없어 §12.3의 "재시도 0"이 공짜로 지켜진다 — 나중에 SDK를 들이게 되면 그 순간 재시도 설정부터 확인한다.
- 키는 `NVIDIA_NIM_API_KEY`, 주소는 `NVIDIA_NIM_BASE_URL`, 모델은 `NVIDIA_NIM_MODEL` (`.env.local.example`). 모델 교체는 환경변수만 바꾸면 된다 — 한국어 반말 채팅 품질은 `/lab`에서 비교해 고른다.
- 공급자 의존 코드는 §9.2대로 `app/api/agent/route.ts` 안에만 있다. `generate`(B)에는 `LlmCall`(`lib/game/types.ts`) 함수만 넘어간다. 공급자를 바꾸면 route 한 파일만 갈아끼운다.
- 선생성 층(§12.3)이 붙기 전까지 이 라우트는 **개발 환경 전용**이다(프로덕션 404). 열어두면 남의 지갑으로 쓰는 LLM 프록시가 된다. 붙일 때 world-room처럼 내부 Bearer 인증으로 바꾼다.

### 15-2-결정 — 구글 로그인으로 들어온다

**결정: 게임에 들어가려면 `/login` 을 지난다. 구글 하나뿐이다.** (2026-08-01, 같은 날 뒤집음)

전적·랭킹·친구 목록을 만들기로 하면서 계정이 필요해졌다.

> **처음에는 반대로 정했다가 뒤집었다.** 원래 결정은 "익명 인증을 자동으로 깔고, 게임이 끝난 뒤에 구글을 잇는다 — 첫 화면에 로그인 벽을 세우지 않는다" 였다. 익명 게임에 로그인 마찰을 넣지 않으려던 것이다.
>
> **뒤집은 이유는 제품 결정이다.** 들어오는 순간 누구인지 알아야 전적·랭킹·친구가 처음부터 성립하고, 대기방에 이름 없는 자리가 섞이지 않는다. 익명으로 시작하면 로그인한 사람과 안 한 사람이 한 방에 섞여서 그 모든 기능이 반쪽이 된다.
>
> 뒤집으면서 **자동 익명 로그인을 걷어냈다.** 남겨두면 방문할 때마다 아무도 안 쓰는 계정이 하나씩 쌓이는데 Supabase 는 그걸 자동으로 지우지 않는다. `linkIdentity`(잇기)도 같이 없앴다 — 이을 익명 계정이 없다.

```
/main · /room/[code]  →  로그인 안 했으면  →  /login?next=<원래 주소>
                                              └ 구글 →  콜백 →  이름 없으면 /account/nickname
```

**게이트는 화면용이다.** `components/require-login.tsx` 는 주소를 직접 치면 잠깐 지나갈 수 있다. 서버 쪽 보증은 그대로다 — 쓰기는 쿠키의 `player_token` 으로 본인을 확인하고(I9, §17.4), 계정이 필요한 라우트는 `requireUser` 가 401 로 끊는다.

**`/intro`·`/world`·`/lab`·`/admin` 은 감싸지 않는다.** 남의 작업 공간이라 게임 계정과 무관하게 돌아야 한다 (CLAUDE.md 작업 보드).

**자체 로그인(이메일+비밀번호)을 쓰지 않는 이유**: 비밀번호 찾기 메일·가입 확인 메일·SMTP 설정·문의 대응이 영구히 따라온다. **제공자를 나중에 더하는 건 쉽고, 비밀번호를 나중에 걷어내는 건 어렵다.** 카카오를 더하려면 Supabase 대시보드에서 켜고 `/login` 에 버튼 하나를 더한다.

#### 이름은 사용자가 짓는다

구글이 준 이름을 그대로 쓰지 않는다. 본명이 대기방에 뜨는 것은 익명 게임에서 고른 적 없는 노출이다. 콜백은 프로필이 없으면 `/account/nickname` 으로 보내고, 구글 이름은 **입력칸의 제안**으로만 채운다.

| | 어디서 정하나 | 바꿀 수 있나 | 유니크 | 어디까지 사나 |
|---|---|---|---|---|
| 계정 이름 (`profiles.display_name`) | 첫 로그인 직후 | **못 바꾼다** | 전체 (대소문자 무시) | 대기방 + 랭킹·친구 |
| 대기방 이름 (`players.lobby_name`) | 대기방 입력칸 | 대기방에 있는 동안 | **그 방 안에서만** | 그 방, 그 판 |

정화 규칙은 방 제목(`normalizeRoomName`)과 같다. 이름 쪽이 더 중요하다 — 유니크가 걸려 있어서 **제로폭 공백 하나로 눈에 같아 보이는 이름을 하나 더 만들 수 있다.**

#### 이름은 한 번만 짓는다

**계정 이름은 처음 구글을 연결할 때 한 번 정하고, 그 뒤로는 못 바꾼다.** (2026-08-01)

이름은 전체 유니크다. 바꾸는 것을 허용하면 두 가지가 따라온다.

- **점유.** 이름을 옮겨 다니면서 좋은 이름을 계속 쥐고 있을 수 있다. 놓은 이름은 아무도 못 쓰게 남기거나, 놓는 순간 남이 채가서 되돌릴 수 없게 된다 — 어느 쪽이든 규칙을 하나 더 만들어야 한다.
- **사람을 못 따라간다.** 랭킹·친구는 **이름으로 사람을 찾는 기능**이다(§15-2-결정 위 표). 어제 이긴 '가가'와 오늘의 '가가'가 다른 사람이면 전적이 누구 것인지 흔들린다. 나중에 붙이면 이미 바뀐 이름들을 어떻게 할지 곤란해진다 — 정원(§17.6)·유니크와 같은 이유로 처음부터 조인다.

자물쇠는 세 겹이고, **아래로 갈수록 진짜다.**

| 어디 | 무엇 | 없으면 |
|---|---|---|
| `app/account/nickname` | 이미 이름이 있으면 화면을 안 그리고 돌려보낸다 | 고쳐 놓고 눌렀을 때 409를 본다 |
| `POST /api/profile` | 이미 있으면 409. `upsert`가 아니라 `insert`다 | 두 번째 요청이 이름을 덮어쓴다 |
| `profiles_name_frozen` 트리거 | `display_name`이 바뀌는 `update`를 거절한다 | **쓰기 경로가 하나 더 생기면 조용히 뚫린다** |

트리거가 필요한 이유는 §15-2-결정의 나머지와 같다 — **쓰기는 전부 service role 서버를 지나고(I9), service role은 RLS를 통과한다.** 정책으로는 못 막는다. `avatar_url`은 얼리지 않는다. 그건 사용자가 고른 값이 아니라 구글이 준 것이라 갱신돼도 된다.

> **바꿀 수 있게 되돌린다면** 트리거부터 걷어낸다. 그때 같이 정할 것: 놓은 이름을 누가 언제 쓸 수 있는지, 랭킹에 쌓인 전적을 옛 이름으로 볼 수 있는지.

#### 지켜야 하는 선

> **계정 세계와 방 세계를 분리한다. 잇는 것은 `players.user_id` 하나뿐이고, 그건 밖으로 안 나간다.**

- **`user_id`는 완벽한 봇 탐지기다 (I1).** 봇에게는 계정이 없다. `public_players` 뷰에 새면 `where user_id is null` 한 줄로 봇 명단 전체가 나온다. `is_bot`·`created_at`·`token`과 같은 급이다. `supabase/checks.sh`가 뷰 컬럼 목록으로 잡는다 — 뷰에 뭘 더하든 그 검사가 먼저 빨간불이 된다.
- **`profiles.display_name`은 랭킹·친구 화면에만 나온다.** 방 안에서는 끝까지 `익명N`이다. 두 이름이 한 화면에서 만나면 그 순간 익명성이 끝난다.
- **계정은 입장 조건이 아니다.** `players.user_id`는 nullable이고, 익명 인증이 실패해도 방에는 들어간다. 게임이 인증에 묶이면 안 된다.

#### 기존 RLS는 한 줄도 안 바꾼다

`auth.uid()`를 쓰는 정책은 **새로 만든 `profiles` 하나뿐**이다. `rooms`·`players`·`answers`·`messages`·`votes`의 정책은 그대로다.

이유는 §7.3이다 — Realtime Postgres Changes는 **배달 시점에** RLS를 평가한다. `rooms`에 `auth.uid()` 조건을 걸면 토큰이 없거나 만료된 순간 이벤트가 **에러 없이 아무에게도 안 간다.** 구독은 `SUBSCRIBED` 그대로고 화면만 멈춘다. 방 격리를 DB로 내리는 것은 여전히 별개 결정이다 (§15-6).

다행히 기존 정책과 grant가 전부 `to anon, authenticated`라 로그인한 사용자로 바뀌어도 읽기가 하나도 안 깨진다. **새 정책에 `authenticated`를 빠뜨리면 로그인한 사람만 화면이 빈다** — 이 대칭이 유지돼야 한다.

#### 세션은 쿠키에 담는다

`getBrowserClient()`는 원래 `persistSession: false`였다(로그인이 없었으므로). `@supabase/ssr`의 쿠키 저장으로 바꾼다. localStorage가 아닌 이유는 **서버도 읽어야 하기 때문**이다 — 입장할 때 `players.user_id`를 찍고, 구글 콜백이 PKCE 검증값을 읽는다. 쿠키면 기존 `lib/api/*`의 fetch가 한 줄도 안 바뀐다.

`player_token`(§17.4)과 헷갈리지 않는다. **둘 다 있어야 하고 역할이 다르다.**

| | 증명하는 것 | 쓰는 곳 |
|---|---|---|
| `player_token` | 이 브라우저가 **그 방 그 자리**에 앉았다 | 방 안의 모든 쓰기 |
| 계정(`user_id`) | 이 **사람**이 누구다 | 전적 · 랭킹 · 친구 |

방 안의 본인 확인을 계정으로 바꾸지 않는다. 바꾸면 로그인이 실패한 사람이 게임을 못 하고, 한 사람이 방 여러 개에 앉는 경우도 표현이 안 된다.

#### 전적을 쌓는다 (`match_results`)

**결정: 한 판이 끝날 때(reveal) 사람 한 명당 한 행을 남긴다.** (2026-08-01)

로비 왼쪽 기둥의 레벨·EXP·승률·판수·최근 게임은 원래 목 데이터였다. 계정이 생겼으므로 진짜 값으로 바꾼다. 랭킹·친구는 여전히 다음 단계이고, 그 둘도 이 표 위에 얹는다.

```
vote → reveal  →  GET /api/reveal (누가 열든 한 번)  →  match_results 에 방 전원치
로비 왼쪽 기둥  ←  GET /api/profile/stats            ←  match_stats() + 최근 5줄
```

| | 값 |
|---|---|
| 한 행 | `(room_id, user_id)` · `role` · `score` · `won` · `humans` · `created_at` |
| 적는 곳 | `/api/reveal` **하나뿐** (service role) |
| 읽는 곳 | `/api/profile/stats` **하나뿐** (쿠키 세션의 내 계정만) |
| 경험치 | 그 판의 점수 그대로. 누적이 곧 EXP |
| 레벨 | L→L+1 에 10×L. 누적 문턱 0·10·30·60·100… (`lib/server/stats.ts`) |

**왜 `advance_phase`가 아니라 reveal에서 적는가.** 점수는 `calcScores`(TS 순수 함수)가 내는데 plpgsql은 그걸 못 부른다. §17.2가 같은 이유로 점수 계산을 reveal 훅으로 뺐고 이것도 그 결정을 탄다. 채점을 SQL로 한 벌 더 쓰면 규칙이 두 군데로 갈린다.

**한 판은 한 번만 적힌다.** 방의 사람 전원이 결과 화면을 열면 `/api/reveal`이 그만큼 불리는데, 기본키 `(room_id, user_id)`가 두 번째부터 무시한다. 거꾸로 **한 사람만 열어도 그 방 사람 전원의 행**이 그때 적힌다. 기록이 실패해도 reveal 응답은 그대로 나간다 — 전적은 곁다리고 결과 화면은 게임의 마지막 장면이다.

**부정 유인을 막는다.** 정원 5인 방을 혼자 만들면 봇이 4명이고, 혼자면 스파이도 안 뽑힌다(§8). 봇만 맞히며 점수를 쌓을 수 있다. 그래서 **사람 2명 이상인 방만 적는다.** 조건은 두 겹이다 — `lib/server/match.ts`가 거르고, `humans >= 2` check가 DB에서 다시 막는다.

**승패는 지어내지 않는다.** 이 게임에는 아직 팀 승패 판정이 없다(「게임 룰 점검 추가분」). 대신 채점 규칙이 이미 말하는 것을 그대로 적는다 — 시민은 진짜 AI를 맞히면 +2, 스파이는 사람 표를 한 장이라도 받으면 +4(§8.1). 즉 **점수가 붙은 판 = 자기 목표를 이룬 판**이고 그게 `won`이다. 계산하지 않고 **저장**하는 이유는 소급 때문이다: 나중에 참가상 같은 걸 붙여 0점이 사라지면, 그때 계산하는 방식은 옛날 판까지 전부 '승'으로 바꿔버린다.

> **★ §18.4가 이 문단의 전제를 둘 다 뒤집었다.** 이제 팀 승패 판정이 **있고**, 개인 점수는 **없다.**
>
> - **`won`은 §18.4의 진영 승패를 그대로 적는다.** 더 이상 점수에서 유추하지 않는다. 위 문단이 걱정한 "없는 판정을 지어내는 것"은 판정이 생기면서 해소됐다.
> - **`score`는 EXP의 원천이라 비울 수 없다.** 점수 규칙을 지우면 위 표의 경험치·레벨이 통째로 멈춘다. 그래서 **승패에서 유도한다 — 이긴 판 +3, 진 판 -1** (2026-08-07 결정). 처음에는 진 판에도 +1이었다(참가 자체를 세려고). 그런데 화면에 "패배"라고 적힌 줄 옆에 +1이 붙어서 **지고도 오르는 것으로** 읽혔다. 이제 지면 깎이고, 레벨은 판수가 아니라 이긴 판을 센다. 누적이 음수로 내려가도 레벨은 1에서 멈춘다(`levelFromExp`).
> - **숫자(+3·-1)는 게임 규칙이 아니라 전적 쪽 값이다.** §18은 승패까지만 정했다. 이 둘을 바꾸는 건 레벨 곡선을 바꾸는 일이고 §18을 건드리지 않는다.
> - **저장하는 이유는 그대로다.** 소급 때문이다. 계산식을 나중에 바꿔도 옛날 판의 EXP는 그때 값으로 남는다.
> - `role` 컬럼에는 `'actor'`가 들어간다 (§18.2). 예전 판에 남은 `'spy'` 행은 그대로 두고 읽는 쪽에서 같이 취급한다 — 지난 전적을 고쳐 쓰면 그게 곧 소급이다.

**`room_id`에 외래키를 걸지 않는다.** §16.4가 "24시간 지난 방을 지운다"고 정해 뒀다. cascade를 달면 전적이 하루 만에 같이 사라지고, **화면은 그날 하루 멀쩡하게 돈다.** uuid라 지워진 방의 코드가 재사용돼도 값이 겹치지 않는다. `supabase/checks.sh`가 "외래키가 없다"를 검사한다.

**여기가 새면 I1이 깨진다.** 한 행에 `room_id`와 `role`이 같이 있어서, 남의 행을 읽을 수 있으면 "그 방에서 누가 스파이였나"가 나온다. 게다가 **한 방의 행 수를 세면 사람이 몇이었는지**가 나오고 정원에서 빼면 봇 수가 나온다. 그래서 `profiles`와 같은 모양으로 조인다.

- `anon`에게는 권한 자체가 없다. `authenticated`는 `auth.uid() = user_id` 행만
- 쓰기는 아무에게도 열지 않는다 (I9). 열어두면 자기 전적을 직접 적어 랭킹을 만든다
- 집계 함수 `match_stats(uuid)`도 `public`까지 revoke 한다 — **`public`을 빼먹으면 Postgres가 새 함수의 EXECUTE를 PUBLIC에 기본으로 주므로 revoke가 아무 일도 안 한다.** 실제로 여기서 한 번 걸렸다
- Realtime publication에 넣지 않는다 (§7.3)

#### 아직 안 한 것

**랭킹·친구**는 이 표 위에 얹는 다음 단계다. 랭킹 화면은 집계 뷰(leaderboard)로 따로 연다 — 거기에는 `room_id`도 `user_id`도 없어야 계정과 방이 이어지지 않는다.

#### 운영에서 해야 하는 것

- Supabase 대시보드 → Auth → Providers → **Google** 켜기 (클라이언트 ID·시크릿)
- Auth → URL Configuration → Redirect URLs 에 `/api/auth/callback` (로컬·배포 각각)
- Google Cloud Console → 동의 화면을 **게시(프로덕션)** 해야 아무나 로그인할 수 있다. '테스트 중'이면 등록한 테스트 사용자만 들어온다
- ~~Anonymous sign-ins~~ · ~~Manual linking~~ 은 이제 필요 없다. 켜 둬도 해는 없다
- Google Cloud Console → OAuth 클라이언트의 승인된 리디렉션 URI는 **Supabase 주소**(`https://<프로젝트>.supabase.co/auth/v1/callback`)다. 우리 앱 주소가 아니다.
- **환경변수는 늘지 않는다.** 구글 시크릿은 대시보드에만 있고 우리 코드는 보지 않는다.
- 자동 익명 로그인을 걷어내기 전에 만들어진 익명 계정이 남아 있다. 한 번 정리하면 된다.

### 15-3-결정 — 봇 수를 공개한다

**결정: 봇이 몇인지는 공개한다. 어느 자리인지는 끝까지 숨긴다.**

숨기는 쪽이 지켜지지 않기 때문이다.

봇은 방장이 "시작"을 누르는 순간 채워진다(§17.4). 그런데 대기실은 `roster_seq` 신호로
실시간 갱신되므로(§17.3), **방에 있던 사람은 시작 직전에 몇 자리가 비어 있었는지 이미 눈으로
봤다.** 좌석 그리드의 빈칸이 곧 답이다. 즉 수를 감추는 것은 보호가 아니라 연기였고,
그 연기를 위해 화면 문구와 코드 주석 수십 군데가 묶여 있었다.

**지키지 못할 것을 지키는 척하는 편이 더 위험하다.** 규칙이 반쪽만 지켜지면 어디까지가
진짜 방어선인지 아무도 모르게 되고, 그러면 진짜 방어선(어느 자리인지)도 같이 흐려진다.

마피아·어몽어스가 인원을 공지하고도 성립하는 것과 같은 이유로 게임도 안 깨진다.
다만 **이 게임에는 "0명일 수도 있다"가 있다** — 사람이 정원을 다 채우면 봇이 없다.
그 가능성이 남아 있어야 긴장이 유지되므로, 문구는 "N대"를 말하되 **0을 자연스럽게 포함**해야 한다.

**여전히 금지인 것 (I1):**

- `is_bot`을 행 단위로 내려보내는 것 — `public_players` 뷰는 그대로다
- `created_at`·`token` 등 **어느 자리인지 역산되는 값** (§7.2)
- 봇만 갖는 타이밍 특성(즉시 답변·즉시 투표)이 자리 단위로 드러나는 것 (§5.3)

**허용되는 것:** 그 방의 봇 **총 수**. 자리와 묶이지 않은 집계다.

**남은 것:** 봇을 채우는 **시점**은 여전히 시작 버튼이다. 로비에서 채우는 안은
"사람이 오면 봇이 자리를 비켜야 한다"는 문제가 있어 열어둔다.

**2026-08-08: AI 도 좌석 순열 안에 있어야 한다.** 시작할 때 자리를 다시 섞는 규칙(위
"봇 자리는 섞는다", §17.4)이 **월드판에서 사람에게만 걸려 있었다.** 월드 AI 는 `players`
행이 없어서(`docs/MULTIPLAYER.md`) 셔플이 지나쳐 버리고, 그 뒤 명단을 만들 때 `max(자리)+1`
에 세워졌다 — 즉 **AI 는 언제나 방에서 제일 큰 번호**였다. 대기실을 안 봤어도, 아무 정보가
없어도, 제일 큰 번호만 찍으면 맞는 판이다. 위에서 "허용"한 것은 봇의 **총 수**이지 자리가
아니므로 이건 I1 위반이다.

이제 월드 시작은 `start_world_seats` 가 사람 + AI 를 **1..N+1 로 한 순열에** 다시 배정한다
(사람 셋이면 익명1~4, 그 중 한 칸이 AI). 뽑은 번호는 `world_ai_seats` 에 적는다 — 명단을
만드는 함수가 상태 없이 매번 다시 계산하는 구조라, 적어두지 않으면 사람이 하나 나갈 때마다
판 도중에 전원의 번호가 갈아엎어진다. **그 테이블은 anon 에게 열지 않는다**(정답 그 자체다).
`rooms` 컬럼으로 두지 않은 이유가 이것이다 — `rooms` 는 anon 이 통째로 읽는다.

---

## 16. 다중 방 — 여러 방이 동시에 돌아갈 때

방 하나를 잘 만드는 것과 방 여러 개가 서로 간섭하지 않는 것은 별개다. 데이터 모델은 이미 방 단위로 갈라져 있다 — 모든 테이블에 `room_id`와 `on delete cascade`가 있고, `phase_seq`는 **방 행마다** 따로다. A방 전환이 B방 데이터를 건드릴 방법은 없다.

문제는 그 바깥에서 생긴다. 아래 다섯 가지다.

### 16.1 구독 격리 — 가장 먼저 깨진다

§6.3이 계약이다. **모든 구독과 쿼리에 방 필터를 건다 (I10).**

필터를 빠뜨리면 B방이 vote로 넘어갈 때 A방 사람 화면도 같이 넘어간다. 방이 두 개만 돼도 재현되고, 증상이 "가끔 화면이 멋대로 넘어감"이라 원인을 찾기 어렵다. **구독 코드를 처음 쓸 때 지킨다.** 나중에 끼워 넣으면 다시 쓰게 된다.

### 16.2 워치독이 방을 줄 세우지 않게 한다

`advance_expired_rooms()`는 만료된 방을 전부 훑는다. 순진하게 짜면 **안전망이 단일 장애점이 된다.** 세 가지를 함께 넣는다.

| 넣을 것 | 안 넣으면 |
|---|---|
| `for update skip locked` | 클라이언트가 이미 전환 중인 방에서 잠금을 기다리다 뒤쪽 방이 전부 밀린다 |
| 방마다 `begin ... exception` 격리 | 방 하나에서 예외가 나면 그 실행분 전체가 롤백돼 **아무 방도 전환되지 않는다** |
| `pg_try_advisory_lock`으로 중복 실행 방지 | 한 번 실행이 15초를 넘기면 다음 cron이 겹쳐 돌며 서로를 더 느리게 만든다 |

한 번에 처리할 방 수에 상한을 두고(예: 50개), 남은 건 다음 주기에 맡긴다. 15초마다 도니 밀려도 금방 따라잡는다.

### 16.3 인덱스

워치독은 `phase_ends_at < now()`로 **전체 방**을 스캔한다. 방이 쌓이면 15초마다 풀스캔이 돈다.

```sql
create index on rooms (phase_ends_at) where phase_ends_at is not null;
```

`questions`와 `agent_logs`에도 `room_id` 인덱스가 필요하다 (§4에 반영).

### 16.4 방 코드와 수명

- **코드 충돌 재시도.** 4자 × 24글자 = 331,776가지. `code` unique 제약에 걸리면 `createRoom`이 에러를 던지지 말고 **다른 코드로 재시도**한다 (최대 5회).
- **끝난 방 정리.** 지금은 방이 영원히 남는다. 코드를 계속 점유하고 워치독 스캔 대상으로도 남는다. `created_at`이 24시간 지난 방을 매시 정각에 지운다. cascade가 딸린 데이터를 함께 정리한다. **`phase = 'replay'`는 아직 조건에 넣지 않는다** — replay가 같은 방 재시작인지 새 방인지 미결정이라(§15-5), 지금 지우면 재시작이 깨진다. 정해지면 조건을 더한다.
- **코드 재사용 주의.** 방을 지우면 코드가 다시 쓰일 수 있다. 그래서 Realtime 채널 이름은 `code`가 아니라 `room_id`를 쓴다 (§6.3).

### 16.5 LLM 전역 상한

§12.6의 "방당 40회"는 방이 하나일 때 얘기다. **rate limit은 계정 전체에 걸린다.**

- **전역 동시 호출 상한**을 둔다 (예: 8). 초과분은 대기시키지 않고 **즉시 폴백 풀로 보낸다.** 대기시키면 §12.3의 8초 예산이 무너진다
- 봇 답변 선생성(§12.3)이 이 상한을 지키게 한다 — 방 10개가 같은 초에 question으로 들어가면 40건이 한꺼번에 몰린다
- 폴백으로 떨어진 횟수를 `agent_logs`에 남긴다. 이게 "방 몇 개까지 버티는가"의 근거가 된다

### 16.6 그 밖의 한도

Supabase 무료 티어는 Realtime 동시 접속에 한도가 있다. **정원 상한인 8인** × 방 N개로 계산해서 데모 전에 확인한다. 넘으면 방 수를 제한하거나 유료로 올린다. **데모 당일에 알게 되면 늦다.**

---

## 17. 목 우선 — AI 없이 먼저 완주시킨다

### 17.1 왜 이 순서인가

**§13-5의 완료 조건이 이미 이 경로다.** "LLM 키를 일부러 틀리게 넣어도 게임이 끝까지 진행된다(폴백 풀로 대체)". 즉 AI 없이 도는 경로는 **어차피 만들어야 하는 것**이고, §12.3이 말하는 폴백이 바로 그것이다.

그렇다면 그걸 먼저 만든다. 순서를 뒤집으면 두 가지가 공짜로 따라온다.

- **§13-5가 구현하는 순간 통과된다.** 나중에 증명할 게 아니라 처음부터 그 상태다
- **LLM 미결정(§15-1)이 아무것도 막지 않는다.** 공급자는 게임이 다 돌아간 뒤에 고른다

**나중에 AI를 얹을 때 이 코드는 지우지 않는다.** 안전망으로 그대로 남는다 (§17.5).

### 17.2 결정 A — 페이즈 진입 훅은 전환 함수 안에서 끝낸다

§5.3의 훅을 누가 실행하는가. 원래 설계는 이 자리가 비어 있었다 — plpgsql은 TS 함수도 외부 API도 부르지 못하는데 훅에는 둘 다 들어 있었다.

AI를 빼면 남는 일이 전부 SQL로 된다.

| 훅 | 지금 (문구 풀) | 실행 주체 |
|---|---|---|
| 질문 뽑기 | `question_pool`에서 1개 select | 전환 함수 (plpgsql) |
| 봇 답변 | `bot_line_pool`에서 **질문에 맞는 문구를 겹치지 않게** 뽑아 insert, `visible_at`에 지연 시각 | 전환 함수 (plpgsql) |
| 봇 투표 | 자기 아닌 플레이어 중 하나 | 전환 함수 (plpgsql) |
| 점수 | **DB 밖.** reveal 화면이 `/api/reveal`을 부를 때 `calcScores` 실행 | Route Handler |

**점수만 밖으로 뺀다.** `calcScores`는 `lib/game/rules.ts`의 TS 순수 함수라 DB가 못 부른다. reveal은 조회 시점에 계산해도 아무 문제가 없다 — 투표는 이미 확정돼 있고, 같은 입력이면 같은 결과다 (I3 덕분이다).

**§4에 테이블 두 개가 추가된다.** `question_pool(kind, text)`, `bot_line_pool(phase, question_text, text)`. 내용은 B가 채운다 — `lib/game/questions.ts`와 봇 문구가 원본이고, seed 스크립트가 DB로 넣는다.

**봇 문구는 질문에 묶인다.** `bot_line_pool.question_text`가 `question_pool.text`와 글자 그대로 같아야 짝이 맞는다. `null`이면 질문을 가리지 않는 일반 문구이고, 특화 문구가 봇 수보다 모자랄 때 뒤를 채운다.

처음에는 `phase`만 보고 뽑았다. 그래서 **'지금 휴대폰 배터리 몇 퍼센트야?'에 '어제랑 비슷했던 것 같아'가 나왔다.** 사람은 숫자를 대는데 봇만 딴소리를 하니 첫 질문 한 번으로 봇이 전부 갈렸다 (I1). 문구의 품질이 아니라 **짝맞춤**의 문제다 — 회피성 문구를 더 그럴듯하게 써도 "질문에 안 맞는 답 = 봇"이라는 규칙은 그대로 남는다.

**그리고 봇끼리 같은 말을 하면 안 된다.** 봇마다 따로 뽑으면 겹친다 — 문구 15개에 봇 6명이면 약 68%, 투표 이유 8개에 봇 6명이면 약 92% 확률로 두 봇이 토씨 하나 안 틀리고 같은 말을 했다. 그것만으로 둘 다 봇이다 (I1). 그래서 봇과 문구에 각각 번호를 매겨 1:1로 붙인다.

**모자라면 조용히 넘어가지 않고 예외를 던진다.** 문구가 봇 수보다 적으면 답이 빈 봇이 생기는데, **빈칸은 사람만 만들 수 있으므로 그 자리가 그대로 드러난다** (§5.3). 조용히 새느니 전환이 실패하는 편이 낫다. 질문마다 쓸 수 있는 문구가 봇 최대치(정원 상한 8 − 시작 최소 인원 2 = 6) 이상인지는 `supabase/checks.sh`가 매번 검사한다.

**pg_net도 Edge Function 호출도 쓰지 않는다.** 전환이 SQL 한 트랜잭션 안에서 끝나므로 워치독(§12.1)이 넘긴 방에서도 봇이 똑같이 말한다. 클라이언트가 전부 죽어도 게임이 완주한다.

### 17.3 결정 B — 참가자 목록은 `rooms.roster_seq` 신호로 갱신한다

§6에 근거를 적었다. 요약하면 **뷰는 Postgres Changes로 구독할 수 없고, 테이블은 구독하면 안 된다.**

```
players insert/update
  └ 트리거 → update rooms set roster_seq = roster_seq + 1

클라이언트 (이미 걸어둔 rooms 구독 하나)
  └ roster_seq 변화 감지 → select * from public_players where room_id = <room_id>
```

`rooms`에 `roster_seq int not null default 0`을 더한다. 새 채널도, 새 RLS 정책도, 새 구독도 없다. 방 필터(I10)는 `rooms` 구독에 이미 걸려 있다.

**`phase_seq`와 헷갈리지 않는다.** `phase_seq`는 페이즈 전환의 잠금 키이고, `roster_seq`는 "명단 다시 읽어라"는 신호일 뿐이다. 잠금에 쓰지 않는다.

### 17.4 결정 C — 입장할 때 `player_token`을 발급한다

§7.1에 근거를 적었다. `player_id`는 누구나 읽으므로 그것만으로는 본인 확인이 안 된다.

```
POST /api/room/join
  └ token = 랜덤 32바이트
     insert players (..., token)
     Set-Cookie: hp_<room_id>=<token>; HttpOnly; SameSite=Lax; Secure

모든 쓰기 라우트 (답변 · 투표 · 메시지 · 페이즈 전환)
  └ requirePlayer(req, roomId)
       쿠키의 토큰으로 players를 조회해 player_id를 되찾는다. 없으면 401
```

- **`players.token`은 `public_players` 뷰에 넣지 않는다.** `is_bot`·`created_at`과 같은 취급이다 (§7.2)
- **방마다 쿠키를 따로 둔다.** 한 사람이 여러 방에 들어갈 수 있고, 코드 재사용(§16.4) 때문에 방 이름이 아니라 `room_id`로 키를 만든다
- **이게 익명 인증(§15-2)을 대신하지는 않는다.** 토큰은 "이 브라우저가 그때 그 자리에 앉았다"만 증명한다. RLS로 방을 가르는 건 여전히 §15-2가 필요하다 (§7.3)

**같이 정한 것: 봇 자리는 섞는다.** 빈 seat을 순서대로 채우면 봇이 늘 뒷자리·뒷번호에 몰려서 seat만 보고 봇을 고를 수 있다. `fillWithBots`는 사람과 봇의 seat·nickname을 **섞어서** 배정한다. §15-3에 남은 건 "언제 채우는가"뿐이다.

### 17.5 AI를 얹을 때 바뀌는 것

여기 적힌 것만 바뀐다. 나머지는 그대로 둔다.

| 대상 | 무엇이 바뀌나 |
|---|---|
| `app/api/agent/route.ts` | ~~공급자 SDK 연결~~ **완료 — NIM 어댑터** (§15-1-결정). 남은 것은 선생성 층과의 연결 |
| `lib/agent/generate.ts` | `AgentContext` → 프롬프트, 응답 → `AgentOutput` |
| 선생성 층 | 현재 페이즈가 도는 동안 다음 페이즈 봇 답변을 미리 insert (§12.3) |
| 전환 함수 (plpgsql) | **한 줄만 바뀐다** — "이미 준비된 답변이 있으면 건드리지 않는다" |
| `agent_logs` | `created_at` · `tokens` · `fallback` 컬럼 추가 (§12.6) |
| §12.6 · §16.5 | 호출 상한과 전역 동시 상한을 숫자로 확정 |

**문구 풀은 지우지 않는다.** LLM이 죽거나, 8초를 넘기거나, 상한에 걸리면 이 풀로 떨어진다. 그게 §12.3의 폴백이고 §13-5의 완료 조건이다.

### 17.6 방 정원을 방마다 정한다

정원이 5로 하드코딩돼 있었다. **방을 만들 때 3~8 중에서 고르는 값으로 바꿨다.** 기본값은 5다.

> **★ §18.1에서 상한이 10으로 올라갔고 6이 빠졌다.** 고를 수 있는 값은 **3·4·5·7·8·9·10**(기본 5)이다. 6을 뺀 이유는 그 방이 총 자리 5짜리와 같은 판이 되기 때문이다. **뜻은 '총 자리의 상한' 그대로**이고, 실제 총 자리(`seat_count`, 3~10)와 AI 수는 시작 시점의 사람 수로 인원표를 읽어 정한다. 아래 "빈자리를 봇이 채운다"는 전제는 §18.1로 대체됐다 — 다만 **수를 한 자리에 모아둔 성과는 그대로 쓴다.** 모을 자리가 하나에서 둘로 늘었을 뿐이다.
>
> **아래 "봇 수 상한은 6"도 바뀐다.** 정원 8에서 최소 인원 2를 뺀 값이 아니라 인원표가 정하고, **AI는 최대 2대다.** 봇 문구 풀의 하한이 6에서 2로 내려간다 — 하한이지 목표가 아니므로 풀을 줄일 이유는 없다. 오히려 §17.2의 "봇끼리 겹치지 않게 배정"이 훨씬 쉬워졌다.

| 자리 | 값 |
|---|---|
| `rooms.capacity` | `int not null default 5 check (capacity between 3 and 8)` |
| `players.seat` | `check (seat between 1 and 8)` — 상한만 넓힌다. 방별 상한은 `room_capacity()`가 본다 |
| `default_room_capacity()` | 5 |
| `room_capacity(p_room_id uuid)` | 그 방의 정원 |
| `POST /api/room` | body `{ capacity?: number }`. 없으면 기본값 |

**하한이 3인 이유.** §8이 "사람이 2명 이상이면 그중 1명만 `spy`"라고 정한다. 정원 2인 방은 사람 1 + 봇 1이 되어 **스파이가 생기지 않는다.** 시민 한 명이 봇 한 명을 지목하는 판은 게임이 아니다. 3이어야 사람 2명이 들어올 여지가 생기고, 그때부터 스파이가 배정된다.

**여지만으로는 부족하다 — 사람 2명을 실제로 강제한다.** 정원을 3으로 열어둬도 방장이 혼자 시작 버튼을 누를 수 있었다. 그러면 스파이가 배정되지 않고 남은 자리가 전부 봇이라 **아무나 찍어도 정답**이다. 게임의 절반(스파이)과 나머지 절반(추리)이 같이 죽는다. 그래서 시작에 사람 2명을 요구한다 — `/api/room/start`가 봇을 채우기 **전에** 한 번(`MIN_HUMANS_TO_START`), `advance_phase`의 lobby 분기가 한 번 더 본다. 두 겹인 이유는 라우트를 거치지 않는 경로를 막기 위해서다.

**상한이 8인 이유는 화면이다.** 좌석 그리드가 8칸 기준으로 그려져 있다. **기술적 한계가 아니다** — 상태머신도 `assignRoles`도(§8) 인원수를 모른다. 화면을 다시 그리면 올릴 수 있다. 올릴 때는 `players.seat` 제약과 `capacity` 제약을 같이 고친다.

**정원이 커질수록 채점이 운에 가까워졌다 — 이건 §8.1에서 고쳤다.** 정원 8인 방에 사람이 2명이면 표 8장 중 6장이 봇의 무작위 표였다. 지금은 **사람 표만 세므로** 정원을 키워도 점수가 흔들리지 않는다. 대신 반대쪽 대가가 남는다: 정원만 크게 잡고 둘이 들어간 방은 오가는 표가 2장뿐이라 점수가 거의 안 움직인다.

**봇 수 상한도 여기서 정해진다.** 정원 상한 8에서 시작 최소 인원 2를 빼면 봇은 최대 6명이다. 이 숫자가 봇 문구 풀의 하한이 된다 (§17.2) — 문구가 이보다 적으면 답이 빈 봇이 생기고, 빈칸은 사람만 만들 수 있으므로 그 자리가 드러난다 (I1). 정원 상한을 올릴 때는 문구 풀도 같이 본다.

**정원은 만든 뒤에 바뀌지 않는다.** 좌석과 역할이 이미 그 수를 전제하고 배정돼 있다. 시작한 뒤에 정원을 줄이면 자리에 앉은 사람이 밀려나고, 늘리면 §17.4에서 섞어둔 봇 자리 배치가 무너진다. 정원을 바꾸고 싶으면 새 방을 만든다.

**`GET /api/room`은 시작한 방도 내려보낸다. 대신 세는 방법이 상태마다 다르다 (I1).**

예전에는 `phase = 'lobby'`인 방만 내려보냈다. 시작한 방을 올리면 **"정원 − 표시 인원"으로 봇 수가 새어나가기** 때문이었다. 지금은 목록에서 빼는 대신 **숫자를 바꿔서** 막는다.

| 방 상태 | 세는 대상 | 왜 |
|---|---|---|
| `lobby` (대기 중) | **사람만** | `/api/room/start`는 `fill_with_bots`를 먼저 커밋하고 몇 번의 왕복 뒤에 `advance_phase`를 부른다. 그 사이 방은 아직 `lobby`인데 봇은 이미 앉아 있다. 폴링이 그 틈에 걸리면 줄이 `2/5`에서 `5/5`로 바뀌는 게 보이고 **그 차이가 곧 봇 수**다 |
| 그 밖 (게임 중) | **봇까지 전부** | 시작한 방은 `fill_with_bots`가 자리를 다 채웠으므로 언제나 `정원/정원`이다. 뺄 것이 없으니 샐 것도 없다. 화면에도 이쪽이 사실이다 — 다 찬 방을 `3/5`로 그리는 게 오히려 거짓말이었다 |

목록에 올리는 것 자체는 §15-3-결정과도 어긋나지 않는다. 거기서 공개하기로 한 것은 봇의 **총 수**이고, 여기서 막는 것은 그것과 별개로 **자리 수를 역산할 실마리**다.

시작한 방은 `join_room`이 거절하지만 `/api/room/join`은 그 앞에서 쿠키를 먼저 본다 — **그 방에 있던 사람은 목록에서 눌러 복귀한다.** 새 사람에게는 "이미 시작된 방이다"가 뜬다.

봇을 채우는 시점(§15-3)을 lobby 쪽으로 옮기면 **위 표의 `lobby` 줄을 다시 판단해야 한다.**

---

## 18. 게임 규칙 확정 — 진영 · 승패 · 투표

**2026-08-02에 하나씩 확정했다.** 여기가 게임 규칙의 기준이다. 앞 섹션과 어긋나면 **이 섹션이 맞다.** 어긋나는 자리는 §18.7에 전부 적어뒀다.

**아직 구현하지 않았다.** 이 섹션은 규칙만 확정한 것이고 스키마·상태머신·화면은 아직 예전 규칙대로다. 손대는 순서도 §18.7에 있다.

### 18.1 인원표 — 사람 수가 구성을 정한다

> **★ 2026-08-06 결정으로 이 절의 인원표는 폐기됐다. 코드에 들어간 적은 없다.**
>
> **확정: 사람 정원은 8로 고정, AI는 언제나 1대.** 방을 만들 때 고르는 값이 없다 —
> `capacity`(3~10에서 6 제외)도 `seat_count`도 짓지 않는다.
>
> | 무엇 | 값 |
> |---|---|
> | 사람 정원 | **8** (`rooms.capacity`, 새 방은 전부 이 값) |
> | 시작 조건 | 사람 **2~8명**이고 **방장을 뺀 전원이 준비 완료** (2026-08-07) |
> | AI | **1대.** 시작 버튼을 누르는 순간 합류한다 |
> | 그 판의 자리 수 | 사람 수 + 1 (최대 9). `players.seat`은 1~9 |
>
> 아래 인원표를 버린 이유는 표가 틀려서가 아니라 **고르게 할 것이 없어서**다. 표의
> 목적("사람보다 AI가 많은 판을 막는다")은 AI를 1대로 못 박는 쪽이 더 세게 이룬다 —
> 사람이 2명이든 8명이든 AI는 언제나 소수다. 대신 `capacity`가 상한과 실제 자리 수로
> 갈리던 문제(아래 "수는 둘로 나눈다")도 같이 사라졌다: 나눌 수가 하나뿐이다.
>
> 구현 위치는 `lib/game/rules.ts` 하나다 — `MAX_HUMANS_PER_ROOM` ·
> `MIN_HUMANS_TO_START` · `AI_SEATS_PER_ROUND` · `startBlock`. 화면의 시작 버튼과
> 시작 라우트 둘이 **같은 함수**를 본다. 자리 상한 9는 `players.seat` 체크와
> `lib/mp/constants.ts`의 `WORLD_SEAT_SLOTS`(좌석 원을 9등분한다)에 같이 걸려 있다.
>
> 아래 원문은 결정의 경위로 남긴다.

예전에는 **빈자리를 전부 봇이 채웠다.** 정원 8인 방에 둘이 들어오면 봇이 6대였다. 사람보다 봇이 많은 판은 추리가 아니라 소거법이 된다.

확정: **시작 버튼을 누른 시점의 사람 수**로 아래 표를 읽어 AI 수와 연기자 상한을 정한다.

| 총 자리 | 사람 | 시민 | 연기자 | AI |
|---|---|---|---|---|
| 3 | 2 | 2 | 0 | 1 |
| 4 | 3 | 2 | 1 | 1 |
| 5 | 4 | 3 | 1 | 1 |
| 6 | 4 | 3 | 1 | 2 |
| 7 | 5 | 4 | 1 | 2 |
| 8 | 6 | 4 | 2 | 2 |
| 9 | 7 | 5 | 2 | 2 |
| 10 | 8 | 6 | 2 | 2 |

**읽는 키는 사람 수다.** 구현이 실제로 참조하는 건 아래 모양이다.

| 사람 | AI | 연기자 상한 | 총 자리 |
|---|---|---|---|
| 2 | 1 | 0 | 3 |
| 3 | 1 | 1 | 4 |
| 4 | 1 | 1 | 5 |
| 5 | 2 | 1 | 7 |
| 6 | 2 | 2 | 8 |
| 7 | 2 | 2 | 9 |
| 8 | 2 | 2 | 10 |

**사람 4명은 원표의 두 줄에 걸린다**(총 자리 5와 6). 작은 쪽(AI 1)을 쓴다. 그래서 **총 자리 6 줄은 실제로 쓰이지 않는다** — 의도한 것이다. 사람 수가 같은데 AI만 늘리는 줄은 방 정원을 봐야 고를 수 있고, 방 정원은 상한 역할만 하기로 했다. 이 줄을 살리려면 방 정원이 다시 구성에 개입해야 한다.

**방을 만들 때 고르는 값은 총 자리 그대로다. 다만 6을 뺀다.** 총 자리 6인 방은 사람을 4명까지 받는데, 사람 4명은 위 규칙에 따라 AI 1대 줄을 쓰므로 **총 자리 5짜리 방과 완전히 같은 판**이 된다. **다르게 고른 줄 알았는데 같은 게임이 나오는 선택지는 두지 않는다.** 고를 수 있는 값은 **3 · 4 · 5 · 7 · 8 · 9 · 10**이고 기본은 5다.

6을 뺀 덕에 남은 값은 전부 서로 다른 판이고, **다 차서 시작하면 고른 값이 곧 자리 수**가 된다.

| `capacity` | 사람 상한 | 다 차서 시작하면 `seat_count` | AI |
|---|---|---|---|
| 3 | 2 | 3 | 1 |
| 4 | 3 | 4 | 1 |
| 5 (기본) | 4 | 5 | 1 |
| 7 | 5 | 7 | 2 |
| 8 | 6 | 8 | 2 |
| 9 | 7 | 9 | 2 |
| 10 | 8 | 10 | 2 |

**그래도 수는 둘로 나누고 이름을 다르게 준다.** 덜 모여도 시작하기 때문이다 — 총 자리 10인 방이 사람 4명으로 시작하면 자리는 10칸이 아니라 5칸이다. **같은 것을 둘 다 '정원'이라고 부르면 코드에서 반드시 섞인다.**

| 이름 | 뜻 | 언제 정해지나 |
|---|---|---|
| `rooms.capacity` | 총 자리의 **상한**. 3~10 중 **6을 뺀 값**, 기본 5 | 방을 만들 때. 그 뒤로 안 바뀐다 |
| `rooms.seat_count` | 그 판의 **실제 총 자리**. 3~10 | **시작할 때**, 모인 사람 수로 위 인원표를 읽어서. 그전에는 `null` |

**그 방이 받는 사람 수 상한도 `capacity`에서 나온다** (위 표 가운데 칸). 총 자리 8인 방은 사람 6명까지다 — 남은 두 자리는 AI 몫이라 사람에게 열지 않는다. 좌석 그리드는 `seat_count` 칸으로 그린다.

**시작 최소 인원은 사람 2명 그대로다** (§17.6). 인원표의 첫 줄이 그 인원이다. `capacity` 3인 방은 사람 상한과 최소 인원이 둘 다 2라, 두 명이 모이는 즉시 시작한다.

### 18.2 연기자 — 수는 랜덤, 서로 모른다

역할 이름을 **'스파이'에서 '연기자'로 바꾼다.** 코드 값도 `'spy'` → `'actor'`다. 반쪽만 바꾼 이름은 나중에 같은 개념을 두 단어로 부르게 만든다.

- **연기자 수는 0부터 표의 상한까지 균등 랜덤이다.** 시민 수는 `사람 수 − 연기자 수`로 따라온다. 위 표의 시민 칸은 연기자가 상한일 때의 값이다.
  - **2026-08-06: 인원표(§18.1)가 폐기된 뒤의 연기자 상한은 사람 수(AI 제외)로 정한다** — **3명 이하면 0**(작은 판은 연기 없이 순수 추리다 — 연기자를 빼고 나면 시민이 한둘뿐이라, 연기가 성공하는 순간 추리할 사람이 남지 않는다), **4~5명이면 1, 6~8명이면 2.** 그 상한 안에서 0~상한 균등 랜덤이라는 본문 규칙은 그대로다. 폐기된 표와는 한 칸 다르다 — 표는 사람 3명부터 1이었는데 3명도 0으로 내렸다. 구현은 월드 워커의 `actorCap`·`pickActors`(`worker/src/roundtable.ts`) 하나다. 2026-08-05에 코드가 잠깐 "정확히 1명"으로 굳었던 것을 이 결정으로 도로 폈다.
- **수를 공개하지 않는다.** 고정값이면 표만 보면 누구나 아는 수라, 랜덤으로 두는 것이 곧 비밀로 두는 것이다.
- 이건 봇 수와 다르다. **봇 수는 공개다** — 총 자리에서 바로 유도된다 (§15-3). 좌석이 5칸이면 AI는 1대다.
- **연기자끼리 서로를 모른다.** 자기 역할만 안다. 마피아처럼 동료를 알려주면, 동료가 안 보이는 순간 "내가 유일한 연기자"가 확정돼 0명일 가능성이 주는 긴장이 사라진다.
- **연기자가 0명인 판이 정상적으로 나온다.** 예외 처리 대상이 아니다.

### 18.3 투표 — 동점이면 재투표, 그래도 동점이면 무작위

- **승패를 정하는 표는 사람이 던진 표만이다.** 봇도 투표하고 reveal에서 보이지만 집계에서 빠진다. 근거는 §8.1과 같다 — 봇은 아무나 찍으므로 세면 판정이 주사위가 된다.
- **자기 자신에게 투표할 수 없다.** 연기자가 자기를 찍어 지목을 만들어내는 길을 막는다.
- `vote` 30초 → 최다 득표가 단독이면 그 자리가 **지목**된다.
- 동점이면 `revote` 페이즈 **20초.** 후보를 동점자로 좁힌다.
- 재투표에서도 동점이면 **동점자 중 무작위 한 명**이 지목된다. 재투표는 한 번뿐이고 판은 최대 2라운드 안에 끝난다.

**이 마무리 규칙은 예외 처리가 아니라 정상 경로다.** 사람 2명 방은 세는 표가 두 장뿐이라 서로를 찍으면 1대 1이고, 서로를 의심하는 게 이 게임에서 가장 자연스러운 그림이다. 재투표를 무제한으로 두면 그 방은 영원히 안 끝난다.

**'후보를 동점자로 좁힌다'와 '자기 자신 금지'가 겹치는 자리.** 동점자가 곧 투표자인 경우가 있다.

- 후보에 오른 사람은 자기를 못 찍으므로 **남은 후보 중에서 고른다.** 후보가 자기 하나뿐인 상황은 생기지 않는다 — 동점은 정의상 둘 이상이다.
- 사람 2명 방에서 서로를 찍으면 후보가 그 둘이 되고, 각자 상대만 찍을 수 있어 다시 1대 1이 된다. 그다음은 무작위다. 판은 끝나지만 **후보에 AI가 없으므로 그 판의 시민은 이길 수 없다.**
- 이건 버그가 아니라 대가다. 두 장뿐인 표를 서로에게 쓴 판이고, 그 대가가 있어야 "서로 의심하다 AI를 놓쳤다"가 결과로 남는다. 후보를 안 좁히고 전원으로 다시 받으면 이 대가는 사라지지만, 생각이 안 바뀐 같은 동점이 한 번 더 나올 뿐이라 좁히는 쪽을 택했다.

### 18.4 승패 — 지목된 한 명의 정체가 판을 끝낸다

| 지목된 자리 | 이기는 진영 |
|---|---|
| AI | 시민 |
| 연기자 | 연기자 |
| 시민 | AI |

- **언제나 정확히 한 진영이 이긴다.** 무승부가 없다.
- 연기자가 둘이면 **둘 중 하나만 지목돼도 연기자 진영 전체가 이긴다.**
- **개인 점수는 없앤다.** 판의 결론은 "어느 진영이 이겼다" 하나다. 전적에는 그 판의 역할과 승패를 적는다.
- reveal에서 **전원의 정체를 공개한다.**

**점수를 없앤 이유.** 점수와 승패가 같이 있으면 한 판이 두 결론을 낸다. AI가 이긴 판에서 봇을 정확히 찍은 시민 하나가 +2를 받으면, 화면에는 "AI 승"이 떠 있는데 전적에는 그 사람이 '이김'으로 적힌다. 결과 화면과 전적이 서로 다른 말을 하는 것 — §14 부록이 이미 경고했던 바로 그 증상이다.

### 18.5 봇 대칭 — 성실한 봇은 티가 난다

SPEC이 스스로 남겨둔 구멍 둘은 같은 병이었다. **봇이 사람보다 성실해서 규칙이 신호가 됐다.**

- **봇도 답을 거른다.** 봇마다 약 15% 확률로 그 페이즈의 답변을 만들지 않는다. 빈칸이 양쪽에서 생기므로 "답 없는 자리 = 사람"이 깨진다. §5.3이 "봇 답변이 하나라도 비면 그 자리가 사람으로 확정된다"고 적은 건 **비는 일이 사람 쪽에서만 생길 때** 맞는 말이었다.
  - **문구 풀이 모자라서 비는 것과는 구분한다.** 풀 부족은 여전히 예외를 던진다 (§17.2). 확률로 거르는 건 의도된 침묵이고, 풀 부족은 버그다. 같은 빈칸이어도 원인이 다르면 다르게 다뤄야 한다.
  - **target 페이즈에서도 같은 확률로 거른다.** 거기서만 봇이 반드시 답하게 두면 "지목 질문에 답이 달렸으면 대상은 봇"이 성립한다 — §5.3에서 두 번 데인 것과 같은 함정의 세 번째 얼굴이다. 대신 대상이 봇이고 걸렀을 때 30초 동안 아무 답도 안 뜨는 판이 생기는데, 대상이 사람일 때도 똑같이 생기므로 대칭은 지켜진다.
  - **15%는 시작값이지 규칙이 아니다.** 사람의 실제 무응답률과 크게 어긋나면 편향이 반대로 생긴다. `/lab`에서 맞춘다.
- **침묵이 길면 봇이 먼저 말한다.** 봇마다 8~15초 사이의 **서로 다른** 임계를 갖고, 그동안 아무 말도 안 오면 하나가 먼저 꺼낸다.
  - **임계를 봇끼리 같게 두면 그 간격 자체가 신호가 된다.** §5.3에서 두 번 데인 것과 같은 함정이다 — 봇에게만 붙는 규칙적인 타이밍은 어느 방향이든 샌다.
  - **선공도 §5.4의 제약을 그대로 지킨다** — 봇당 쿨다운 최소 8초, 침묵을 깨는 봇은 한 번에 최대 1명. 두 봇이 동시에 입을 열면 그 순간 둘 다 봇임이 드러난다.
  - 주의: chat 시작 직후에도 이 규칙이 돌면 "첫 마디는 항상 봇"이라는 **반대 방향 신호**가 생긴다. 임계는 튜닝 대상이고 `/lab`에서 첫 발화자 분포를 보고 조정한다.

### 18.6 이탈과 다시 하기 — §15-4 · §15-5 결정

**이탈(§15-4): 자리를 그대로 둔다.** 나간 사람의 좌석과 역할은 유지되고, 돌아오면 이어서 한다.

봇이 이어받는 안은 두 군데서 샌다. AI 수가 표(§18.1)와 어긋나 **승패 조건이 판 도중에 바뀌고**, 조용하던 자리가 갑자기 말하기 시작하는 것 자체가 자리를 드러낸다. 대가는 끝까지 안 돌아오면 사람 표가 한 장 준다는 것인데, 그건 §18.3이 끝내준다.

**대신 조기 종료 인원에서 끊긴 사람을 뺀다 (I5 보강).** 자리를 그대로 두기로 했으므로 나간 사람도 여전히 `is_bot = false`다. I5를 글자 그대로 지키면 "사람 전원 제출"이 **영영 참이 되지 않아** question·vote·revote가 매번 시간을 꽉 채운다. 한 명만 창을 닫아도 남은 사람들이 매 페이즈 60초를 통째로 기다리게 된다.

그래서 조기 종료는 `is_bot = false and connected` 인원으로 센다. **봇은 언제나 `connected`이므로 이 조건은 봇 자리에 대해 아무것도 바꾸지 않고**, `connected`는 이미 `public_players`로 나가는 공개 필드라 새는 것도 없다 (I1). I5의 취지("봇을 세지 않는다")는 그대로다.

**다시 하기(§15-5): 같은 방에서 역할만 다시 뽑는다.** 방 코드와 참가자는 유지하고 역할·연기자 수·봇 자리를 전부 새로 뽑는다. 나간 사람이 있으면 **줄어든 사람 수로 §18.1 표를 다시 읽는다.**

### 18.7 이 결정이 뒤집는 것

| 자리 | 예전 | 지금 |
|---|---|---|
| §0, 용어, §3 | 역할 이름이 '스파이'(`'spy'`) | **'연기자'**(`'actor'`). 화면·문서·코드 값을 전부 바꾼다 (§18.2) |
| §0, §15-3, §17.4 | 빈자리를 전부 봇이 채운다 | 사람 수로 표를 읽어 AI 수를 정한다 (§18.1). **AI는 항상 1대 이상** |
| §3, §4, §17.6 | `capacity` 3~8이 곧 자리 수 | **`capacity`는 3~10 중 6을 뺀 값**(기본 5는 그대로). 뜻은 총 자리의 상한이고, **그 판의 실제 자리 수는 새 값 `seat_count`(3~10)**가 든다. `players.seat` 제약은 1~10. 좌석 그리드 8칸을 10칸으로 넓혀야 한다 (C 영역) |
| 「불변 규칙」 I5 | 조기 종료 인원 = `is_bot = false` | **`and connected`**를 더한다. 안 그러면 한 명만 나가도 매 페이즈가 시간을 꽉 채운다 (§18.6) |
| §15-2-결정 (전적) | `won`을 점수에서 유추하고, EXP는 그 점수 | `won`은 **진영 승패를 그대로** 적는다. 점수가 사라지므로 **EXP는 승패에서 유도한다 — 이긴 판 +3, 진 판 -1**(2026-08-07). 안 정하면 레벨이 멈춘다 |
| §3, §5.1 | `Phase`에 `revote`가 없다 | `revote` 추가. vote → (동점) revote → reveal (§18.3) |
| §8, §8.1 | 개인 점수 (시민 +2 / 스파이 +4 / AI +3) | **폐기.** 진영 승패만 (§18.4). `calcScores`·`mostSuspectedHuman`·`lib/server/fallback-rules.ts`가 할 일이 없어진다 |
| §8.1 끝 | 봇 0대 방의 채점이 미정 | **문제가 사라졌다.** AI가 항상 1대 이상이라 시민이 이길 길이 언제나 있다 |
| §5.3 | 봇은 반드시 답한다 | 약 15% 확률로 거른다 (§18.5) |
| §5.4 | 봇은 사람 말에 반응만 한다 | 침묵이 길면 먼저 꺼낸다 (§18.5) |
| §15-4 | 미결정 | 자리를 그대로 둔다 (§18.6) |
| §15-5 | 미결정 | 같은 방, 역할 재배정 (§18.6) |

**손대는 순서.** 앞의 것이 뒤의 것을 막는다.

1. `lib/game/types.ts` — `Role`의 `'spy'` → `'actor'`, `Phase`에 `revote` 추가 (공동 소유, 공지 대상)
2. `supabase/schema.sql` — `capacity` 3~10에 `<> 6`, `seat_count` 컬럼 추가, `seat` 1~10, `phase` 체크에 `revote`
3. `supabase/functions/` — 인원표(§18.1)로 봇을 채우고 역할을 뽑는 함수, `revote` 분기, 지목 결과 확정
4. `lib/server/` — 점수 계산 제거, 승패 판정 추가, 전적 기록을 진영·승패로
5. `app/`·`components/` — 좌석 10칸, 결과 화면을 진영 승패로 (C 영역)

**§18.1은 순수 함수로 뺄 수 있다.** 표를 읽어 `{ ai, actorMax }`를 내놓는 것과 역할 배열을 만드는 것은 DB를 모른다. `lib/game/rules.ts`가 자리다 (B 소유, I3).

---

## 부록: 이 개정판에서 달라진 것

문서 구조를 에이전트가 읽기 좋게 바꾸면서, 원본의 모순과 사실관계 오류 세 곳을 고쳤다. **§0~§12 번호는 그대로 두었다** — 코드 주석이 참조하기 때문이다.

| 위치 | 원본 | 바뀐 것 | 이유 |
|---|---|---|---|
| §6 | answers·messages를 Postgres Changes로 구독 | Broadcast로 확정 | Postgres Changes는 배달 시점에 RLS를 평가해서 `visible_at`이 미래인 행을 전달하지 않는다. 원본대로면 봇 타이핑 지연이 통째로 깨진다 (§6.1) |
| §7 | "본인 답변은 항상 허용", "insert는 본인 것만" | 쓰기는 전부 service role 경유로 좁힘 | 익명 플레이라 DB가 요청자를 식별할 수 없어 원본 규칙을 표현할 방법이 없다 (§7.1) |
| §12.2 | Supavisor 풀러를 무조건 적용 | 드라이버 직접 접속 시에만 해당한다고 명시 | `supabase-js`는 PostgREST(HTTP)라 Postgres 커넥션을 잡지 않는다. 우선순위도 12.7에서 1→6으로 내렸다 |

새로 추가한 것: 「이 문서를 읽는 법」, 「불변 규칙」, 「용어」, §13 완료 조건, §14 검증, §15 미결정 사항.

### 다중 방 (§16) 추가분

방을 여러 개 만들어 동시에 플레이하는 시나리오가 설계에서 빠져 있었다. 데이터 모델은 이미 방 단위로 갈라져 있었지만 그 바깥이 비어 있었다.

| 위치 | 없던 것 | 넣은 것 |
|---|---|---|
| I10, §6.3, §16.1 | 구독에 방 필터를 걸라는 계약 | 필터·채널 이름 규칙. **이게 없으면 다른 방 전환이 내 화면에 들어온다** |
| §5.2, §12.1, §16.2 | 워치독의 다중 방 동작 | `skip locked` + 방별 예외 격리 + 중복 실행 방지. 안 넣으면 안전망이 단일 장애점이 된다 |
| §4, §16.3 | `rooms(phase_ends_at)` 등 인덱스 | 워치독이 15초마다 전체 방을 풀스캔하지 않도록 |
| §16.4 | 코드 충돌 재시도, 방 정리 | 재시도 5회, 24시간 지난 방 삭제 |
| §12.6, §16.5 | LLM 전역 상한 | 방당 40회만으로는 계정 rate limit을 못 막는다 |
| §7.3, §15-6 | 방 격리를 RLS로 못 하는 이유 | 헤더 기반 정책은 Realtime 배달을 죽인다. 현재 노출 범위를 명시 |

### 목 우선 (§17) 추가분

AI를 나중에 붙이기로 하면서, 그동안 실행 주체가 비어 있던 자리 셋을 채웠다. **§0~§16 번호는 그대로다.**

| 위치 | 비어 있던 것 | 채운 것 |
|---|---|---|
| §5.3, §17.2 | 진입 훅을 **누가** 실행하는가. plpgsql은 TS도 LLM도 못 부른다 | 전환 함수가 문구 풀에서 뽑는다. 점수만 `/api/reveal`로 뺀다 |
| §6, §17.3 | `players`를 뷰로 구독한다고 적혀 있었다. **뷰는 publication에 못 들어간다** | `rooms.roster_seq` 신호 + 재조회 |
| §7.1, §17.4 | 서버가 요청자를 확인할 방법 | 입장 시 `player_token` 발급, httpOnly 쿠키 |
| §5.1, §5.3 | 대상이 봇이면 target이 0초에 끝나 봇이 드러났다 | 봇이 대상이면 조기 종료하지 않는다 — **이 처방은 나중에 뒤집혔다. 아래 「게임 룰 점검」 참고** |
| §7.2 | 뷰의 `created_at`으로 봇이 전부 특정됐다 | 뷰에서 뺀다 |
| §8 | `assignRoles`에 시드가 없어 스파이를 못 골랐다 | `(isBotBySeat, seed)`로 교체 — **B 확인 필요** |
| §12.6 | 방당 40회가 chat 한 판을 못 버틴다 | 숫자를 LLM 붙일 때 재계산하기로 미룸 |
| 불변 규칙 | "아홉 개"인데 표는 열 개 | 열 개로 |

### 방 정원 (§17.6) 추가분

정원이 문서 여러 곳에 "5"라는 숫자로 흩어져 있었다. 방마다 정하는 값으로 바꾸면서 한 자리(`rooms.capacity`)로 모았다.

| 위치 | 없던 것 | 넣은 것 |
|---|---|---|
| §0, 용어, §3, §4, §17.6 | 정원이 5로 고정이었다 | `rooms.capacity` 3~8(기본 5). 하한은 스파이가 생기는 최소 인원(§8), 상한은 좌석 그리드 8칸. `seat` 제약을 1~8로 넓히고, 정원을 읽는 곳은 `room_capacity()` 하나로 모았다 |

### 게임 룰 점검 추가분

한 판을 규칙 쪽에서 훑어보니, 개별 함수는 다 맞는데 **합쳐놓으면 성립하지 않는 자리**가 여럿 있었다. 다섯 개를 고쳤다. **§0~§17 번호는 그대로다.**

| 위치 | 무엇이 이상했나 | 고친 것 |
|---|---|---|
| §17.6 | 정원 하한 3의 근거가 "사람 2명이 들어올 여지"인데 **여지만 만들고 강제하지 않았다.** 방장 혼자 시작하면 스파이가 없고 나머지가 전부 봇이라 아무나 찍어도 정답 | 시작에 사람 2명을 요구한다. `/api/room/start`와 `advance_phase` 두 겹 |
| §8, §8.1 | 스파이 점수가 받은 표에 비례해서 상한이 시민의 7배(14점 대 2점)였고, 그 표의 대부분이 봇의 무작위 표였다 | **사람 표만 센다.** 스파이는 "사람 표를 한 장이라도 받으면 +4"로 고정 |
| §5.3 | "봇이 대상이면 조기 종료하지 않는다"가 **누수의 방향만 뒤집었다** — 빨리 넘어가면 "대상은 사람"이 확정된다 | target에는 조기 종료가 **아예 없다.** 대상이 누구든 30초를 채운다 |
| §17.2 | 봇 문구가 `phase`만 보고 뽑혀서 질문과 무관했다. '배터리 몇 퍼센트야?'에 '어제랑 비슷했던 것 같아' — **첫 질문 한 번으로 봇이 전부 갈렸다** | 문구를 질문에 묶는다 (`bot_line_pool.question_text`) |
| §17.2 | 봇마다 따로 뽑아서 겹쳤다. 봇 6명이면 답변 약 68%, 투표 이유 약 92% 확률로 두 봇이 같은 말 | 봇과 문구에 번호를 매겨 1:1로 배정. 채팅도 한 방에서 같은 줄을 두 번 쓰지 않는다 |

**그때 남겨뒀던 네 가지는 전부 §18에서 정리됐다.**

| 남겨뒀던 것 | 어떻게 됐나 |
|---|---|
| 봇이 0대인 방의 채점 | **문제가 사라졌다.** 인원표가 AI를 항상 1대 이상 넣는다 (§18.1) |
| 답을 안 낸 자리는 사람 확정 | 봇도 약 15% 확률로 거른다 (§18.5) |
| 채팅에서 봇이 먼저 말을 안 꺼낸다 | 침묵이 봇마다 다른 임계를 넘으면 먼저 꺼낸다 (§18.5) |
| 팀 승패 판정이 없다 | **진영 승패로 확정하고 점수를 없앴다** (§18.4). 전적은 역할과 승패를 적는다 |

### 게임 규칙 확정 (§18) 추가분

**2026-08-02, 사용자와 하나씩 정했다.** 앞의 개정이 "합쳐놓으면 성립하지 않는 자리"를 메우는 일이었다면, 이번엔 **판의 결론이 무엇인가**를 처음 정했다. §0~§17 번호는 그대로다.

| 위치 | 무엇이 없었나 | 정한 것 |
|---|---|---|
| §18.1 | 빈자리를 전부 봇이 채워서, 사람이 적으면 봇이 다수인 판이 됐다 | **인원표.** 시작 시점의 사람 수로 AI 수와 연기자 상한을 읽는다. `capacity` 상한은 10, **6은 5와 같은 판이라 뺀다.** 그 판의 실제 자리 수는 새 값 `seat_count`가 든다 |
| §18.2 | 스파이는 항상 1명이고 정원만 알면 아는 값이었다 | **연기자로 개명**하고 **수를 0~상한 랜덤**으로. 서로를 모른다 |
| §18.3 | 투표가 한 번뿐이라 동점을 처리할 데가 없었다 | `revote` 20초 한 번, 그래도 동점이면 **동점자 중 무작위**. 판은 최대 2라운드에 끝난다 |
| §18.4 | 점수만 있고 "누가 이겼다"가 없었다 | **지목된 한 명의 정체가 판을 끝낸다.** 언제나 한 진영만 이기고, **개인 점수는 폐기** |
| §18.5 | 봇이 사람보다 성실해서 규칙 자체가 신호였다 | 봇도 답을 거르고, 침묵이 길면 먼저 말한다 |
| §18.6 | §15-4·§15-5가 미결정이었다 | 이탈은 자리를 그대로, 다시 하기는 같은 방에서 역할만 다시 |
