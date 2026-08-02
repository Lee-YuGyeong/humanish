/**
 * 작업 보드 — 각자 자기 버튼으로 들어가서 자기 경로만 건드린다.
 *
 * 게임 화면이 아니다. 실제 진입은 /intro 의 「게임 접속하기」이고, 그 버튼이
 * 로그인을 건다 (components/play-button.tsx, SPEC §15-2-결정).
 *
 * ★ 이 보드는 로그인을 요구하지 않는다. 팀 내부용이라 계정과 무관하게 열려야 한다.
 *   벽은 그 버튼 뒤에 있고, /main · /room 은 RequireLogin 이 다시 지킨다.
 * 목록은 app/workspaces.ts 에서 관리한다.
 *
 * 창고에 쌓인 플라이트 케이스 더미로 읽히게 뒀다 — 번호가 찍힌 상자가 줄지어 있고
 * 상태등이 하나씩 붙어 있는 모양. 배경은 app/layout.tsx 의 .room 이 맡으므로
 * 여기서 배경색을 칠하지 않는다.
 */
import Link from "next/link";
import { workspaces } from "./workspaces";

/** 상태등. 색이 아니라 **번짐**으로 켜졌음을 알린다 (globals.css의 .lit-*) */
const lamp: Record<string, { dot: string; text: string; label: string }> = {
  "작업 중": { dot: "bg-tung shadow-[0_0_10px_2px] shadow-tung/60", text: "text-tung", label: "RUNNING" },
  "비어 있음": { dot: "bg-ash", text: "text-grime", label: "EMPTY" },
  완료: { dot: "bg-flare shadow-[0_0_10px_2px] shadow-flare/50", text: "text-flare", label: "DONE" },
};

export default function Home() {
  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-3xl px-6 py-20">
        <header>
          <p className="stencil text-[10px] text-signal/70">crate manifest</p>
          <h1 className="engraved mt-3 text-4xl font-black">AI인 척</h1>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-dust">
            작업 보드다. 자기 상자만 연다 —{" "}
            <span className="text-bone">남의 경로를 고치면 머지 충돌이 난다.</span>
          </p>
        </header>

        <ol className="mt-12 space-y-px">
          {workspaces.map((ws, i) => {
            const s = lamp[ws.status] ?? lamp["비어 있음"];
            return (
              // href가 아니라 title을 key로 쓴다. 두 항목이 같은 경로를 가리킬 수 있다
              // (게임 방은 /main 을 거쳐 들어간다). href를 key로 두면 중복 key가 된다.
              <li key={ws.title}>
                <Link
                  href={ws.href}
                  className="case case-live riveted group flex items-center gap-5 px-7 py-4"
                >
                  {/* 상자 번호 — 스텐실로 찍힌 일련번호 */}
                  <span className="readout w-8 shrink-0 text-lg text-ash transition-colors group-hover:text-tung/70">
                    {String(i + 1).padStart(2, "0")}
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2.5">
                      <span className="truncate font-semibold text-bone">{ws.title}</span>
                      <span className={`stencil shrink-0 text-[9px] ${s.text}`}>{s.label}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-[13px] text-grime">
                      {ws.description}
                    </span>
                  </span>

                  {/*
                    ws.owner(담당자 이름)는 화면에 찍지 않는다. 폴더 소유권을 정하는
                    팀 내부 값이지 게임 화면에 나올 정보가 아니다. 값 자체는
                    app/workspaces.ts 에 그대로 있고 CLAUDE.md 의 소유권 표가 참조한다.
                  */}
                  <span className="hidden shrink-0 text-right sm:block">
                    <span className="block font-mono text-[11px] text-ash">{ws.href}</span>
                  </span>

                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} aria-hidden />
                </Link>
              </li>
            );
          })}
        </ol>

        <p className="mt-10 border-t border-bone/5 pt-5 text-xs leading-relaxed text-ash">
          새 작업 공간은 app/workspaces.ts 에 한 줄 추가하고 app/&lt;경로&gt;/page.tsx 를 만든다.
        </p>
      </div>
    </main>
  );
}
