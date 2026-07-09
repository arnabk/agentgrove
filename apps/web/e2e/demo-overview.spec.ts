import { test, expect } from "@playwright/test";
import { ensureProject, waitForHydrated, waitForToast } from "./demo-helpers";

test("overview", async ({ page }) => {
  test.setTimeout(30_000);
  await ensureProject();

  await page.goto("/");
  await waitForHydrated(page);
  await waitForToast(page);

  // Expand the first project to show the tree.
  const project = page.locator('[data-testid^="project-"]').first();
  await expect(project).toBeVisible();
  await project.click();
  await page.waitForTimeout(800);

  // Open the project overflow menu to hint at actions.
  const menu = page.locator('[data-testid^="project-menu-"]').first();
  await menu.click();
  await page.waitForTimeout(800);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
});
