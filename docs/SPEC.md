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

이 아홉 개가 이 프로젝트의 뼈대다. 나머지는 전부 이것들을 지키기 위한 수단이다.

| # | 규칙 | 위반 시 증상 | 적용 위치 |
|---|---|---|---|
| **I1** | 클라이언트에 `is_bot`을 노출하지 않는다. 클라이언트는 `players`가 아니라 `public_players` 뷰를 읽는다 | 누가 봇인지 즉시 드러나 **게임 자체가 성립하지 않는다** | `supabase/policies.sql`, 모든 클라이언트 쿼리 |
| **I2** | 페이즈 전환 판정은 서버 시각만 쓴다. 클라이언트 카운트다운은 표시용이다 | 시계가 3초 빠른 사람만 화면이 먼저 넘어간다 | `lib/server/phase.ts`, `supabase/functions/` |
| **I3** | `lib/game/**`는 순수 함수만. DB·네트워크·`Date.now()`·랜덤 금지 | 테스트가 불가능해지고, A와 B가 서로를 기다리게 된다 | `lib/game/` |
| **I4** | LLM API 키는 서버에서만 읽는다. 호출 경로는 `app/api/agent/` 하나뿐이다 | 키가 클라이언트 번들에 실려 유출된다 | `app/api/agent/route.ts` |
| **I5** | 조기 종료 인원은 `is_bot = false`인 플레이어만 센다 | 봇은 즉시 제출하므로 **모든 페이즈가 시작하자마자 끝난다** | `advance_phase` |
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
| `seat` | 1~5. 화면 표시 순서 | **입장 순서가 아니다.** 한 번 정해지면 게임 내내 안 바뀐다 |
| `nickname` | '익명1' ~ '익명5' | seat 숫자와 일치할 필요는 없다 |
| `mask_id` | 아바타·가면 에셋 키 | 정체와 무관하다. 노출돼도 안전하다 |
| `phase_seq` | 페이즈 전환마다 +1 되는 정수 | **라운드 번호가 아니다.** 중복 전환을 막는 낙관적 잠금 키다 |
| `round` | question 페이즈의 1 또는 2 | question 외 페이즈에서는 의미 없다 |
| `visible_at` | 이 시각 **이후에만** 화면에 띄운다 | `created_at`이 아니다. 미래 시각일 수 있다 |
| **사람 전원** | `is_bot = false`인 플레이어 전원 | 봇 포함이 아니다 (I5) |
| **조기 종료** | 시간 만료 전에 조건을 충족해 넘어가는 것 | chat 페이즈에는 조기 종료가 없다 |
| **봇 / AI** | `is_bot = true`인 플레이어. 역할은 `'ai'` | 스파이(`'spy'`)는 사람이다. 헷갈리면 게임 규칙이 깨진다 |

---

## 0. 한 줄 요약

5인 채팅방에서 누가 AI인지 찾는 웹 게임. 빈자리는 AI 봇이 채우며 그 사실은 공개되지 않는다. 인간 중 한 명은 AI인 척해야 하는 스파이다.

---

## 1. 스택

| 영역 | 선택 | 비고 |
|---|---|---|
| 프레임워크 | Next.js 15 (App Router) + TypeScript strict | |
| 스타일 | Tailwind CSS v4 | |
| DB / 실시간 | Supabase (Postgres + Realtime) | |
| 서버 로직 | Supabase Edge Function + Next.js Route Handler | |
| 3D | react-three-fiber + drei | 게임이 끝까지 돌아간 뒤에 도입. 그 전에는 2D |
| LLM | **미정 — §15-1** | 잠정: NVIDIA NIM API. 프록시는 Route Handler 경유 |
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
  | 'reveal'
  | 'replay';

export type Role = 'citizen' | 'spy' | 'ai';

export type AgentAction = 'answer' | 'deflect' | 'accuse' | 'silent';

export interface Room {
  id: string;
  code: string;                 // 4자 대문자
  phase: Phase;
  phase_seq: number;            // 전환마다 +1. 중복 전환 방지 키
  phase_ends_at: string | null; // ISO. null이면 무기한(lobby)
  round: number;                // question 페이즈에서만 의미 있음
  host_id: string;
}

