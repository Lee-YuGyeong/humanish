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
    href: "/main",
    title: "게임 방 — 로비에서 들어간다",
    owner: "C",
    description: "방 코드는 4자 대문자다. 로비에서 만들거나 코드로 입장한다",
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
    href: "/bg-3d",
    title: "3D 배경화면",
    owner: "원상",
    description: "지하 라운지를 Three.js 로 재현 (텍스처 Higgsfield)",
    status: "작업 중",
  },
  {
    href: "/admin",
    title: "방 · 페이즈 점검",
    owner: "A",
    description: "상태머신 · DB 상태 확인용",
    status: "비어 있음",
  },
];
