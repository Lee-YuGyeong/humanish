/**
 * 작업 보드 — 각자 자기 버튼으로 들어가서 자기 경로만 건드린다.
 *
 * 게임 화면이 아니다. 실제 진입은 /intro → /main 이다.
 * 목록은 app/workspaces.ts 에서 관리한다.
 *
 * 배경은 app/layout.tsx 가 깐 .room-backdrop 이 맡는다. 여기서 배경색을 칠하지 않는다.
 */
import Link from "next/link";
import { workspaces } from "./workspaces";

const statusStyle: Record<string, string> = {
  "작업 중": "border-lamp/30 bg-lamp/10 text-lamp",
  "비어 있음": "border-bone/10 bg-bone/5 text-grime",
  완료: "border-door/30 bg-door/10 text-door",
};

export default function Home() {
  return (
    <main className="min-h-screen text-bone">
      <div className="mx-auto max-w-3xl px-6 py-20">
        <header className="space-y-3">
          <p className="font-mono text-xs tracking-[0.3em] text-blood/70">
            WORKBOARD
          </p>
          <h1 className="text-3xl font-bold tracking-tight">기계인 척 — 작업 보드</h1>
          <p className="text-sm text-dust">
            자기 버튼으로 들어가서 <span className="text-bone">그 경로 폴더만</span>{" "}
            수정한다. 남의 경로를 고치면 머지 충돌이 난다.
          </p>
        </header>

        <ul className="mt-10 space-y-3">
          {workspaces.map((ws) => (
            // href가 아니라 title을 key로 쓴다. 두 항목이 같은 경로를 가리킬 수 있다
            // (게임 방은 /main 을 거쳐 들어간다). href를 key로 두면 중복 key가 된다.
            <li key={ws.title}>
              <Link
                href={ws.href}
                className="panel group flex items-center gap-4 rounded-xl p-5 transition-colors hover:border-lamp/30 hover:bg-lamp/5"
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
                  <p className="mt-1 truncate text-sm text-dust">
                    {ws.description}
                  </p>
                  <p className="mt-2 font-mono text-xs text-grime">
                    {ws.href}
                    <span className="ml-3 text-ash">담당 {ws.owner}</span>
                  </p>
                </div>
                <span className="text-ash transition-transform group-hover:translate-x-1 group-hover:text-lamp">
                  →
                </span>
              </Link>
            </li>
          ))}
        </ul>

        <p className="mt-10 text-xs text-grime">
          새 작업 공간이 필요하면 app/workspaces.ts 에 한 줄 추가하고 app/&lt;경로&gt;/page.tsx 를 만든다.
        </p>
      </div>
    </main>
  );
}
