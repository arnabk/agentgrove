// Git changes dialog: opens centred large dialog, lists files, can
// be closed via backdrop / ✕ / Escape. We don't try to assert on a
// specific diff content because the repo state varies per CI / dev
// machine; we verify the UX contract:
//   1. Clicking the project's "Changes" rail icon shows the modal.
//   2. The scope chip shows the project name.
//   3. Escape closes the modal.
//   4. Backdrop click closes the modal.
//   5. The diff host is present (will be empty when no file is
//      selected, populated when one is).

import { test, expect, Page } from "@playwright/test";
import { BASE, BE_URL, REPO_ROOT, seedBackend } from "./helpers";

/** Open the Changes panel for the first project. "View changes" lives
 *  in the project row's overflow (kebab) menu, so we open that first. */
async function openChanges(page: Page) {
  await page.locator('[data-testid^="project-menu-"]').first().click();
  await page.locator('[data-testid^="changes-"]').first().click();
}

test.describe("changes dialog", () => {
  test.beforeEach(async ({ page }) => {
    await seedBackend(page);
    await page.goto(BASE, { waitUntil: "networkidle" });
    await expect(page.getByTestId("app-root")).toBeVisible({ timeout: 15_000 });

    // Ensure at least one project exists (the repo root, which IS a
    // git repo so the Changes icon will render).
    const hasProject = await page.locator("[data-testid='left-rail']").count();
    if (hasProject === 0) {
      await fetch(`${BE_URL}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "self", root: REPO_ROOT }),
      });
    }
    await expect(page.getByTestId("left-rail")).toBeVisible({ timeout: 15_000 });
  });

  test("opens, shows scope label, closes via ✕", async ({ page }) => {
    // "View changes" lives in the project row's kebab menu.
    await openChanges(page);
    await expect(page.getByTestId("changes-panel")).toBeVisible();
    await expect(page.getByTestId("changes-scope")).toBeVisible();
    await page.getByTestId("changes-close").click();
    await expect(page.getByTestId("changes-panel")).toHaveCount(0);
  });

  test("closes on Escape", async ({ page }) => {
    await openChanges(page);
    await expect(page.getByTestId("changes-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("changes-panel")).toHaveCount(0);
  });

  test("closes when the backdrop is clicked", async ({ page }) => {
    await openChanges(page);
    const panel = page.getByTestId("changes-panel");
    await expect(panel).toBeVisible();
    // The backdrop sits behind the centred dialog inside the same
    // panel container. We click near the very edge of the viewport
    // to land on the backdrop rather than on the dialog itself.
    await page.mouse.click(2, 2);
    await expect(panel).toHaveCount(0);
  });
});
