// Queue dock behaviour.
//
// The queue lives permanently in the RightSidebar's bottom slot while
// a chat is selected (it fills the slot's full width — no separate
// fixed-width dock or resize handle of its own). It shows a total
// count, an auto-send toggle, a status line, and — once items are
// queued — a "Send next" action that pushes the head of the queue into
// the chat.

import { test, expect } from "@playwright/test";
import { bootstrapWithChat, BE_URL } from "./helpers";

test.describe("queue dock", () => {
  test("queue panel is shown in the sidebar for the active chat", async ({ page }) => {
    await bootstrapWithChat(page);
    // The queue panel is always present alongside a chat.
    await expect(page.getByTestId("queue-dock")).toBeVisible();
    await expect(page.getByTestId("queue-total")).toBeVisible();
    // The auto-send toggle is present (either auto or manual variant).
    const toggle = page.getByTestId("queue-mode-auto").or(page.getByTestId("queue-mode-manual"));
    await expect(toggle).toBeVisible();
  });

  test("queued items show a Send-next action and fill the panel width", async ({ page }) => {
    const chatId = await bootstrapWithChat(page);

    // Park the queue in manual mode and enqueue two items via the BE so
    // they sit waiting (manual mode never auto-drains).
    await fetch(`${BE_URL}/api/chats/${chatId}/queue/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "manual" }),
    });
    for (const body of ["first queued item", "second queued item"]) {
      await fetch(`${BE_URL}/api/chats/${chatId}/queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
    }

    // The panel polls every second; wait for the cards to appear.
    const cards = page.locator('[data-testid^="queue-card-"]');
    await expect(cards.first()).toBeVisible({ timeout: 5_000 });

    // "Send next" action is offered.
    await expect(page.getByTestId("queue-run-next")).toBeVisible();

    // The first card should use (close to) the full panel width — the
    // bug we fixed was the card rendering far narrower than the panel.
    const dockBox = await page.getByTestId("queue-dock").boundingBox();
    const cardBox = await cards.first().boundingBox();
    expect(dockBox).not.toBeNull();
    expect(cardBox).not.toBeNull();
    expect(cardBox!.width).toBeGreaterThan(dockBox!.width * 0.8);
  });
});
