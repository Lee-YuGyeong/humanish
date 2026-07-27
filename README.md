# 사람인 척 (whois-human)

5인 채팅방에서 누가 AI인지 찾는 웹 게임. 빈자리는 AI 봇이 채우며 그 사실은 공개되지 않는다.
인간 중 한 명은 AI인 척해야 하는 스파이다.

기술 설계는 [`docs/SPEC.md`](docs/SPEC.md)가 유일한 기준이다. 코드와 어긋나면 SPEC을 먼저 고친다.

## 시작하기

```bash
npm install
cp .env.local.example .env.local   # 값 채우기
npm run dev
```

Supabase 스키마 적용 (직결 포트 5432 — SPEC §12.2):

```bash
psql "$SUPABASE_DB_URL_DIRECT" -f supabase/schema.sql
psql "$SUPABASE_DB_URL_DIRECT" -f supabase/policies.sql
```

## 폴더 소유권

자기 폴더 밖의 파일은 수정하지 않는다. 필요하면 소유자에게 요청한다 (SPEC §2).

| 경로 | 소유 |
|---|---|
| `lib/server/`, `supabase/`, `app/api/` | A — 방·페이즈 상태머신·DB |
| `lib/game/`, `lib/agent/` | B — 규칙과 에이전트 (순수 함수 / LLM) |
| `app/`, `components/`, `mock/` | C — 화면 |
| `lib/game/types.ts` | 공동. 고치면 팀 채널에 공지 |

## 현재 상태

스캐폴딩 단계. 폴더 뼈대와 타입·스키마만 있고 로직은 대부분 `TODO(A/B/C)`다.

다음 순서 (SPEC §12.7):

1. 페이즈 상태머신 (`advance_phase` RPC + `phase_seq` 낙관적 잠금)
2. pg_cron 안전망 — 없으면 데모 중에 방이 멈춘다
3. LLM 타임아웃 + 폴백
