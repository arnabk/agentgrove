import { test, expect } from "@playwright/test";
import { ensureProject, waitForHydrated, waitForToast } from "./demo-helpers";

test("terminal", async ({ page }) => {
  test.setTimeout(30_000);
  await ensureProject();

  await page.goto("/");
  await waitForHydrated(page);
  await waitForToast(page);

  // Open project menu and create a terminal.
  await page.locator('[data-testid^="project-menu-"]').first().click();
  await page.waitForTimeout(200);
  await page.locator('[data-testid^="new-terminal-"]').first().click();

  const terminal = page.locator(".xterm").filter({ visible: true }).first();
  await expect(terminal).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1000);

  // Type a command in the terminal.
  await page.keyboard.type("echo 'Hello from AgentGrove'");
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2000);
});
