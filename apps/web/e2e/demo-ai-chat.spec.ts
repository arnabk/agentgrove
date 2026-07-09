import { test, expect } from "@playwright/test";
import {
  ensureProject,
  createChat,
  waitForHydrated,
  waitForToast,
  openChat,
  typeIntoComposer,
  send,
} from "./demo-helpers";

test("ai chat", async ({ page }) => {
  test.setTimeout(60_000);
  const projectId = await ensureProject();
  const chatId = await createChat(projectId, "opencode", "9router/cc/claude-sonnet-4-6");

  await page.goto("/");
  await waitForHydrated(page);
  await waitForToast(page);

  await openChat(page, chatId, projectId);

  const composer = page
    .locator('.ag-shell [data-testid="chat-input"]')
    .filter({ visible: true })
    .first();
  await expect(composer).toBeVisible({ timeout: 15_000 });

  await typeIntoComposer(page, "Say hi like a friendly coding assistant");
  await send(page);

  // Wait for the streaming response to complete.
  await page.waitForTimeout(20_000);
});
