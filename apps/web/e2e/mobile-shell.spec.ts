import { expect, test } from "@playwright/test";
import { BASE, seedBackend } from "./helpers";

/**
 * Shell selection. Runs in the `mobile` Playwright project (Pixel 7),
 * so the default for every test here is a phone viewport; the
 * desktop-on-a-phone cases opt in explicitly via `?ui=desktop`.
 */

const url = (qs = "") => `${BASE.replace(/\/$/, "")}/${qs}`;

test.beforeEach(async ({ page }) => {
  await seedBackend(page);
});

test("a phone viewport mounts the mobile shell", async ({ page }) => {
  await page.goto(url(), { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("mobile-app")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("left-rail")).toHaveCount(0);
});

test("the shell marks #root so CSS can scope the desktop width floor", async ({ page }) => {
  await page.goto(url(), { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("mobile-app")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#root")).toHaveAttribute("data-shell", "mobile");
});

test("the mobile shell does not overflow the viewport horizontally", async ({ page }) => {
  await page.goto(url(), { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("mobile-app")).toBeVisible({ timeout: 15_000 });
  const overflow = await page.evaluate(() => {
    const root = document.getElementById("root")!;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow).toBe(0);
});

test("?ui=desktop forces the desktop shell on a phone", async ({ page }) => {
  await page.goto(url("?ui=desktop"), { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("app-root")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("mobile-app")).toHaveCount(0);
  await expect(page.locator("#root")).toHaveAttribute("data-shell", "desktop");
});

test("a forced shell survives a reload without the query string", async ({ page }) => {
  await page.goto(url("?ui=desktop"), { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("app-root")).toBeVisible({ timeout: 15_000 });

  await page.goto(url(), { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("app-root")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("mobile-app")).toHaveCount(0);
});

test("?ui=auto clears the override and hands back to the viewport", async ({ page }) => {
  await page.goto(url("?ui=desktop"), { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("app-root")).toBeVisible({ timeout: 15_000 });

  await page.goto(url("?ui=auto"), { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("mobile-app")).toBeVisible({ timeout: 15_000 });

  // And it stays cleared.
  await page.goto(url(), { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("mobile-app")).toBeVisible({ timeout: 15_000 });
});

test("the escape hatch switches to desktop and sticks", async ({ page }) => {
  await page.goto(url(), { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("mobile-app")).toBeVisible({ timeout: 20_000 });

  // The escape hatch lives at the bottom of the Settings tab — the one
  // place where "use the other UI" is a sensible thing to offer.
  await page.getByTestId("mobile-tab-settings").click();
  await page.getByTestId("mobile-switch-to-desktop").click();
  await expect(page.getByTestId("app-root")).toBeVisible({ timeout: 20_000 });

  // And it survives a reload with no query string.
  await page.goto(url(), { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("app-root")).toBeVisible({ timeout: 20_000 });
});
