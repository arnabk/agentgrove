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
        HTMLDivElement: "readonly",
        HTMLInputElement: "readonly",
        HTMLSelectElement: "readonly",
        HTMLTextAreaElement: "readonly",
        HTMLButtonElement: "readonly",
        Element: "readonly",
        Node: "readonly",
        WebSocket: "readonly",
        URL: "readonly",
        Request: "readonly",
        RequestInit: "readonly",
        Headers: "readonly",
        Response: "readonly",
        fetch: "readonly",
        localStorage: "readonly",
        SubmitEvent: "readonly",
        MouseEvent: "readonly",
        KeyboardEvent: "readonly",
        RequestInfo: "readonly",
        getComputedStyle: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        performance: "readonly",
        URLSearchParams: "readonly",
        PointerEvent: "readonly",
        self: "readonly",
        queueMicrotask: "readonly",
        navigator: "readonly",
        FormData: "readonly",
        File: "readonly",
        Blob: "readonly",
        DataTransfer: "readonly",
        ClipboardEvent: "readonly",
        DragEvent: "readonly",
        HTMLImageElement: "readonly",
        Event: "readonly",
        EventTarget: "readonly",
        BroadcastChannel: "readonly",
        DOMRect: "readonly",
        ResizeObserver: "readonly",
        HTMLCanvasElement: "readonly",
        HTMLFormElement: "readonly",
        CloseEvent: "readonly",
        MessageEvent: "readonly",
        BinaryType: "readonly",
        crypto: "readonly",
        globalThis: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        AudioContext: "readonly",
        DOMParser: "readonly",
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

  // ---------------------------------------------------------------
  // Layer boundaries. These make the src/ layering enforceable rather
  // than conventional, so the desktop and mobile shells can be worked
  // on in parallel without drifting into each other.
  //
  //   core/     headless. May not import ui, features or shells.
  //   ui/       generic primitives. May not import features or shells.
  //   features/ shared domain components. May not import shells.
  //   shells/*  form-factor shells. May not import each other.
  //
  // Patterns match the trailing path so both alias ("@/shells/...")
  // and relative ("../../shells/...") specifiers are caught.
  // ---------------------------------------------------------------
  {
    files: ["src/core/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/ui/**", "@/ui/*"],
              message: "core/ is headless — it may not import from ui/.",
            },
            {
              group: ["**/features/**", "@/features/*"],
              message: "core/ is headless — it may not import from features/.",
            },
            {
              group: ["**/shells/**", "@/shells/*"],
              message: "core/ is headless — it may not import from shells/.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/features/**", "@/features/*"],
              message: "ui/ holds generic primitives — it may not import from features/.",
            },
            {
              group: ["**/shells/**", "@/shells/*"],
              message: "ui/ holds generic primitives — it may not import from shells/.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/features/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/shells/**", "@/shells/*"],
              message:
                "features/ is shared by both shells — it may not import from shells/. Pass a prop instead.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/shells/desktop/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/shells/mobile/**", "@/shells/mobile/*"],
              message: "Shells may not import each other. Promote shared code to features/ or ui/.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/shells/mobile/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/shells/desktop/**", "@/shells/desktop/*"],
              message: "Shells may not import each other. Promote shared code to features/ or ui/.",
            },
          ],
        },
      ],
    },
  },
];
