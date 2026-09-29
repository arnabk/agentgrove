import { expect, test } from "@playwright/test";
import { BASE, seedBackend } from "./helpers";

/**
 * Guards the lazy shell split: the desktop shell is now a code-split
 * chunk behind shell.tsx rather than a static import from main.tsx, so
 * a broken dynamic import would show up as an empty page rather than a
 * build error. Assert the whole desktop chrome actually mounts.
 */
test.describe("desktop shell", () => {
  test.beforeEach(async ({ page }) => {
    await seedBackend(page);
  });

  test("mounts the full workspace chrome", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
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
    // let the desktop layout collapse instead of scrolling.
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("app-root")).toBeVisible({ timeout: 25_000 });
    await expect(page.locator("#root")).toHaveAttribute("data-shell", "desktop");

    const minWidth = await page.evaluate(
      () => getComputedStyle(document.getElementById("root")!).minWidth,
    );
    expect(minWidth).toBe("1024px");
  });
});
