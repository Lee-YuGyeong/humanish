/**
 * 규칙 · 에이전트 실험실. 소유: B (SPEC §2)
 *
 * TODO(B): lib/game 순수 함수 입출력 확인, 봇 응답 미리보기.
 * 이 폴더(app/lab) 밖은 건드리지 않는다. LLM 호출은 app/api/agent 경유만 (SPEC I4).
 */
import Link from "next/link";

export default function LabPage() {
  return (
    <main className="min-h-screen bg-white text-neutral-900">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <Link
          href="/"
          className="text-xs text-neutral-400 transition-colors hover:text-neutral-700"
        >
          ← 작업 보드
        </Link>

        <h1 className="mt-8 text-2xl font-bold tracking-tight">
          규칙 · 에이전트 실험실
        </h1>

        <p className="mt-6 rounded-lg border border-dashed border-neutral-300 p-4 text-sm text-neutral-500">
          TODO(B): lib/game 규칙 함수 확인 · 봇 응답 미리보기
        </p>
      </div>
    </main>
  );
}
