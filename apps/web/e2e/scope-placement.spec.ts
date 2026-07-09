// Scope placement regression.
//
// Chats and terminals created from a project (or worktree) row in the
// left rail must open in THAT project's scope — the PTY must spawn in
// the project's directory, and the tab must show up under that project,
// not leak into / hide behind a different scope.
//
// This guards against the scope-key encoding drift that once made tabs
// land under a different key than the one the active scope read back
// ("the terminal didn't start in the project I created it from").

import { test, expect } from "@playwright/test";
import { BASE, BE_URL, seedBackend, REPO_ROOT } from "./helpers";

test.describe("scope placement", () => {
  test.beforeEach(async ({ page }) => {
    await seedBackend(page);
    await page.goto(BASE, { waitUntil: "networkidle" });
    await expect(page.getByTestId("app-root")).toBeVisible({ timeout: 15_000 });

    // Ensure at least one project exists.
    const hasRail = await page.locator("[data-testid='left-rail']").count();
    if (hasRail === 0) {
      await fetch(`${BE_URL}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "self", root: REPO_ROOT }),
      });
    }
    await expect(page.getByTestId("left-rail")).toBeVisible({ timeout: 15_000 });
  });

  test("a terminal created from a project row opens in that project's scope", async ({ page }) => {
    // Open the project overflow menu so the create actions are in the DOM.
    await page.locator('[data-testid^="project-menu-"]').first().click();
    await page.waitForTimeout(200);

    // Read the project id from its new-terminal button testid.
    const termBtn = page.locator('[data-testid^="new-terminal-"]').first();
    await expect(termBtn).toBeVisible({ timeout: 10_000 });
    const testid = await termBtn.getAttribute("data-testid");
    const projectId = testid!.replace("new-terminal-", "");

    await termBtn.click();

    // The URL focuses that project (scope switch happened) — this is the
    // core assertion: the action targeted the creating project's scope.
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toContain(projectId);

    // A live terminal renders. The dev DB may already hold terminals from
    // earlier runs, so scope by the visible xterm for the active tab.
    await expect(page.locator(".xterm").filter({ visible: true }).first()).toBeVisible({
      timeout: 15_000,
    });
    expect(await page.locator('[data-testid^="tab-host-"]').count()).toBeGreaterThanOrEqual(1);
  });

  test("a chat created from a project row opens in that project's scope", async ({ page }) => {
    // Open the project overflow menu so the create actions are in the DOM.
    await page.locator('[data-testid^="project-menu-"]').first().click();
    await page.waitForTimeout(200);

    const chatBtn = page.locator('[data-testid^="new-chat-"]').first();
    await expect(chatBtn).toBeVisible({ timeout: 10_000 });
    const testid = await chatBtn.getAttribute("data-testid");
    const projectId = testid!.replace("new-chat-", "");

    await chatBtn.click();
    // NewChatDialog -> create.
    await page.locator('button:has-text("Create chat")').click();

    // The URL is scoped to the creating project (the action targeted the
    // right scope) and a composer is available (the chat actually opened).
    // The dev DB may hold prior chats, so scope by the visible composer.
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toContain(projectId);
    await expect(page.getByTestId("chat-input").filter({ visible: true }).first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
