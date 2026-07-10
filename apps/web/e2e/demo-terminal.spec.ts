import { test, expect } from "@playwright/test";
import {
  ensureProject,
  waitForHydrated,
  waitForToast,
  waitForRecordingStart,
} from "./demo-helpers";

test("terminal", async ({ page }) => {
  test.setTimeout(45_000);
  await ensureProject();

  await page.goto("/");
  await waitForHydrated(page);
  await waitForToast(page);
  await waitForRecordingStart();

  // Open project menu and create a terminal.
  await page.locator('[data-testid^="project-menu-"]').first().click();
  await page.waitForTimeout(1_500);
  await page.locator('[data-testid^="new-terminal-"]').first().click();

  const terminal = page.locator(".xterm").filter({ visible: true }).first();
  await expect(terminal).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(2_000);

  // Show a few typical shell commands.
  await page.keyboard.type("ls", { delay: 60 });
  await page.waitForTimeout(1_000);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2_500);

  await page.keyboard.type("cat README.md", { delay: 50 });
  await page.waitForTimeout(1_000);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2_500);

  await page.keyboard.type("git status --short", { delay: 50 });
  await page.waitForTimeout(1_000);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3_500);
});
