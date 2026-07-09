import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "demos.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  timeout: 120_000,
  use: {
    baseURL: process.env.AGENTGROVE_DEMO_URL ?? "http://127.0.0.1:4320",
    trace: "off",
    video: { mode: "on", size: { width: 1440, height: 900 } },
    screenshot: "off",
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: "chromium" }],
});
