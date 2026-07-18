import { test } from "@playwright/test";
import { ensureProject, waitForHydrated, waitForToast, waitForRecordingStart } from "./demo-helpers";

test("db-editor", async ({ page }) => {
  test.setTimeout(60_000);
  await ensureProject();

  await page.goto("/");
  await waitForHydrated(page);
  await waitForToast(page);
  await waitForRecordingStart();

  // Switch the left rail to the Database view.
  await page.locator('[data-testid="rail-view-db"]').click();
  await page.waitForTimeout(1_200);

  // The seeded "Local Postgres" connection auto-connects; tables appear.
  const sidebar = page.locator('[data-testid="db-sidebar"]');
  await sidebar.getByText("users", { exact: true }).first().waitFor({
    state: "visible",
    timeout: 15_000,
  });
  await page.waitForTimeout(1_000);

  // Filter the table list for a moment.
  await sidebar.locator('input[placeholder="Filter tables…"]').click();
  await page.keyboard.type("use", { delay: 120 });
  await page.waitForTimeout(1_200);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(600);

  // Open the users table — data grid opens in the editor tab.
  await sidebar.getByText("users", { exact: true }).first().click();
  const host = page.locator('[data-testid^="tab-host-db"]');
  await host.locator("table thead th").first().waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(2_500);

  // Type a query in the SQL editor; autocomplete pops up as we type.
  await page.locator('[data-testid="db-sql-editor"] .cm-content').click();
  await page.keyboard.type("SELECT name, email FROM users WHERE users.", { delay: 45 });
  await page.waitForTimeout(1_500);
  await page.keyboard.press("Escape");
  await page.keyboard.type("role = 'admin'", { delay: 45 });
  await page.waitForTimeout(800);

  // Run it and show the filtered result.
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(2_500);
});