export interface Player {
  id: string;
  room_id: string;
  nickname: string;      // '익명1' ~ '익명5'
  mask_id: string;
  seat: number;          // 1~5. 표시 순서 고정
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

create index on players    (room_id);
create index on messages   (room_id, visible_at);
create index on answers    (room_id, question_id);
create index on questions  (room_id, round);
create index on agent_logs (room_id);

-- pg_cron 워치독이 15초마다 훑는다. 없으면 방이 쌓일수록 전체 스캔이 된다 (§16.3)
create index on rooms (phase_ends_at) where phase_ends_at is not null;
```

**적용 순서.** `schema.sql` → `policies.sql`. 직결 포트(5432)로 적용한다 (§12.2).

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

**"사람 전원"이 핵심 (I5).** 봇은 즉시 제출하므로 봇을 포함해 세면 조건이 항상 참이 된다. `is_bot = false`인 플레이어만 센다.

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
  5. 새 페이즈 진입 훅 실행 (5.3)
  6. Realtime이 rooms 변경을 자동 브로드캐스트
```

`phase_seq` 하나로 중복 호출이 전부 무력화된다. 5명이 동시에 호출해도 첫 호출만 성공한다 (I6).

**호출자는 세 종류다.** 전부 같은 RPC를 같은 방식으로 부른다.

1. 만료를 감지한 클라이언트 타이머
2. `visibilitychange`로 복귀한 클라이언트 (§12.1)
3. pg_cron sweep (§12.1)

**여러 방이 동시에 돌 때 1번 잠금이 문제가 된다.** sweep이 이미 전환 중인 방에서 `for update`를 기다리면 뒤쪽 방들이 통째로 밀린다. sweep은 `for update skip locked`로 잠긴 방을 건너뛴다 (§16.2).

### 5.3 페이즈 진입 훅

| 진입 페이즈 | 서버가 하는 일 |
|---|---|
| question | 질문 1개 선택 후 insert. **봇 답변을 즉시 생성**하고 `visible_at`을 공개 시점으로 설정 |
| target | 지목 대상 결정. 대상이 봇이면 답변 생성 |
| chat | 봇별 쿨다운 초기화 |
| vote | 봇 투표 생성 |
| reveal | `calcScores` 호출, 결과 확정 |

**봇 답변은 페이즈 시작 시 한꺼번에 만든다.** 함수가 6초를 기다릴 수 없으므로, 지연은 `visible_at`에 시각으로 박고 클라이언트가 그 시점에 띄운다.

### 5.4 자유 채팅 예외

chat 페이즈만 실시간 반응이 필요하다. 사람 메시지가 insert될 때마다 봇 응답 여부를 판단한다.

- 봇당 쿨다운 최소 8초
- 한 사람 메시지에 반응하는 봇은 최대 1명
- 이 구간이 API 호출이 가장 몰리는 지점 — 호출 수를 `agent_logs`에 남긴다

---

## 6. Realtime 동기화

**두 경로를 쓴다. 목적이 다르다.**

| 대상 | 전송 방식 | 이유 |
|---|---|---|
| `rooms` (update) | **Postgres Changes** | 초당 수 건. 변경이 드물고 **정확성**이 중요하다 |
| `answers`, `messages` (insert) | **Broadcast** (DB 트리거 → `realtime.broadcast_changes()`) | 고빈도 구간. **속도**가 중요하고, 아래 이유로 Postgres Changes를 쓸 수 없다 |
| `players` (insert/update) | Postgres Changes (`public_players` 뷰 기준) | 참가자 목록 갱신 |

### 6.1 왜 답변·채팅은 Broadcast여야 하는가

Postgres Changes는 **배달 시점에 RLS를 평가한다.** 그런데 answers·messages의 select 정책은 `visible_at <= now()`다 (§7). 즉 **`visible_at`이 미래인 행은 구독자에게 아예 전달되지 않는다.**

봇의 타이핑 지연은 "미래 `visible_at`을 가진 행을 미리 받아두고 그 시각에 렌더"하는 방식이다. Postgres Changes로는 이 행이 오지 않으므로 **지연 연출이 통째로 깨진다.**

Broadcast는 트리거가 직접 쏘므로 RLS 배달 평가를 거치지 않는다. 페이로드에 `visible_at`이 실려 오고, 클라이언트가 그 시각에 렌더한다.

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

순수 함수이므로 랜덤이 필요하면 **인자로 받는다.** 함수 안에서 `Math.random()`을 부르지 않는다 (I3).

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

export async function generate(ctx: AgentContext): Promise<AgentOutput>;
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

**공급자 교체가 `app/api/agent/route.ts` 한 파일로 끝나야 한다.** 그렇지 않으면 격리에 실패한 것이다.

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

### 12.6 비용 폭주

**증상.** chat 페이즈에서 사람이 도배하면 봇 응답이 그만큼 생성된다.

**대응.** 봇당 쿨다운 8초, 한 메시지에 반응하는 봇은 최대 1명, **방당 총 호출 상한 40회.** 상한 도달 시 폴백 풀로 전환한다. 호출 수와 토큰을 `agent_logs`에 남겨 기술 문서 근거로 쓴다.

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
| 1 | 방 생성 · 입장 | 브라우저 두 개에서 같은 코드로 들어가면 서로의 닉네임과 seat이 보인다 |
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
npm run build       # 최종. 이게 통과해야 끝난 것
```

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
| **15-1** | LLM 공급자 | 어느 API를 쓸지. 정해지면 §1·§9.2·`.env.local.example`을 갱신하고, Route Handler 런타임(`edge` / `nodejs`)을 그 SDK 지원 여부로 확정한다 | §13-5 이후 |
| **15-2** | 익명 인증 도입 여부 | Supabase 익명 인증을 붙이면 `players`에 `user_id`가 필요하다 → `types.ts` 변경이라 팀 공지 사안. 붙이지 않으면 §7.1 전제를 유지한다 | RLS를 더 조이려 할 때 |
| **15-3** | 봇을 채우는 시점 | lobby에서 미리 채우는가, 시작 버튼을 누른 순간 채우는가. 전자는 인원수로 봇 존재가 추론될 수 있다 | §13-1 |
| **15-4** | 이탈 · 재접속 처리 | 게임 중 나간 사람의 자리를 봇이 이어받는가, 빈 채로 두는가 | §13-2 |
| **15-5** | replay 페이즈 동작 | 같은 방으로 재시작인가, 새 방인가. 역할을 다시 배정하는가 | §13-7 |
| **15-6** | 방 격리를 DB로 강제할지 | 지금은 클라이언트 계약(§6.3)으로만 유지된다. anon 키로 다른 방의 닉네임·좌석·질문·공개 답변·채팅을 읽을 수 있다. 승패 정보(`is_bot`·역할·미공개 답변·reveal 이전 투표)는 이미 막혀 있다. 강제하려면 15-2가 선행돼야 한다 (이유는 §7.3) | 데모 공개 범위를 정할 때 |

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
- **끝난 방 정리.** 지금은 방이 영원히 남는다. 코드를 계속 점유하고 워치독 스캔 대상으로도 남는다. `phase = 'replay'`이거나 `created_at`이 24시간 지난 방을 주기적으로 지운다. cascade가 딸린 데이터를 함께 정리한다.
- **코드 재사용 주의.** 방을 지우면 코드가 다시 쓰일 수 있다. 그래서 Realtime 채널 이름은 `code`가 아니라 `room_id`를 쓴다 (§6.3).

### 16.5 LLM 전역 상한

§12.6의 "방당 40회"는 방이 하나일 때 얘기다. **rate limit은 계정 전체에 걸린다.**

- **전역 동시 호출 상한**을 둔다 (예: 8). 초과분은 대기시키지 않고 **즉시 폴백 풀로 보낸다.** 대기시키면 §12.3의 8초 예산이 무너진다
- 봇 답변 선생성(§12.3)이 이 상한을 지키게 한다 — 방 10개가 같은 초에 question으로 들어가면 40건이 한꺼번에 몰린다
- 폴백으로 떨어진 횟수를 `agent_logs`에 남긴다. 이게 "방 몇 개까지 버티는가"의 근거가 된다

### 16.6 그 밖의 한도

Supabase 무료 티어는 Realtime 동시 접속에 한도가 있다. 5인 × 방 N개로 계산해서 데모 전에 확인한다. 넘으면 방 수를 제한하거나 유료로 올린다. **데모 당일에 알게 되면 늦다.**

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
