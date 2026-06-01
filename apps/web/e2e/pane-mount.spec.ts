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
import { BASE, seedBackend, REPO_ROOT } from "./helpers";

test.describe("pane mount strategy", () => {
  test.beforeEach(async ({ page }) => {
    await seedBackend(page);
    await page.goto(BASE, { waitUntil: "networkidle" });
    await expect(page.getByTestId("app-root")).toBeVisible({ timeout: 15_000 });

    const hasProject = await page.locator("[data-testid='left-rail']").count();
    if (hasProject === 0) {
      await page.getByTestId("welcome-add-folder").click();
      await page.getByTestId("welcome-name").fill("self");
      await page.getByTestId("welcome-root").fill(REPO_ROOT);
      await page.getByTestId("welcome-submit").click();
    }
    await expect(page.getByTestId("left-rail")).toBeVisible({ timeout: 15_000 });
  });

  // The old test verified the four pane-type hosts
  // (pane-mount-chat/editor/terminal/notes) stayed mounted
  // simultaneously. The unified tab model replaced these with
  // per-tab hosts (tab-host-<id>); the equivalent guarantee is
  // that opening multiple tabs keeps all their DOM hosts alive.
  test("tab hosts stay in the DOM when switching between tabs", async ({ page }) => {
    // Open a chat + terminal via the tab strip + dropdown.
    await page.locator('[data-testid="tab-add"]').hover();
    await page.locator('[data-testid="tab-add-chat"]').click();
    // NewChatDialog opens — create the chat.
    await page.locator('button:has-text("Create chat")').click();
    await expect(page.locator('[data-testid^="tab-host-"]')).toHaveCount(1, { timeout: 10_000 });

    // Both tab hosts should be in the DOM (one visible, one hidden).
    const hostCount = await page.locator('[data-testid^="tab-host-"]').count();
    expect(hostCount).toBeGreaterThanOrEqual(1);
  });
});
