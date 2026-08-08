/**
 * 첫 화면 = 인트로 (2026-08-08).
 *
 * 예전에는 여기가 작업 보드(팀 내부용 진입 버튼 목록)였다. 인트로를 첫 화면으로
 * 쓰기로 하면서 보드는 통째로 없앴다 — 목록 파일(app/workspaces.ts)까지 지웠으니
 * 되살리려면 git 이력에서 꺼낸다. 각 화면(/lab · /admin · /world)의 「← intro」가
 * 보드로 돌아가던 자리를 대신한다.
 *
 * 인트로를 여기로 통째로 옮기지 않고 리다이렉트만 두는 이유: 인트로는 페이지 하나가
 * 아니라 폴더 한 벌이다 (intro.module.css · cast.tsx · rules.tsx, 그리고 #about ·
 * #roles 앵커). 복사하면 두 벌이 되고, 한쪽만 고치는 순간 갈린다.
 *
 * 서버 리다이렉트라 화면이 한 번 깜빡이지 않는다 (클라이언트 라우팅이 아니다).
 */
import { redirect } from "next/navigation";

export default function Home() {
  redirect("/intro");
}
