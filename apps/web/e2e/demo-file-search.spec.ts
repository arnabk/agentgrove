import { test, expect } from "@playwright/test";
import {
  ensureProject,
  waitForHydrated,
  waitForToast,
  waitForRecordingStart,
} from "./demo-helpers";

test("file search", async ({ page }) => {
  test.setTimeout(30_000);
  await ensureProject();

  await page.goto("/");
  await waitForHydrated(page);
  await waitForToast(page);
  await waitForRecordingStart();

  // Trigger Cmd+P file search.
  await page.keyboard.press("Meta+KeyP");
  await page.waitForTimeout(1_000);

  const palette = page.locator('[data-testid="command-palette"]');
  const input = page.locator('[data-testid="command-palette-input"]');
  await expect(palette).toBeVisible({ timeout: 5_000 });
  await expect(input).toBeFocused({ timeout: 5_000 });
  await page.waitForTimeout(1_000);

  await input.type("package", { delay: 60 });
  await page.waitForTimeout(1_200);

  const hit = page.locator('[data-testid^="command-palette-hit-"]').first();
  await expect(hit).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(1_500);

  await page.keyboard.press("Enter");
  await page.waitForTimeout(2_500);

  await page.keyboard.press("Escape");
  await page.waitForTimeout(1_000);
});
