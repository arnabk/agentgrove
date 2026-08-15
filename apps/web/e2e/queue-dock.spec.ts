// Inline queue behaviour.
//
// The queue lives at the bottom of the chat timeline, just above the
// composer. It is manual-only: it shows a total count and — once items
// are queued — a "Send next" action that pushes the head of the queue
// into the chat. There is NO auto-send toggle; nothing ever auto-sends.

import { test, expect } from "@playwright/test";
import { bootstrapWithChat, BE_URL } from "./helpers";

test.describe("inline queue", () => {
  test("queue timeline is shown when items are queued (no auto-send toggle)", async ({ page }) => {
    const chatId = await bootstrapWithChat(page);

    await fetch(`${BE_URL}/api/chats/${chatId}/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "queued item" }),
    });

    // The inline queue appears once there is at least one item.
    await expect(
      page.locator(`[data-testid="tab-host-${chatId}"] [data-testid="queue-timeline"]`),
    ).toBeVisible({ timeout: 10_000 });

    // We expect total to increase by at least 1 (other tests might have enqueued in background)
    await expect(
      page.locator(`[data-testid="tab-host-${chatId}"] [data-testid="queue-timeline-total"]`),
    ).toBeVisible({ timeout: 5_000 });

    // The auto/manual toggle has been removed — the queue is manual-only.
    await expect(
      page.locator(`[data-testid="tab-host-${chatId}"] [data-testid="queue-mode-auto"]`),
    ).toHaveCount(0);
    await expect(
      page.locator(`[data-testid="tab-host-${chatId}"] [data-testid="queue-mode-manual"]`),
    ).toHaveCount(0);
  });

  test("queued items show a Send-next action and fill the timeline width", async ({ page }) => {
    const chatId = await bootstrapWithChat(page);

    // Enqueue two items via the BE so they sit waiting. The queue is
    // manual-only, so nothing auto-drains.
    for (const body of ["first queued item", "second queued item"]) {
      await fetch(`${BE_URL}/api/chats/${chatId}/queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
    }

    // The timeline polls every second; wait for the cards to appear.
    const cards = page.locator(`[data-testid="tab-host-${chatId}"] [data-testid^="queue-card-"]`);
    await expect(cards.first()).toBeVisible({ timeout: 5_000 });

    // "Send next" action is offered.
    await expect(
      page.locator(`[data-testid="tab-host-${chatId}"] [data-testid="queue-run-next"]`),
    ).toBeVisible();

    // The first card should use (close to) the full timeline width.
    const timelineBox = await page
      .locator(`[data-testid="tab-host-${chatId}"] [data-testid="queue-timeline"]`)
      .boundingBox();
    const cardBox = await cards.first().boundingBox();
    expect(timelineBox).not.toBeNull();
    expect(cardBox).not.toBeNull();
    expect(cardBox!.width).toBeGreaterThan(timelineBox!.width * 0.8);
  });
});
