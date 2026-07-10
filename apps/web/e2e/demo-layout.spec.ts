import { test } from "@playwright/test";
import {
  ensureProject,
  waitForHydrated,
  waitForToast,
  waitForRecordingStart,
} from "./demo-helpers";

test("layout", async ({ page }) => {
  test.setTimeout(30_000);
  await ensureProject();

  await page.goto("/");
  await waitForHydrated(page);
  await waitForToast(page);
  await waitForRecordingStart();

  // Collapse left rail.
  const railToggle = page.locator('[data-testid="left-rail-toggle"]');
  await railToggle.click();
  await page.waitForTimeout(1000);

  // Collapse sidebar.
  const sidebarToggle = page.locator('[data-testid="sidebar-toggle"]');
  await sidebarToggle.click();
  await page.waitForTimeout(1000);

  // Restore both.
  await sidebarToggle.click();
  await page.waitForTimeout(500);
  await railToggle.click();
  await page.waitForTimeout(500);
});
