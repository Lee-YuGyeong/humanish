/**
 * 3D 배경화면 — 레퍼런스 창고 시네마 라운지를 Three.js 로 세운 전체화면 씬.
 *
 * 씬 구현은 ./room-scene.tsx 에 있다.
 * 이 폴더(app/bg-3d) 밖은 건드리지 않는다.
 */
import dynamic from "next/dynamic";
import Link from "next/link";

// WebGL 캔버스는 서버에서 렌더할 수 없다. 클라이언트에서만 띄운다.
const RoomScene = dynamic(() => import("./room-scene"), {
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-[#07050a]">
      <p className="font-mono text-[11px] tracking-widest text-neutral-600">
        LOADING ROOM...
      </p>
    </div>
  ),
});

export default function Bg3dPage() {
  return (
    <main className="relative h-screen w-full overflow-hidden bg-[#07050a]">
      <RoomScene />

      <header className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-4 p-6">
        <div>
          <Link
            href="/"
            className="pointer-events-auto text-xs text-neutral-500 transition-colors hover:text-neutral-200"
          >
            ← 작업 보드
          </Link>
          <h1 className="mt-2 text-2xl font-black tracking-tight text-neutral-200 drop-shadow-[0_2px_12px_rgba(0,0,0,0.9)]">
            3D 배경화면
          </h1>
          <p className="mt-1 max-w-md text-xs leading-relaxed text-neutral-500">
            사진을 붙인 판이 아니라 바닥·벽·박공지붕·트러스·가구가 각각 놓인
            창고입니다. 벽 · 바닥 · 박스 텍스처는 Higgsfield 로 뽑아 타일링했습니다.
          </p>
        </div>

        <dl className="hidden gap-6 text-[11px] sm:flex">
          <div>
            <dt className="text-neutral-600">렌더</dt>
            <dd className="font-mono text-neutral-300">Three.js · R3F</dd>
          </div>
          <div>
            <dt className="text-neutral-600">텍스처</dt>
            <dd className="font-mono text-neutral-300">Higgsfield 3장</dd>
          </div>
        </dl>
      </header>
    </main>
  );
}
