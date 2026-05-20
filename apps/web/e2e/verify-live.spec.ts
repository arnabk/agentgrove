// Live verification: runs against the BE + FE launched by scripts/verify.sh.
// BASE_URL points to the FE. AGENTGROVE_BE_URL points to the BE.
//
// There is no auth in this build. The FE talks to the BE directly via the
// `ag-be` localStorage entry we seed before navigation.

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const BE_URL = process.env.AGENTGROVE_BE_URL ?? "http://127.0.0.1:4317";
const REPO_ROOT = process.env.REPO_ROOT ?? process.cwd();

async function seedBackend(page: import("@playwright/test").Page) {
  await page.addInitScript((beUrl) => {
    localStorage.setItem("ag-be", beUrl);
  }, BE_URL);
}

test.describe("live app", () => {
  test("loads straight into the shell (no login)", async ({ page }) => {
    await seedBackend(page);
    await page.goto(BASE);
    await expect(page.getByTestId("app-root")).toBeVisible({ timeout: 15_000 });
  });

  test("welcome → add project → indicators", async ({ page }) => {
    const visualDir = path.join(REPO_ROOT, ".data", "logs", "visuals");
    fs.mkdirSync(visualDir, { recursive: true });
    const shot = (name: string) =>
      page.screenshot({ path: path.join(visualDir, `${name}.png`), fullPage: true });

    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
    });

    await seedBackend(page);
    await page.goto(BASE, { waitUntil: "networkidle" });

    // 1. Welcome screen visible when there are no projects.
    await expect(page.getByTestId("app-root")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("welcome")).toBeVisible();
    await shot("01-welcome");

    // 2. Top-right connected indicator present.
    await expect(page.getByTestId("indicator-connected")).toBeVisible();

    // 3. Add a project using the welcome dialog.
    await page.getByTestId("welcome-add-folder").click();
    await page.getByTestId("welcome-name").fill("self");
    await page.getByTestId("welcome-root").fill(REPO_ROOT);
    await page.getByTestId("welcome-submit").click();

    // 4. Left rail + tabs appear once a project exists.
    await expect(page.getByTestId("left-rail")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("pane-tabs")).toBeVisible();
    await shot("02-shell");

    // 5. No console errors.
    expect(errors, errors.join("\n")).toHaveLength(0);
  });
});
