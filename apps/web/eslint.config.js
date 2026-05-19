import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import solid from "eslint-plugin-solid";
import js from "@eslint/js";

export default [
  {
    ignores: ["dist", "node_modules", "coverage", "playwright-report", "test-results"],
  },
  js.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
      globals: {
        window: "readonly",
        document: "readonly",
        console: "readonly",
        process: "readonly",
        HTMLElement: "readonly",
        getComputedStyle: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      solid,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...solid.configs.typescript.rules,
    },
  },
];
