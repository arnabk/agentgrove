import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--ag-bg)",
        fg: "var(--ag-fg)",
        muted: "var(--ag-muted)",
        accent: "var(--ag-accent)",
      },
    },
  },
  plugins: [],
};

export default config;
