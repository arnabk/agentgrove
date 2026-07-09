import { test, expect } from "@playwright/test";
import { ensureProject, waitForHydrated, waitForToast } from "./demo-helpers";

test("notes", async ({ page }) => {
  test.setTimeout(30_000);
  const projectId = await ensureProject();

  await page.goto("/");
  await waitForHydrated(page);
  await waitForToast(page);

  // Open the Notes tab for the project via the sidebar.
  const notesBtn = page.getByRole("button", { name: "Notes" });
  if (await notesBtn.count() > 0) {
    await notesBtn.click();
  } else {
    // Try navigating directly to the notes pane.
    await page.goto(`/p/${projectId}?pane=notes`, { waitUntil: "domcontentloaded" });
  }
  await page.waitForTimeout(800);

  const notesPane = page.locator('[data-testid="notes-pane"]').filter({ visible: true }).first();
  await expect(notesPane).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(2000);
});
