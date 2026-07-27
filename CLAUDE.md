# 사람인 척 (whois-human)

5인 채팅방에서 누가 AI인지 찾는 웹 게임. 빈자리는 AI 봇이 채우며 **그 사실은 공개되지 않는다.**
인간 중 한 명은 AI인 척해야 하는 스파이다.

상세 설계는 [`docs/SPEC.md`](docs/SPEC.md)가 유일한 기준이다. 이 파일과 어긋나면 SPEC이 맞다.

## 명령

```bash
npm run dev            # 개발 서버
npm run build          # 프로덕션 빌드 (타입 검사 포함)
npx tsc --noEmit       # 타입만 빠르게 검사
npm run lint
```

## 절대 어기면 안 되는 것

각 항목의 근거와 위반 시 증상은 SPEC 앞부분 「불변 규칙」에 있다.

1. **`is_bot`을 클라이언트로 내보내지 않는다.** 클라이언트는 `players`가 아니라 `public_players` 뷰를 읽는다. 이게 새면 게임이 즉시 끝난다.
2. **페이즈 전환 판정에 클라이언트 시계를 쓰지 않는다.** 전부 서버 `now()`. 클라이언트 카운트다운은 표시용이다.
3. **`lib/game/` 안에서 DB·네트워크·`Date.now()`·랜덤을 쓰지 않는다.** 순수 함수만.
4. **LLM API 키는 서버에서만 읽는다.** 호출 경로는 `app/api/agent/` 하나뿐이다.
5. **조기 종료 인원은 `is_bot = false`만 센다.** 봇을 포함해 세면 모든 페이즈가 시작 즉시 끝난다.
6. **`advance_phase`는 항상 `expected_seq`와 함께 부른다.** 낙관적 잠금 키다.
7. **쓰기는 전부 service role 서버 경유.** 클라이언트 anon 키는 읽기 전용이다.
8. **도메인 타입은 `lib/game/types.ts`에서만 정의한다.**
9. **모든 구독·채널·쿼리를 방으로 스코프한다.** 필터 없는 구독은 다른 방의 전환 이벤트를 받아서 엉뚱한 타이밍에 화면이 넘어간다. 구독 코드를 **처음 쓸 때** 지킨다 (SPEC §6.3, §16).

## 폴더 소유권

**자기 폴더 밖의 파일은 수정하지 않는다.** 필요하면 소유자에게 요청한다.

| 경로 | 소유 |
|---|---|
| `lib/server/`, `supabase/`, `app/api/` | **A** — 방 · 페이즈 상태머신 · DB |
| `lib/game/`, `lib/agent/` | **B** — 규칙(순수 함수) · 에이전트 |
| `app/`(api 제외), `components/`, `mock/` | **C** — 화면 |
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
| `/admin` | `app/admin/` | A — 방 · 페이즈 점검 |
| 목록 자체 | `app/workspaces.ts` | 공동. **한 줄씩만** 고친다 |

새 작업 공간은 `app/workspaces.ts`에 한 줄 추가 + `app/<경로>/page.tsx` 생성. 남의 폴더는 열지 않는다.

## 비밀 파일

`dev.vars` · `.dev.vars` · `.env*` · `secrets.*`는 **Claude가 읽지도 쓰지도 못한다.**
`.claude/settings.json`의 `permissions.deny` + `.claude/hooks/deny-secrets.mjs`(PreToolUse 훅)가 Bash 우회까지 막는다.

- 키 이름만 알아야 하면 `.env.local.example`을 읽는다. 값은 사용자에게 요청한다.
- 보호 대상을 늘리려면 `deny-secrets.mjs` 위쪽 정규식만 고치고 `node .claude/hooks/deny-secrets.test.mjs`로 확인한다.

## 작업할 때

- **손대기 전에** SPEC에서 해당 섹션을 읽는다. 섹션 번호(`§5.2` 등)는 코드 주석이 참조하므로 **재번호를 매기지 않는다.**
- **막히면 추측하지 말고 SPEC §15(미결정 사항)를 확인한다.** 거기 있는 항목은 사용자에게 물어볼 것.
- 코드를 고쳤으면 `npm run build`로 끝낸다. 타입 에러를 남기지 않는다.
- 시각은 전부 ISO 문자열로 주고받는다.
- 파일명 kebab-case, 컴포넌트 PascalCase.
