import { defineConfig, devices } from "@playwright/test";

const PREVIEW_PORT = Number(process.env.AGENTGROVE_E2E_PORT ?? 5174);

export default defineConfig({
  testDir: "./e2e",
  testMatch: "demos.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: `http://127.0.0.1:${PREVIEW_PORT}`,
    trace: "off",
    video: "on",
    screenshot: "off",
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm preview --port ${PREVIEW_PORT} --strictPort`,
    url: `http://127.0.0.1:${PREVIEW_PORT}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
