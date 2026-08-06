/**
 * 작업 보드 목록. `/` 에서 버튼으로 렌더된다.
 *
 * 규칙: **한 사람이 한 경로를 소유한다.** 자기 경로 폴더 밖의 파일은 건드리지 않는다.
 * 새 작업 공간이 필요하면 여기에 한 줄 추가하고 `app/<경로>/page.tsx` 를 만든다.
 * (이 파일은 공동 소유다. 한 줄씩만 고쳐서 충돌을 줄인다)
 */
export type Workspace = {
  href: string;
  title: string;
  owner: string;
  description: string;
  status: "작업 중" | "비어 있음" | "완료";
};

export const workspaces: Workspace[] = [
  {
    href: "/intro",
    title: "인트로",
    owner: "원상",
    description: "게임 제목 · 역할 소개 카드",
    status: "작업 중",
  },
  {
    href: "/main",
    title: "메인 로비",
    owner: "C",
    description: "공개 대기방 목록 · 방 만들기 (목업 데이터)",
    status: "작업 중",
  },
  {
    href: "/lab",
    title: "규칙 · 에이전트 실험실",
    owner: "B",
    description: "lib/game 순수 함수와 봇 응답 확인",
    status: "비어 있음",
  },
  {
    href: "/world",
    title: "3D 월드 (멀티플레이)",
    owner: "원상",
    description: "창고 라운지에서 같은 방 사람들이 걸어다닌다 (worker/ 를 같이 띄울 것)",
    status: "작업 중",
  },
  {
    href: "/admin",
    title: "방 · 페이즈 점검",
    owner: "A",
    description: "방마다 페이즈 · phase_seq · 남은 시간 · 시계 어긋남",
    status: "작업 중",
  },
  {
    // 실제 게임을 순서대로 도는 문. 01(인트로)과 같은 경로지만 목적이 다르다 —
    // 01 은 인트로 "화면"의 작업 버튼이고, 이건 게임 전체 흐름의 입구다.
    // 흐름: 인트로 → 게임 접속하기(구글 로그인) → 메인 로비 → 대기실(전원 준비
    // + 방장 시작) → 3D 월드(역할 카드).
    href: "/intro",
    title: "게임 시작",
    owner: "공동",
    description: "인트로 → 로그인 → 로비 → 대기실 → 3D 월드까지 실제 게임 흐름",
    status: "작업 중",
  },
];
