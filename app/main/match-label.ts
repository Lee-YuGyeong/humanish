/**
 * 한 판을 뭐라고 부를지 · 얼마 전인지. 소유: C (SPEC §8, §15-2-결정)
 *
 * 왼쪽 기둥의 「최근 게임」(lobby.tsx)과 「기록」 탭(history-panel.tsx)이 **같은
 * 것을 읽는다.** 두 벌로 갈리면 같은 판이 두 자리에서 다른 말로 불리고, 그건
 * 고쳐도 한쪽만 고쳐진다 — 실제로 한동안 그런 상태였다 (2026-08-07 에 합쳤다).
 *
 * 순수 함수·상수뿐이라 화면 없이 검사할 수 있다.
 */

import type { MatchRecord } from "@/lib/game/types";

/**
 * 그 판이 어떻게 끝났나.
 *
 * ★ 시안에는 "인간 승리 / AI 승리(패배)" 라고 적혀 있었지만 **그대로 쓰지 않는다.**
 *   2D 판에는 팀 승패 판정이 없다 (SPEC 「게임 룰 점검 추가분」— /api/reveal 은
 *   점수만 준다). 없는 판정을 화면에서 지어내면 결과 화면과 전적이 서로 다른 말을 한다.
 *
 *   대신 채점 규칙이 이미 말하고 있는 것을 그대로 적는다 (lib/game/rules.ts):
 *     시민은 진짜 AI를 맞히면 +2, 스파이는 사람 표를 한 장이라도 받으면 +4.
 *   즉 **점수가 붙은 판 = 자기 목표를 이룬 판**이고, 그게 won 이다.
 *
 * ★ 'spy'(예전 2D 판)와 'actor'(월드 판, §18.2)는 같은 역할의 옛/새 이름이다.
 *   지난 행을 고쳐 쓰지 않아서 둘 다 오고, 화면에서는 같은 문구로 접는다.
 */
export const MATCH_LABEL: Record<MatchRecord["role"], { won: string; lost: string }> = {
  citizen: { won: "AI 적중", lost: "AI 놓침" },
  spy: { won: "연기 성공", lost: "연기 실패" },
  actor: { won: "연기 성공", lost: "연기 실패" },
};

/** 역할 이름 한 마디. 위와 같은 이유로 spy·actor 는 한 말로 접는다 */
export const ROLE_NAME: Record<MatchRecord["role"], string> = {
  citizen: "시민",
  spy: "연기자",
  actor: "연기자",
};

/**
 * 얼마 전인지. 서버가 준 ISO 문자열을 그대로 받는다.
 *
 * ★ 표시용이라 클라이언트 시계를 써도 된다 (I2 는 **페이즈 전환 판정**의 규칙이다).
 *   시계가 어긋나 미래로 나오면 '방금' 으로 접는다 — '-3분 전' 은 고장으로 보인다.
 */
export function timeAgo(iso: string, now: number): string {
  const min = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(min) || min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간 전`;
  return `${Math.floor(hour / 24)}일 전`;
}
