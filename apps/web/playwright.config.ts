import { defineConfig, devices } from "@playwright/test";

// Mode selector:
//   PW_LIVE=1   → use BASE_URL provided by the caller (verify.sh), do not
//                 spawn a web server.
//   default     → spawn `pnpm preview` on AGENTGROVE_E2E_PORT (CI / local).
const LIVE = process.env.PW_LIVE === "1";
const PREVIEW_PORT = Number(process.env.AGENTGROVE_E2E_PORT ?? 5193);
const liveBase = process.env.BASE_URL ?? "http://localhost:5173";
const baseURL = LIVE ? liveBase : `http://127.0.0.1:${PREVIEW_PORT}`;

const webServer = LIVE
  ? undefined
  : {
      command: "pnpm preview --port " + PREVIEW_PORT + " --strictPort",
      url: `http://127.0.0.1:${PREVIEW_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    };

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  ...(process.env.CI ? { workers: 1 } : {}),
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  ...(webServer ? { webServer } : {}),
});
