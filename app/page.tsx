/**
 * 작업 보드 — 각자 자기 버튼으로 들어가서 자기 경로만 건드린다.
 *
 * 게임 화면이 아니다. 실제 진입은 /intro → /main 이다.
 * 목록은 app/workspaces.ts 에서 관리한다.
 */
import Link from "next/link";
import { workspaces } from "./workspaces";

const statusStyle: Record<string, string> = {
  "작업 중": "border-sky-200 bg-sky-50 text-sky-700",
  "비어 있음": "border-neutral-200 bg-neutral-50 text-neutral-500",
  완료: "border-teal-200 bg-teal-50 text-teal-700",
};

export default function Home() {
  return (
    <main className="min-h-screen bg-white text-neutral-900">
      <div className="mx-auto max-w-3xl px-6 py-20">
        <header className="space-y-3">
          <p className="font-mono text-xs tracking-[0.3em] text-neutral-400">
            WORKBOARD
          </p>
          <h1 className="text-3xl font-bold tracking-tight">기계인 척 — 작업 보드</h1>
          <p className="text-sm text-neutral-500">
            자기 버튼으로 들어가서 <span className="text-neutral-900">그 경로 폴더만</span>{" "}
            수정한다. 남의 경로를 고치면 머지 충돌이 난다.
          </p>
        </header>

        <ul className="mt-10 space-y-3">
          {workspaces.map((ws) => (
            <li key={ws.href}>
              <Link
                href={ws.href}
                className="group flex items-center gap-4 rounded-xl border border-neutral-200 bg-white p-5 transition-colors hover:border-neutral-400 hover:bg-neutral-50"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{ws.title}</span>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[11px] ${
                        statusStyle[ws.status] ?? statusStyle["비어 있음"]
                      }`}
                    >
                      {ws.status}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-sm text-neutral-500">
                    {ws.description}
                  </p>
                  <p className="mt-2 font-mono text-xs text-neutral-400">
                    {ws.href}
                    <span className="ml-3 text-neutral-300">담당 {ws.owner}</span>
                  </p>
                </div>
                <span className="text-neutral-300 transition-transform group-hover:translate-x-1 group-hover:text-neutral-600">
                  →
                </span>
              </Link>
            </li>
          ))}
        </ul>

        <p className="mt-10 text-xs text-neutral-400">
          새 작업 공간이 필요하면 app/workspaces.ts 에 한 줄 추가하고 app/&lt;경로&gt;/page.tsx 를 만든다.
        </p>
      </div>
    </main>
  );
}
