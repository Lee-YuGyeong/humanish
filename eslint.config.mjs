import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      // OpenNext 가 Workers 용으로 다시 묶은 산출물 (npm run app:build).
      // 남이 만든 번들이라 검사할 것도, 고칠 수도 없다.
      ".open-next/**",
      "worker/node_modules/**",
      // npm run test:coverage 의 HTML 리포트. 남이 만든 산출물이다.
      "coverage/**",
    ],
  },
  {
    // worker/ 도 여기서 검사한다 (2026-08-08). 예전엔 통째로 ignore 였는데
    // 4,700줄이 lint 사각지대로 남았다. **설정을 두 벌로 나누지 않는다** —
    // lib/mp/ 를 한 곳에만 두는 이유와 같다. 한쪽에 복붙하면 그 순간 갈린다.
    // 타입은 여전히 worker/tsconfig.json 이 따로 본다 (npm run world:typecheck).
    files: ["worker/**/*.ts"],
    rules: {
      // Workers 진입점 `export default { fetch }` 는 런타임이 요구하는 모양이다.
      "import/no-anonymous-default-export": "off",
    },
  },
  {
    // 타입을 읽어야만 잡히는 규칙들. worker/ 는 루트 tsconfig 의 exclude 대상이라
    // projectService 가 파일을 못 찾고 파서가 죽는다 — 반드시 제외한다.
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["worker/**"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // 기다리지 않은 약속은 조용히 실패한다. 이 앱에서 그건 "페이즈가 안 넘어간다"로 보인다.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },
  {
    rules: {
      // 아직 구현 전인 함수의 시그니처를 유지하기 위해 _ 접두사 인자를 허용한다.
      // 시그니처가 SPEC §8 · §9의 계약이라 인자를 지울 수 없다.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
];

export default eslintConfig;
