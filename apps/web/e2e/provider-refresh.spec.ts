// Provider model refresh icon.
//
// Settings → Providers cards expose a refresh button per provider
// (`provider-<id>-refresh`). Clicking it triggers
// `POST /api/providers/<id>/refresh` which invalidates the BE's
// in-memory model cache and re-runs detect(). The card's models
// count chip should reflect the fresh value (which equals the
// previous value when nothing changed upstream — the test is just
// about the happy-path round-trip + no errors thrown).

import { test, expect } from "@playwright/test";
import { BASE, seedBackend } from "./helpers";

test.describe("provider refresh", () => {
  test.beforeEach(async ({ page }) => {
    await seedBackend(page);
    await page.goto(BASE, { waitUntil: "networkidle" });
    await expect(page.getByTestId("app-root")).toBeVisible({ timeout: 15_000 });
  });

  test("refresh button is reachable + click does not error", async ({ page }) => {
    await page.getByTestId("open-settings").click();
    await page.getByTestId("settings-tab-providers").click();

    // Wait for the BE-cached providers to land. We track any
    // refresh button matching the testid pattern — at least one of
    // claude/opencode should be in the list.
    const refresh = page.locator('[data-testid$="-refresh"]').first();
    await expect(refresh).toBeVisible({ timeout: 5_000 });

    // Clicking should not crash; the test just asserts no console
    // errors fire. We capture errors via the page.on('pageerror')
    // listener so a stray throw inside the refresh flow fails the
    // test even when the UI swallows it.
    const errors: Error[] = [];
    page.on("pageerror", (e) => errors.push(e));

    await refresh.click();
    // Let the refresh round-trip complete (BE detect + cache
    // invalidate + descriptor write-back).
    await page.waitForTimeout(1_500);
    expect(errors).toHaveLength(0);
  });
});
