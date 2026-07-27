/**
 * 게임 화면 — 페이즈에 따라 분기. 소유: C (SPEC §2)
 *
 * TODO(C): 페이즈별 화면 분기, Realtime 구독, visible_at 기준 지연 렌더 (SPEC §6).
 * 카운트다운은 서버 시각 오프셋으로 계산한다. 표시용일 뿐 판정은 서버가 한다 (SPEC §12.5).
 */
export default async function RoomPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-8">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">방 {code.toUpperCase()}</h1>
        <span className="text-sm text-gray-500">lobby</span>
      </header>

      <p className="rounded-lg border border-dashed p-4 text-sm text-gray-500">
        TODO(C): 페이즈별 화면
      </p>
    </main>
  );
}
