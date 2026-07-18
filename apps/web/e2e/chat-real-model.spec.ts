import { test, expect } from "@playwright/test";
import { bootstrapWithProvider, getChat, typeIntoComposer, submitComposer } from "./helpers";

const REAL_MODEL = process.env.AGENTGROVE_REAL_MODEL ?? "opencode/hy3-free";

/**
 * Regression check for the chat timeline rendering bug: after a period of
 * inactivity, newly sent messages (and their responses) do not appear in the
 * chat timeline until the page is refreshed or the user switches views.
 *
 * This test uses a real (free) opencode model instead of the fake provider so
 * that the streaming / idle-reconnect behavior that triggers the bug is
 * exercised.
 */
test.describe("chat with real model", () => {
  test.setTimeout(300_000);

  test("messages stay visible in the timeline after an idle wait", async ({ page }) => {
    const chatId = await bootstrapWithProvider(page, "opencode", REAL_MODEL);

    const largeBody = "Important message:\n" + "x".repeat(1000);

    // First message + response.
    await typeIntoComposer(page, largeBody);
    await submitComposer(page);
    await expect
      .poll(async () => (await getChat(chatId)).prompts?.length ?? 0, {
        timeout: 120_000,
        intervals: [1_000],
      })
      .toBeGreaterThanOrEqual(2);

    // Simulate the user leaving the chat idle before sending more.
    await page.waitForTimeout(30_000);

    // Second message + response.
    await typeIntoComposer(page, "Follow-up: " + largeBody);
    await submitComposer(page);
    await expect
      .poll(async () => (await getChat(chatId)).prompts?.length ?? 0, {
        timeout: 120_000,
        intervals: [1_000],
      })
      .toBeGreaterThanOrEqual(4);

    // Both user messages must be visible in the active chat timeline without
    // requiring a refresh or pane switch.
    await expect(page.getByText("Important message:").first()).toBeVisible();
    await expect(page.getByText("Follow-up:").first()).toBeVisible();
  });
});
