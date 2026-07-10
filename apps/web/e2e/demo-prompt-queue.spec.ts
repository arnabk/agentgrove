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

test("prompt queue", async ({ page }) => {
  test.setTimeout(60_000);
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

  // First message keeps the AI busy.
  await typeIntoComposer(page, "Write a haiku about coding");
  await send(page);
  await page.waitForTimeout(1000);

  // Second message auto-enqueues while the first streams.
  await typeIntoComposer(page, "Now make it shorter");
  await send(page);
  await page.waitForTimeout(25_000);
});
