// Settings modal smoke + persistence spec.
//
// We don't try to exhaustively verify every field; the goal is to
// catch regressions in the tab switcher, the global toggle (Agents
// → auto-approve-tools) round-trip, and the Providers list shape.
// Each tab has independent state machinery (createSignal vs
// settings store vs BE-cached descriptors), so a single "modal
// opens, all 4 tabs work" assertion catches the most common
// breakages cheaply.

import { test, expect } from "@playwright/test";
import { BASE, seedBackend } from "./helpers";

test.describe("settings modal", () => {
  test.beforeEach(async ({ page }) => {
    await seedBackend(page);
    await page.goto(BASE, { waitUntil: "networkidle" });
    await expect(page.getByTestId("app-root")).toBeVisible({ timeout: 15_000 });
  });

  test("opens via gear icon + all four tab buttons are clickable", async ({ page }) => {
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("settings-modal")).toBeVisible();

    // Each tab button has its own testid (`settings-tab-<id>`); the
    // active one gets `!bg-bg-3 !text-fg`. We click each in turn
    // and assert that the active marker moves with us — proves the
    // tab strip is wired without depending on every tab body
    // exposing the same testid shape (they don't: Appearance has
    // none today, Agents/Providers do).
    for (const tab of ["appearance", "agents", "prompts", "providers"]) {
      const btn = page.getByTestId(`settings-tab-${tab}`);
      await btn.click();
      await expect(btn).toHaveClass(/!bg-bg-3/);
    }
  });

  test("agents auto-approve toggle round-trips through the BE", async ({ page }) => {
    await page.getByTestId("open-settings").click();
    await page.getByTestId("settings-tab-agents").click();
    // The real <input> is `.sr-only` (visually hidden, screen-reader
    // only) and the visual stylised <span> "switch" intercepts
    // pointer events. We click the outer label (`agents-auto-approve-
    // toggle`) which is what an actual user clicks; the browser
    // dispatches the synthetic change event on the inner checkbox.
    const toggle = page.getByTestId("agents-auto-approve-toggle");
    const input = page.getByTestId("agents-auto-approve-input");

    await expect(input).toBeChecked();
    await toggle.click();
    await expect(input).not.toBeChecked();

    // Close dialog, reopen — the OFF state must persist via the BE.
    await page.getByTestId("settings-close").click();
    await page.getByTestId("open-settings").click();
    await page.getByTestId("settings-tab-agents").click();
    await expect(page.getByTestId("agents-auto-approve-input")).not.toBeChecked();

    // Restore the default ON state so other tests' agents work.
    await page.getByTestId("agents-auto-approve-toggle").click();
    await expect(page.getByTestId("agents-auto-approve-input")).toBeChecked();
  });

  test("providers tab lists the registered CLI providers", async ({ page }) => {
    await page.getByTestId("open-settings").click();
    await page.getByTestId("settings-tab-providers").click();

    // Today: claude + opencode. The card testid pattern is
    // `provider-card-<id>` for read-only CLI cards. We don't assert
    // availability (env-dependent: CI may not have either CLI), only
    // that the cards rendered.
    await expect(page.getByTestId("provider-card-claude")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("provider-card-opencode")).toBeVisible({ timeout: 5_000 });

    // 9router was removed; its card should NOT render.
    await expect(page.getByTestId("provider-card-9router")).toHaveCount(0);
    await expect(page.getByTestId("provider-form-9router")).toHaveCount(0);
  });
});
