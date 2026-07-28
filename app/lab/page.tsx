/**
 * 규칙 · 에이전트 실험실. 소유: B (SPEC §2)
 *
 * TODO(B): lib/game 순수 함수 입출력 확인, 봇 응답 미리보기.
 * 이 폴더(app/lab) 밖은 건드리지 않는다. LLM 호출은 app/api/agent 경유만 (SPEC I4).
 */
import Link from "next/link";

export default function LabPage() {
  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-2xl px-6 py-20">
        <Link href="/" className="stencil text-[10px] text-grime transition-colors hover:text-tung">
          ← manifest
        </Link>

        <h1 className="engraved mt-6 text-3xl font-black">규칙 · 에이전트 실험실</h1>

        <p className="cut mt-8 px-5 py-4 text-sm leading-relaxed text-grime">
          <span className="stencil mr-2 text-[10px] text-ash">todo · b</span>
          lib/game 규칙 함수 확인 · 봇 응답 미리보기
        </p>
      </div>
    </main>
  );
}
