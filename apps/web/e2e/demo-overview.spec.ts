import { test, expect } from "@playwright/test";
import {
  ensureProject,
  waitForHydrated,
  waitForRecordingStart,
  waitForToast,
  REPO_ROOT,
} from "./demo-helpers";

test("overview", async ({ page }) => {
  test.setTimeout(120_000);
  await ensureProject();

  await page.goto("/");
  await waitForHydrated(page);
  await waitForToast(page);

  await waitForRecordingStart();

  // Scene 1: Select the demo project and show the file tree.
  const project = page.locator('[data-testid^="project-"]').first();
  await expect(project).toBeVisible();
  await project.click();
  await page.waitForTimeout(2_500);

  // Scene 2: Open an integrated terminal and run a command.
  const menu = page.locator('[data-testid^="project-menu-"]').first();
  await menu.click();
  await page.waitForTimeout(1_500);
  const newTerminal = page.locator('[data-testid^="new-terminal-"]').first();
  await newTerminal.click();
  await page.waitForTimeout(2_500);

  await page.keyboard.type("ls", { delay: 60 });
  await page.waitForTimeout(1_000);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3_500);

  // Scene 3: Open a new AI chat, ask a question, and wait for the response.
  await menu.click();
  await page.waitForTimeout(1_500);
  const newChat = page.locator('[data-testid^="new-chat-"]').first();
  await newChat.click();
  await page.waitForTimeout(2_000);

  const chatTitle = page.locator('[data-testid="new-chat-title"]');
  await chatTitle.waitFor({ state: "visible", timeout: 10_000 });
  await chatTitle.fill("Explore README");
  await page.waitForTimeout(1_000);
  const createChat = page.locator('[data-testid="new-chat-submit"]');
  await createChat.click();
  await page.waitForTimeout(3_500);

  const chatInput = page.locator('[data-testid="chat-input"]').filter({ visible: true }).first();
  await chatInput.waitFor({ state: "visible", timeout: 10_000 });
  await chatInput.click();
  await page.keyboard.type("Summarize the README for me", { delay: 40 });
  await page.waitForTimeout(1_000);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(12_000);

  // Scene 4: Open a file in the editor.
  const readme = page.locator(`[data-testid="tree-file-${REPO_ROOT}/README.md"]`);
  await readme.waitFor({ state: "visible", timeout: 10_000 });
  await readme.click();
  await page.waitForTimeout(3_500);

  // Scene 5: Type a note in the right sidebar.
  const notesTab = page.locator("button").filter({ hasText: "Notes" }).first();
  await notesTab.waitFor({ state: "visible", timeout: 10_000 });
  await notesTab.click();
  await page.waitForTimeout(2_000);

  const notesEditor = page.locator('[data-testid="notes-host"] .ProseMirror').first();
  await notesEditor.waitFor({ state: "visible", timeout: 10_000 });
  await notesEditor.click();
  await page.keyboard.type("- [ ] Review demo recording", { delay: 40 });
  await page.waitForTimeout(2_500);

  // Scene 6: Type and send a message in Team Chat.
  const teamChatTab = page.locator("button").filter({ hasText: "Team Chat" }).first();
  await teamChatTab.waitFor({ state: "visible", timeout: 10_000 });
  await teamChatTab.click();
  await page.waitForTimeout(2_000);

  const teamInput = page.getByPlaceholder("Type a message...").first();
  await teamInput.waitFor({ state: "visible", timeout: 10_000 });
  await teamInput.fill("Demo recording looks great!");
  await page.waitForTimeout(1_000);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3_000);

  // Scene 7: Create a worktree from the project menu.
  await menu.click();
  await page.waitForTimeout(1_500);
  const newWorktree = page.locator('[data-testid^="new-worktree-"]').first();
  await newWorktree.click();
  await page.waitForTimeout(2_500);

  const branchInput = page.locator('[data-testid="worktree-branch"]');
  await branchInput.waitFor({ state: "visible", timeout: 10_000 });
  await branchInput.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("feature-demo", { delay: 40 });
  await expect(branchInput).toHaveValue("feature-demo");
  await page.waitForTimeout(1_000);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(6_000);

  // Scene 8: Final hold on the updated workspace.
  await page.waitForTimeout(4_000);
});
