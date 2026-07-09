import { test, expect } from "@playwright/test";
import { ensureProject, waitForHydrated, waitForToast } from "./demo-helpers";

test("settings", async ({ page }) => {
  test.setTimeout(30_000);
  await ensureProject();

  await page.goto("/");
  await waitForHydrated(page);
  await waitForToast(page);

  const settings = page.locator('[data-testid="open-settings"]');
  await settings.click();
  await page.waitForTimeout(1000);

  const modal = page.locator('[data-testid="settings-modal"]').filter({ visible: true }).first();
  await expect(modal).toBeVisible({ timeout: 10_000 });

  // Switch to Appearance tab to show theme/font options.
  const appearanceTab = page.locator('[data-testid="settings-tab-appearance"]');
  if (await appearanceTab.count() > 0) {
    await appearanceTab.click();
    await page.waitForTimeout(1500);
  }

  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
});
