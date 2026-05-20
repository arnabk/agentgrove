import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--ag-bg)",
        "bg-1": "var(--ag-bg-1)",
        "bg-2": "var(--ag-bg-2)",
        "bg-3": "var(--ag-bg-3)",
        "bg-4": "var(--ag-bg-4)",
        fg: "var(--ag-fg)",
        "fg-muted": "var(--ag-fg-muted)",
        "fg-subtle": "var(--ag-fg-subtle)",
        border: "var(--ag-border)",
        "border-strong": "var(--ag-border-strong)",
        accent: "var(--ag-accent)",
        "accent-hover": "var(--ag-accent-hover)",
        "accent-soft": "var(--ag-accent-soft)",
        success: "var(--ag-success)",
        warning: "var(--ag-warning)",
        danger: "var(--ag-danger)",
      },
      // font-sans / font-mono utilities consume the CSS variables set by
      // applySettings(), so changing the chosen UI / code font in Settings
      // propagates everywhere without rebuilding Tailwind classes.
      fontFamily: {
        sans: ["var(--ag-font-ui)"],
        mono: ["var(--ag-font-mono)"],
      },
      borderRadius: {
        DEFAULT: "8px",
        sm: "6px",
      },
    },
  },
  plugins: [],
};

export default config;
