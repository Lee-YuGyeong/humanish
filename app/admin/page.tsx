/**
 * 방 · 페이즈 점검. 소유: A (SPEC §2)
 *
 * TODO(A): 방 상태 · phase_seq · 전환 이력 확인용 내부 화면.
 * 이 폴더(app/admin) 밖은 건드리지 않는다.
 * is_bot 은 이 화면에도 내리지 않는다 — 클라이언트 번들에 실린다 (SPEC I1).
 */
import Link from "next/link";

export default function AdminPage() {
  return (
    <main className="min-h-screen bg-white text-neutral-900">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <Link
          href="/"
          className="text-xs text-neutral-400 transition-colors hover:text-neutral-700"
        >
          ← 작업 보드
        </Link>

        <h1 className="mt-8 text-2xl font-bold tracking-tight">방 · 페이즈 점검</h1>

        <p className="mt-6 rounded-lg border border-dashed border-neutral-300 p-4 text-sm text-neutral-500">
          TODO(A): 방 상태 · phase_seq · 전환 이력
        </p>
      </div>
    </main>
  );
}
