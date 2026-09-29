import { defineConfig, devices } from "@playwright/test";

// Mode selector:
//   PW_LIVE=1   → use BASE_URL provided by the caller (verify.sh), do not
//                 spawn a web server.
//   default     → spawn `pnpm preview` on AGENTGROVE_E2E_PORT (CI / local).
const LIVE = process.env.PW_LIVE === "1";
const PREVIEW_PORT = Number(process.env.AGENTGROVE_E2E_PORT ?? 5193);
const liveBase = process.env.BASE_URL ?? "http://localhost:5173";
const baseURL = LIVE ? liveBase : `http://127.0.0.1:${PREVIEW_PORT}`;

// Browser channel. Default is Playwright's bundled Chromium, which is
// what CI installs. Set PW_CHANNEL=chrome to drive a locally-installed
// Google Chrome instead — needed on networks whose TLS interception
// blocks `playwright install`.
const channel = process.env.PW_CHANNEL;
const channelUse = channel ? { channel } : {};

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
    // Video needs Playwright's bundled ffmpeg. PW_NO_VIDEO=1 skips it for
    // local runs on machines where `playwright install` can't fetch it.
    video: process.env.PW_NO_VIDEO === "1" ? "off" : "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], ...channelUse },
      testIgnore: /mobile-.*\.spec\.ts/,
    },
    {
      // Phone form factor: real touch, real DPR, real mobile UA, so the
      // mobile shell is exercised the way a phone exercises it rather
      // than as a narrow desktop window.
      name: "mobile",
      use: { ...devices["Pixel 7"], ...channelUse },
      testMatch: /mobile-.*\.spec\.ts/,
    },
  ],
  ...(webServer ? { webServer } : {}),
});
