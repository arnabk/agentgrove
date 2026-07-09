import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "demo-capture.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  timeout: 120_000,
  use: {
    baseURL: process.env.AGENTGROVE_DEMO_URL ?? "http://127.0.0.1:4320",
    headless: false,
    trace: "off",
    video: "off",
    screenshot: "off",
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      args: ["--window-size=1440,900", "--window-position=0,25"],
    },
  },
  projects: [{ name: "chromium" }],
});
