# 제출 문서 (PDF) 만드는 법

저장소 루트의 제출용 PDF 3종은 **HTML을 헤드리스 Chrome으로 인쇄해서** 만든다.
PDF는 산출물이고, **고칠 때는 언제나 여기 HTML을 고친 뒤 다시 인쇄한다.**

| 문서 | HTML 소스 | 에셋 | 결과 PDF |
|---|---|---|---|
| 팀 소개 및 역할 분담 | `docs/team-intro.html` | 없음 | `팀 소개 문서 v2.pdf` |
| 게임 소개 및 설명 | `docs/game-intro.html` | `docs/game-intro/` (스크린샷 15장) | `게임 소개 및 설명 문서.pdf` |
| AI 활용 기술 문서 | `docs/ai-usage.html` | 없음 | `AI 활용 기술 문서.pdf` |

원본 PDF들은 소스가 남아 있지 않아 **렌더링·색·폰트를 실측해 HTML로 복원**한 것이다.
`game-intro/`의 이미지는 원본 PDF에 박혀 있던 JPEG를 그대로 뽑은 것이라 재촬영·재압축이 없다.

## 인쇄

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

"$CHROME" --headless --disable-gpu \
  --print-to-pdf="팀 소개 문서 v2.pdf" --no-pdf-header-footer \
  "file://$PWD/docs/team-intro.html"

"$CHROME" --headless --disable-gpu \
  --print-to-pdf="게임 소개 및 설명 문서 v2.pdf" --no-pdf-header-footer \
  "file://$PWD/docs/game-intro.html"

"$CHROME" --headless --disable-gpu \
  --print-to-pdf="AI 활용 기술 문서 v2.pdf" --no-pdf-header-footer \
  "file://$PWD/docs/ai-usage.html"
```

- **`--no-pdf-header-footer` 를 빼지 않는다.** 빼면 Chrome이 페이지마다 날짜·URL을 얹는다.
- `file://` 절대경로로 연다. 상대경로로 열면 이미지(`game-intro/*.jpg`)를 못 찾는다.
- 이미지가 있는 문서는 `--virtual-time-budget=8000` 을 붙이면 로딩 경합이 사라진다.

## 페이지가 넘치지 않는지 확인

세 HTML 모두 **A4 고정 레이아웃**이다 — `@page{size:A4;margin:0}` 에 `.page{height:297mm;overflow:hidden}`.
즉 내용이 넘치면 잘려 나가고 **인쇄물에는 조용히 사라진다.** 문구를 고쳤으면 반드시 확인한다.

브라우저로 HTML을 열고 콘솔에 붙여넣으면 페이지별 넘침(px)이 나온다. 전부 `0` 이어야 한다.

```js
[...document.querySelectorAll('.page')].map((p, i) =>
  ({ page: i + 1, overflow: p.scrollHeight - p.clientHeight }))
```

넘치면 폰트 크기가 아니라 **여백부터** 줄인다 (`td` 패딩 → 섹션 `margin-top` → 카드 패딩 순).

## 공통 규약

- **폰트**: `"Helvetica Neue", "Apple SD Gothic Neo"` + `Menlo`(코드·라벨). 원본 PDF에 박혀 있던 것과 같아서, **이 맥에서 인쇄해야** 글자가 원본과 일치한다. 웹폰트는 쓰지 않는다.
- **색**: 원본에서 추출한 값을 `:root` 변수로 둔다. 문서마다 초록이 다르다 — 게임 문서는 `#01A344`(본문)/`#01FF66`(표지), AI 문서는 `#00854A`(배지)/`#E9F7F0`(강조 행)/`#A8571A`(주황 콜아웃).
- **단위**: 레이아웃은 `mm`, 글자는 `pt`. `px` 를 섞으면 인쇄에서 어긋난다.
- 그림은 페이지 안에서 `object-fit:cover` 로 높이를 맞춘 곳이 있다(`game-intro.html` 의 `.shots.norm`). 원본이 서로 다른 비율의 캡처를 같은 높이로 잘라 쓴 것을 따라간 것이다.

## 알려진 것

`game-intro.html` 1쪽 콜아웃의 "(7쪽 「AI를 숨기는 설계」)" 는 **그 문서에 없는 쪽을 가리킨다**(쪽 번호가 6까지). 원본 PDF에 있던 것을 그대로 옮겼다.
