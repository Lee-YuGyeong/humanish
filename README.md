# 사람인 척 (whois-human)

5인 채팅방에서 누가 AI인지 찾는 웹 게임. 빈자리는 AI 봇이 채우며 그 사실은 공개되지 않는다.
인간 중 한 명은 AI인 척해야 하는 스파이다.

기술 설계는 [`docs/SPEC.md`](docs/SPEC.md)가 유일한 기준이다. 코드와 어긋나면 SPEC을 먼저 고친다.
AI 코딩 에이전트로 작업한다면 [`CLAUDE.md`](CLAUDE.md)가 매 세션 자동으로 읽히는 요약이다.

## 시작하기

```bash
npm install
cp .env.local.example .env.local   # 값 채우기
npm run dev
```

Supabase 스키마 적용 (직결 포트 5432 — SPEC §12.2). **순서대로 넣는다:**

```bash
psql "$SUPABASE_DB_URL_DIRECT" -f supabase/schema.sql              # 테이블 · 인덱스 · 트리거
psql "$SUPABASE_DB_URL_DIRECT" -f supabase/policies.sql            # RLS
psql "$SUPABASE_DB_URL_DIRECT" -f supabase/seed.sql                # 질문 · 봇 문구 풀
psql "$SUPABASE_DB_URL_DIRECT" -f supabase/functions/advance_phase.sql  # 상태머신 · 워치독
```

전부 여러 번 돌려도 된다. `advance_phase.sql`은 pg_cron 워치독까지 등록한다 —
"pg_cron 설정 실패" 경고가 뜨면 대시보드에서 확장을 켜고 다시 돌린다. **이게 없으면 방이 멈춘다** (SPEC §12.1).

DB 검증 (Supabase 없이 로컬에서 — SPEC §14):

```bash
./supabase/test.sh    # 일회용 Postgres에 전부 올려서 §14.2 RLS 침투 · §14.3 동시성 · §14.4 다중 방 격리
```

## 폴더 소유권

자기 폴더 밖의 파일은 수정하지 않는다. 필요하면 소유자에게 요청한다 (SPEC §2).

| 경로 | 소유 |
|---|---|
| `lib/server/`, `supabase/`, `app/api/` | A — 방·페이즈 상태머신·DB |
| `lib/game/`, `lib/agent/` | B — 규칙과 에이전트 (순수 함수 / LLM) |
| `app/`(api 제외), `components/`, `mock/` | C — 화면 |
| `lib/game/types.ts` | 공동. 고치면 팀 채널에 공지 |

## 현재 상태

스캐폴딩 단계. 폴더 뼈대와 타입·스키마만 있고 로직은 대부분 `TODO(A/B/C)`다.

**AI 없이 먼저 완주시킨다 (SPEC §17).** 봇은 LLM이 아니라 DB의 문구 풀에서 말한다. 게임이 끝까지 돌아간 뒤에 그 위에 AI를 얹는다 — 지금 만드는 문구 풀은 그때 폴백 경로로 그대로 남는다(SPEC §13-5의 완료 조건이 곧 이 경로다).

구현 순서와 각 단계의 완료 조건은 **SPEC §13**에 있다. 다음 세 개가 먼저다.

1. 방 생성 · 입장
2. 페이즈 상태머신 (`advance_phase` RPC + `phase_seq` 낙관적 잠금)
3. pg_cron 안전망 — 없으면 데모 중에 방이 멈춘다

**SPEC §15(미결정 사항)**은 시작 전에 확인한다. LLM 공급자(§15-1)는 §17 때문에 당장은 아무것도 막지 않는다.
