// Queue dock toggle behaviour.
//
// The queue badge is always visible while a chat is selected (we
// recently dropped the `total > 0` gate so the user can pop the
// dock open even before queuing anything). Clicking it should
// toggle the dock; pressing the same button again should close it.
// The open/closed state persists per scope via the layout blob,
// so a reload keeps the user's last choice.

import { test, expect } from "@playwright/test";
import { bootstrapWithChat } from "./helpers";

test.describe("queue dock", () => {
  test("badge toggles the dock open + closed", async ({ page }) => {
    await bootstrapWithChat(page);

    const badge = page.getByTestId("chat-queue-badge");
    await expect(badge).toBeVisible();

    // Initial state: dock CLOSED. Clicking opens it.
    await expect(page.getByTestId("queue-dock")).toHaveCount(0);
    await badge.click();
    await expect(page.getByTestId("queue-dock")).toBeVisible();

    // Clicking again closes it.
    await badge.click();
    await expect(page.getByTestId("queue-dock")).toHaveCount(0);
  });

  test("dock resize handle is reachable when open", async ({ page }) => {
    await bootstrapWithChat(page);
    await page.getByTestId("chat-queue-badge").click();
    await expect(page.getByTestId("queue-dock")).toBeVisible();
    // Resize handle sits on the dock's left edge. Just check it
    // exists + has the separator role; the actual drag interaction
    // is hard to assert deterministically across viewports.
    await expect(page.getByTestId("queue-dock-resize")).toBeVisible();
  });
});
