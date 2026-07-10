import { test } from "@playwright/test";
import {
  ensureProject,
  waitForHydrated,
  waitForToast,
  waitForRecordingStart,
} from "./demo-helpers";

test("notes", async ({ page }) => {
  test.setTimeout(30_000);
  const projectId = await ensureProject();

  await page.goto("/");
  await waitForHydrated(page);
  await waitForToast(page);
  await waitForRecordingStart();

  // Open the Notes tab for the project via the sidebar.
  const notesBtn = page.getByRole("button", { name: "Notes" });
  if ((await notesBtn.count()) > 0) {
    await notesBtn.click();
  } else {
    // Try navigating directly to the notes pane.
    await page.goto(`/p/${projectId}?pane=notes`, { waitUntil: "domcontentloaded" });
  }
  await page.waitForTimeout(1_500);

  const notesEditor = page.locator('[data-testid="notes-host"] .ProseMirror').first();
  await notesEditor.waitFor({ state: "visible", timeout: 10_000 });
  await notesEditor.click();
  await page.keyboard.type("- [ ] Review demo recordings", { delay: 40 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("- [ ] Upload to README", { delay: 40 });
  await page.waitForTimeout(2_000);
});
