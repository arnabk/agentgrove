import { test, expect } from "@playwright/test";
import {
  ensureProject,
  waitForHydrated,
  waitForRecordingStart,
  waitForToast,
} from "./demo-helpers";

test("worktree sessions", async ({ page }) => {
  test.setTimeout(120_000);
  await ensureProject();

  await page.goto("/");
  await waitForHydrated(page);
  await waitForToast(page);
  await waitForRecordingStart();

  // Scene 1: Expand the demo project and open its root workspace.
  const project = page.locator('[data-testid^="project-"]').first();
  await expect(project).toBeVisible();
  await project.click();
  await page.waitForTimeout(2_500);

  // Scene 2: Open the project menu and create a worktree.
  const menu = page.locator('[data-testid^="project-menu-"]').first();
  await menu.click();
  await page.waitForTimeout(1_500);
  const newWorktree = page.locator('[data-testid^="new-worktree-"]').first();
  await newWorktree.click();
  await page.waitForTimeout(2_500);

  const branchInput = page.locator('[data-testid="worktree-branch"]');
  await branchInput.waitFor({ state: "visible", timeout: 10_000 });
  await branchInput.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("demo-worktree", { delay: 40 });
  await expect(branchInput).toHaveValue("demo-worktree");
  await page.waitForTimeout(1_000);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(6_000);

  // Scene 3: Start a chat in the worktree scope.
  const newChat = page.locator('[data-testid^="new-chat-"]').first();
  await newChat.click();
  await page.waitForTimeout(2_000);

  const chatTitle = page.locator('[data-testid="new-chat-title"]');
  await chatTitle.waitFor({ state: "visible", timeout: 10_000 });
  await chatTitle.fill("Worktree chat");
  await page.waitForTimeout(1_000);
  const createChat = page.locator('[data-testid="new-chat-submit"]');
  await createChat.click();
  await page.waitForTimeout(3_500);

  const chatInput = page.locator('[data-testid="chat-input"]').filter({ visible: true }).first();
  await chatInput.waitFor({ state: "visible", timeout: 10_000 });
  await chatInput.click();
  await page.keyboard.type("What branch is this workspace on?", { delay: 40 });
  await page.waitForTimeout(1_000);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(10_000);

  // Scene 4: Switch back to the project root workspace.
  const root = page.locator('[data-testid^="project-root-"]').first();
  await root.waitFor({ state: "visible", timeout: 10_000 });
  await root.click();
  await page.waitForTimeout(3_000);

  // Scene 5: Start a separate chat in the root workspace.
  await menu.click();
  await page.waitForTimeout(1_500);
  await newChat.click();
  await page.waitForTimeout(2_000);

  await chatTitle.waitFor({ state: "visible", timeout: 10_000 });
  await chatTitle.fill("Root chat");
  await page.waitForTimeout(1_000);
  await createChat.click();
  await page.waitForTimeout(3_500);

  const rootInput = page.locator('[data-testid="chat-input"]').filter({ visible: true }).first();
  await rootInput.waitFor({ state: "visible", timeout: 10_000 });
  await rootInput.click();
  await page.keyboard.type("List the top-level files", { delay: 40 });
  await page.waitForTimeout(1_000);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(10_000);
});
