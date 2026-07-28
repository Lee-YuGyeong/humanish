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
      // 워커는 Next가 아니라 Cloudflare 런타임이다. 자체 tsconfig로 검사한다
      // (worker/ 에서 npm run typecheck).
      "worker/**",
    ],
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
