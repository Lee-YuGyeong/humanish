#!/usr/bin/env node
/**
 * 민감 파일 접근 차단 훅 (PreToolUse)
 *
 * permissions.deny 는 Read/Edit/Write 같은 파일 도구만 막는다.
 * `cat dev.vars`, `grep KEY .dev.vars` 처럼 Bash 로 우회하는 경로는 이 훅이 막는다.
 *
 * 판정 기준 — "언급"이 아니라 "접근"만 막는다.
 *   - 파일 도구: 대상 경로(file_path / path / notebook_path)가 비밀 파일일 때만 차단.
 *     그래서 .gitignore 나 문서에 파일 이름을 적는 건 막지 않는다.
 *   - Bash: 명령 문자열에 비밀 파일명이 나오면 차단
 *     (읽기·복사·출력을 구분할 수 없으므로 전부 막는다).
 *
 * stdin : 훅 페이로드 JSON
 * 차단  : exit 2 + stderr (사유가 Claude 에게 전달된다)
 * 통과  : exit 0
 */

// 보호 대상. 새 비밀 파일이 생기면 이 두 정규식만 고친다.
const SECRET_FILE = /(^|[/\\])\.?(dev\.vars|env(\.[\w.-]+)?|secrets?\.(json|ya?ml|toml))$/i;
const SECRET_IN_COMMAND =
  /(^|[\s"'=/\\])\.?(dev\.vars|env\.[\w.-]+|secrets?\.(json|ya?ml|toml))(\s|$|["';|&)])/i;
const NOT_SECRET = /\.(example|sample|template|md)$/i;

const DENIAL = [
  "차단됨: 이 저장소의 비밀 파일은 읽거나 쓰거나 출력할 수 없습니다.",
  "",
  "- 값이 필요하면 사용자에게 직접 물어보세요.",
  "- 어떤 키가 필요한지 알아야 한다면 .env.local.example 을 읽으세요.",
  "- 새 키가 필요하면 .env.local.example 에 이름만 추가하고 사용자에게 값 입력을 요청하세요.",
].join("\n");

function deny() {
  process.stderr.write(DENIAL + "\n");
  process.exit(2);
}

function isSecretPath(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  const path = value.split("?")[0].trim();
  if (NOT_SECRET.test(path)) return false;
  return SECRET_FILE.test(path);
}

function stripSafeNames(command) {
  // `cat <비밀> <안전>.example` 같은 혼합 우회를 막기 위해
  // 안전한 파일명만 지운 뒤 남은 문자열을 검사한다.
  return command.replace(/[\w./\\-]*\.(example|sample|template)\b/gi, "");
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // 페이로드를 못 읽으면 판단하지 않는다
  }

  const tool = payload.tool_name ?? "";
  const input = payload.tool_input ?? {};

  if (tool === "Bash") {
    if (SECRET_IN_COMMAND.test(stripSafeNames(String(input.command ?? "")))) deny();
    process.exit(0);
  }

  for (const key of ["file_path", "notebook_path", "path", "glob"]) {
    if (isSecretPath(input[key])) deny();
  }

  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      if (isSecretPath(edit?.file_path)) deny();
    }
  }

  process.exit(0);
});
