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

test("queue thoughts", async ({ page }) => {
  test.setTimeout(120_000);
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

  // Queue a sequence of prompts while the first one is still running.
  await typeIntoComposer(page, "Explain Rust lifetimes simply");
  await send(page);
  await page.waitForTimeout(1_000);

  await typeIntoComposer(page, "Now give a code example");
  await send(page);
  await page.waitForTimeout(1_000);

  await typeIntoComposer(page, "List common lifetime mistakes");
  await send(page);
  await page.waitForTimeout(1_000);

  // Wait for the queue to drain and each response to finish.
  await page.waitForTimeout(45_000);
});
