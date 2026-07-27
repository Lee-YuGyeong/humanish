import { execFileSync } from "node:child_process";

const HOOK = "/Users/nowonsang/humanish/.claude/hooks/deny-secrets.sh";
const S = "dev" + ".vars";
const ENVL = ".env" + ".local";

const cases = [
  // [설명, 페이로드, 기대 exit]
  ["Read 비밀파일", { tool_name: "Read", tool_input: { file_path: `/Users/nowonsang/humanish/${S}` } }, 2],
  ["Read .비밀파일", { tool_name: "Read", tool_input: { file_path: `/Users/nowonsang/humanish/.${S}` } }, 2],
  ["Read env 로컬", { tool_name: "Read", tool_input: { file_path: `/Users/nowonsang/humanish/${ENVL}` } }, 2],
  ["Bash cat 우회", { tool_name: "Bash", tool_input: { command: `cat .${S}` } }, 2],
  ["Bash 혼합 우회", { tool_name: "Bash", tool_input: { command: `cat ${S} ${ENVL}.example` } }, 2],
  ["Bash base64 우회", { tool_name: "Bash", tool_input: { command: `base64 < ./${S} | tail -1` } }, 2],
  ["Bash cp 반출", { tool_name: "Bash", tool_input: { command: `cp ${S} /tmp/x` } }, 2],
  ["Write 비밀파일", { tool_name: "Write", tool_input: { file_path: S, content: "X=1" } }, 2],
  ["Edit 비밀파일", { tool_name: "Edit", tool_input: { file_path: `./${S}` } }, 2],
  ["Grep in 비밀파일", { tool_name: "Grep", tool_input: { pattern: "KEY", path: `./.${S}` } }, 2],

  ["Read example 통과", { tool_name: "Read", tool_input: { file_path: `${ENVL}.example` } }, 0],
  ["gitignore 에 이름 적기 통과", { tool_name: "Write", tool_input: { file_path: ".gitignore", content: `${S}\n.${S}\n` } }, 0],
  ["문서에 이름 적기 통과", { tool_name: "Edit", tool_input: { file_path: "CLAUDE.md", new_string: `${S} 는 커밋하지 않는다` } }, 0],
  ["빌드 통과", { tool_name: "Bash", tool_input: { command: "npm run build" } }, 0],
  ["소스 읽기 통과", { tool_name: "Read", tool_input: { file_path: "app/page.tsx" } }, 0],
];

let failed = 0;
for (const [name, payload, expected] of cases) {
  let code = 0;
  try {
    execFileSync(HOOK, { input: JSON.stringify(payload), stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    code = e.status;
  }
  const ok = code === expected;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (exit=${code}, 기대=${expected})`);
}
console.log(failed === 0 ? "\n전부 통과" : `\n실패 ${failed}건`);
process.exit(failed === 0 ? 0 : 1);
