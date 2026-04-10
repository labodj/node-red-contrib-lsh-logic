import path from "node:path";
import { fileURLToPath } from "node:url";

import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import jestPlugin from "eslint-plugin-jest";
import globals from "globals";
import tseslint from "typescript-eslint";

const tsconfigRootDir = path.dirname(fileURLToPath(import.meta.url));
const jestRecommended = jestPlugin.configs["flat/recommended"];

export default tseslint.config(
  {
    ignores: [".cache/**", "coverage/**", "dist/**", "node_modules/**", "src/generated/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        project: "./tsconfig.typecheck.json",
        tsconfigRootDir,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          fixStyle: "separate-type-imports",
          prefer: "type-imports",
        },
      ],
      "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksVoidReturn: {
            attributes: false,
          },
        },
      ],
    },
  },
  {
    ...jestRecommended,
    files: ["src/__tests__/**/*.ts"],
    languageOptions: {
      ...jestRecommended.languageOptions,
      globals: {
        ...globals.node,
        ...globals.jest,
        ...jestRecommended.languageOptions?.globals,
      },
      parserOptions: {
        project: "./tsconfig.typecheck.json",
        tsconfigRootDir,
      },
    },
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },
  eslintConfigPrettier,
);
