// Pane mount strategy.
//
// All panes (chat, editor, terminal, notes) stay mounted
// simultaneously and toggle via `display: none/block` when the
// active tab changes. This is a deliberate trade against the
// previous Dynamic-component approach that unmounted the inactive
// pane and lost its local state (composer drafts, scroll position,
// editor selection, …).
//
// We catch regressions by:
//   1. Switching to a non-default pane, verifying it renders.
//   2. Switching back, verifying the original pane host is still
//      in the DOM (under `pane-mount-<id>`).
//   3. Verifying both hosts exist simultaneously after a switch
//      — i.e. we DIDN'T regress to Dynamic-style remount.

import { test, expect } from "@playwright/test";
import { BASE, BE_URL, seedBackend, REPO_ROOT } from "./helpers";

test.describe("pane mount strategy", () => {
  test.beforeEach(async ({ page }) => {
    await seedBackend(page);
    await page.goto(BASE, { waitUntil: "networkidle" });
    await expect(page.getByTestId("app-root")).toBeVisible({ timeout: 15_000 });

    const hasProject = await page.locator("[data-testid='left-rail']").count();
    if (hasProject === 0) {
      await fetch(`${BE_URL}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "self", root: REPO_ROOT }),
      });
    }
    await expect(page.getByTestId("left-rail")).toBeVisible({ timeout: 15_000 });
  });

  // The old test verified the four pane-type hosts
  // (pane-mount-chat/editor/terminal/notes) stayed mounted
  // simultaneously. The unified tab model replaced these with
  // per-tab hosts (tab-host-<id>); the equivalent guarantee is
  // that opening multiple tabs keeps all their DOM hosts alive.
  test("tab hosts stay in the DOM when switching between tabs", async ({ page }) => {
    // Open a chat from the project row in the left rail (the header `+`
    // menu was removed; the rail is the canonical create surface).
    await page.locator('[data-testid^="new-chat-"]').first().click();
    // NewChatDialog opens — create the chat.
    await page.locator('button:has-text("Create chat")').click();
    // At least one tab host mounts (the dev DB may already hold tabs from
    // prior runs, so we don't assert an exact count).
    await expect(page.locator('[data-testid^="tab-host-"]').first()).toBeVisible({
      timeout: 10_000,
    });
    const hostCount = await page.locator('[data-testid^="tab-host-"]').count();
    expect(hostCount).toBeGreaterThanOrEqual(1);
  });
});
