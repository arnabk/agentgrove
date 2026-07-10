import { test, expect } from "@playwright/test";
import {
  ensureProject,
  createChat,
  waitForHydrated,
  waitForToast,
  waitForRecordingStart,
  openChat,
  typeIntoComposer,
  send,
} from "./demo-helpers";

test("revert with ai", async ({ page }) => {
  test.setTimeout(90_000);
  const projectId = await ensureProject();
  const chatId = await createChat(projectId, "opencode", "9router/cc/claude-sonnet-4-6");

  await page.goto("/");
  await waitForHydrated(page);
  await waitForToast(page);
  await waitForRecordingStart();

  await openChat(page, chatId, projectId);
  const composer = await page
    .locator('.ag-shell [data-testid="chat-input"]')
    .filter({ visible: true })
    .first();
  await expect(composer).toBeVisible({ timeout: 15_000 });

  // Ask the AI to revert the most recent commit.
  await typeIntoComposer(page, "Revert the last commit on the current branch");
  await send(page);
  await page.waitForTimeout(30_000);
});
