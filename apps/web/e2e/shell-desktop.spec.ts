import { expect, test } from "@playwright/test";
import { BASE, ensureProject, seedBackend } from "./helpers";

/**
 * Guards the lazy shell split: the desktop shell is now a code-split
 * chunk behind shell.tsx rather than a static import from main.tsx, so
 * a broken dynamic import would surface as an empty page rather than a
 * build error.
 *
 * Seeds a project first — with an empty database the desktop shell
 * renders the Welcome screen instead of the rail and tab strip, which
 * is correct but tells us nothing about whether the chunk loaded. That
 * empty-database path is `verify-live.spec.ts`'s job, so verify.sh runs
 * this file as a separate invocation after it.
 */
test.describe("desktop shell", () => {
  test.beforeEach(async ({ page }) => {
    await seedBackend(page);
  });

  test("mounts the full workspace chrome", async ({ page }) => {
    const projectId = await ensureProject();
    await page.goto(`${BASE.replace(/\/$/, "")}/p/${projectId}`, {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByTestId("app-root")).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId("left-rail")).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId("tab-strip")).toBeVisible();
    await expect(page.getByTestId("right-sidebar")).toBeVisible();
    await expect(page.getByTestId("top-indicators")).toBeVisible();
    // And no mobile shell leaked in.
    await expect(page.getByTestId("mobile-tab-bar")).toHaveCount(0);
  });

  test("keeps its 1024px width floor", async ({ page }) => {
    // The floor is now scoped to [data-shell="desktop"]; losing it would
    // let the desktop layout collapse instead of scrolling. Independent
    // of whether any project exists.
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("app-root")).toBeVisible({ timeout: 25_000 });
    await expect(page.locator("#root")).toHaveAttribute("data-shell", "desktop");

    const minWidth = await page.evaluate(
      () => getComputedStyle(document.getElementById("root")!).minWidth,
    );
    expect(minWidth).toBe("1024px");
  });
});
