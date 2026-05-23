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

  test("all pane hosts stay in the DOM after switching tabs", async ({ page }) => {
    // The four panes mount their hosts as siblings, only one
    // visible at a time. Switching to each tab in turn should not
    // remove the others' hosts.
    for (const id of ["chat", "editor", "terminal", "notes"]) {
      await page.getByTestId(`tab-${id}`).click();
      await expect(page.getByTestId(`pane-mount-${id}`)).toBeVisible();
    }

    // After all four have been touched, all four mount points are
    // still present (hidden ones use display:none but stay in the
    // tree). Each should have `count() === 1`.
    for (const id of ["chat", "editor", "terminal", "notes"]) {
      await expect(page.getByTestId(`pane-mount-${id}`)).toHaveCount(1);
    }
  });
});
