/**
 * 랜딩 — 방 만들기 / 입장. 소유: C (SPEC §2)
 *
 * TODO(C): 방 만들기 · 코드 입력 폼. 제출은 A가 붙일 서버 액션/라우트로 보낸다.
 */
export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">사람인 척</h1>
        <p className="text-sm text-gray-500">
          5명 중 누가 AI인지 찾아낸다. 그중 한 명은 AI인 척하는 사람이다.
        </p>
      </header>

      <p className="rounded-lg border border-dashed p-4 text-sm text-gray-500">
        TODO(C): 방 만들기 · 입장 UI
      </p>
    </main>
  );
}
