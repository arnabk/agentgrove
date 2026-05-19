// Live verification: runs against the BE + FE launched by scripts/verify.sh.
// BASE_URL points to the FE. AGENTGROVE_TOKEN provides the bearer token.
// AGENTGROVE_BE_URL points to the BE (so the FE talks to it cross-origin).

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const TOKEN = process.env.AGENTGROVE_TOKEN ?? "";
const BE_URL = process.env.AGENTGROVE_BE_URL ?? "http://127.0.0.1:4317";
const REPO_ROOT = process.env.REPO_ROOT ?? process.cwd();

async function seedToken(page: import("@playwright/test").Page) {
  await page.addInitScript(
    ({ token, beUrl }) => {
      localStorage.setItem("ag-token", token);
      // The client picks up VITE_API_URL only at build time; for dev, the
      // client defaults to http://127.0.0.1:4317 when on port 5173.
      // Persist BE override for any future use.
      localStorage.setItem("ag-be", beUrl);
    },
    { token: TOKEN, beUrl: BE_URL },
  );
}

test.describe("live app", () => {
  test("login form shows without token", async ({ page }) => {
    await page.goto(BASE);
    await expect(page.getByTestId("login-form")).toBeVisible();
  });

  test("authenticated shell renders all panes and feature flows work", async ({ page }) => {
    const visualDir = path.join(REPO_ROOT, ".data", "logs", "visuals");
    fs.mkdirSync(visualDir, { recursive: true });
    const shot = (name: string) =>
      page.screenshot({ path: path.join(visualDir, `${name}.png`), fullPage: true });

    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
    });

    await seedToken(page);
    await page.goto(BASE, { waitUntil: "networkidle" });

    // 1. Shell appears (left rail + tabs).
    await expect(page.getByTestId("app-root")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("left-rail")).toBeVisible();
    await expect(page.getByTestId("pane-tabs")).toBeVisible();
    await shot("01-shell");

    // 2. Theme picker has 4 options.
    const themes = page.getByTestId("theme-picker").locator("option");
    await expect(themes).toHaveCount(4);

    // 3. Create a project pointing at the repo itself (which is a git repo).
    await page.getByTestId("add-project-btn").click();
    await page.getByTestId("new-project-name").fill("self");
    await page.getByTestId("new-project-root").fill(REPO_ROOT);
    await page.getByTestId("new-project-submit").click();
    await expect(page.locator('[data-testid^="project-"]').first()).toBeVisible();
    await shot("02-project-created");

    // 4. Create a worktree on a new branch.
    await page.getByTestId("add-worktree-btn").click();
    await page.getByTestId("new-worktree-branch").fill(`e2e-${Date.now()}`);
    await page.getByTestId("new-worktree-pre").fill("echo prescript-ran");
    await page.getByTestId("new-worktree-submit").click();
    await expect(page.locator('[data-testid^="worktree-"]').first()).toBeVisible({
      timeout: 30_000,
    });
    await shot("03-worktree-created");

    // 5. Create a chat.
    await page.getByTestId("add-chat-btn").click();
    await page.getByTestId("new-chat-title").fill("hello chat");
    await page.getByTestId("new-chat-submit").click();
    await expect(page.locator('[data-testid^="chat-"]').first()).toBeVisible();
    await shot("04-chat-created");

    // 6. Send a prompt via Chat pane.
    await page.getByTestId("tab-chat").click();
    await page.getByTestId("chat-input").fill("hi there");
    await page.getByTestId("chat-send").click();
    await expect(page.locator('[data-testid^="prompt-"]').first()).toBeVisible({
      timeout: 10_000,
    });
    await shot("05-chat-prompt");

    // 7. Revert button creates a follow-up prompt.
    page.once("dialog", (d) => d.accept());
    await page.locator('[data-testid^="revert-"]').first().click();
    await expect(page.locator('[data-testid^="prompt-"]')).toHaveCount(2);
    await shot("06-chat-revert");

    // 8. Editor: write+read a temp file inside the repo.
    await page.getByTestId("tab-editor").click();
    const tmpFile = path.join(REPO_ROOT, ".data", "e2e-edit.txt");
    fs.writeFileSync(tmpFile, "old content");
    await page.getByTestId("editor-path").fill(tmpFile);
    await page.getByTestId("editor-open").click();
    // CodeMirror renders its content asynchronously; wait for the host
    // to acquire a child node.
    await page.getByTestId("editor-host").locator(".cm-editor").waitFor();
    await shot("07-editor-loaded");

    // 9. Diff pane opens.
    await page.getByTestId("tab-diff").click();
    await page.getByTestId("diff-path").fill(tmpFile);
    await page.getByTestId("diff-open").click();
    await expect(page.getByTestId("diff-loaded")).toBeVisible();
    await shot("08-diff");

    // 10. Terminal pane spawns a session.
    await page.getByTestId("tab-terminal").click();
    await page.getByTestId("term-spawn").click();
    await expect(page.getByTestId("term-host").locator(".xterm")).toBeVisible({
      timeout: 10_000,
    });
    await shot("09-terminal");

    // 11. Queue pane enqueues an item.
    await page.getByTestId("tab-queue").click();
    await page.getByTestId("queue-input").fill("queued thought");
    await page.getByTestId("queue-add").click();
    await expect(page.locator('[data-testid="queue-list"] > li')).toHaveCount(1);
    await shot("10-queue");

    // 12. Notes pane adds a note.
    await page.getByTestId("tab-notes").click();
    await page.getByTestId("note-input").fill("remember this");
    await page.getByTestId("note-add").click();
    await expect(page.locator('[data-testid="notes-list"] > li')).toHaveCount(1);
    await shot("11-notes");

    // 13. Theme switching to Tokyo Night changes background.
    await page.getByTestId("theme-picker").selectOption("tokyo-night");
    await page.waitForTimeout(100);
    const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bodyBg).toBe("rgb(26, 27, 38)");
    await shot("12-theme-tokyo");

    // 14. No console errors.
    expect(errors, errors.join("\n")).toHaveLength(0);
  });
});
