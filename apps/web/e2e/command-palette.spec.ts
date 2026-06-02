// Cmd+P fuzzy file finder.
//
// Asserts the user-visible contract end-to-end against the BE
// index. Doesn't try to verify specific file content because it
// depends on the project's tree at test time; we check the
// behavioural contract:
//   1. Cmd/Ctrl+P opens the palette.
//   2. The palette shows SOME hits for the empty query (the index
//      surfaces tree contents on first open).
//   3. Typing narrows results.
//   4. Esc closes.

import { test, expect } from "@playwright/test";
import { BASE, BE_URL, REPO_ROOT, seedBackend } from "./helpers";

test.describe("command palette (Cmd+P)", () => {
  test.beforeEach(async ({ page }) => {
    await seedBackend(page);
    await page.goto(BASE, { waitUntil: "networkidle" });
    await expect(page.getByTestId("app-root")).toBeVisible({ timeout: 15_000 });

    // Ensure at least one project is registered so the palette has
    // something to index. The repo itself works as the test project.
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

  test("opens on Cmd/Ctrl+P + closes on Escape", async ({ page }) => {
    const isMac = process.platform === "darwin";
    await page.keyboard.press(isMac ? "Meta+p" : "Control+p");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await expect(page.getByTestId("command-palette-input")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-palette")).toHaveCount(0);
  });

  test("shows indexed hits for the empty query", async ({ page }) => {
    const isMac = process.platform === "darwin";
    await page.keyboard.press(isMac ? "Meta+p" : "Control+p");
    await expect(page.getByTestId("command-palette")).toBeVisible();

    // First-time open kicks off a lazy index scan. Allow time for
    // walking the AgentGrove tree (~2k files) on a cold cache.
    await expect
      .poll(async () => await page.locator('[data-testid^="command-palette-hit-"]').count(), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
  });

  test("typing narrows the results", async ({ page }) => {
    const isMac = process.platform === "darwin";
    await page.keyboard.press(isMac ? "Meta+p" : "Control+p");
    await expect(page.getByTestId("command-palette")).toBeVisible();

    // Warm the index.
    await expect
      .poll(async () => await page.locator('[data-testid^="command-palette-hit-"]').count(), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);

    // Count hits BEFORE typing, then type a moderately unusual
    // sequence that should match much narrower than the empty
    // query. We assert the count strictly decreases — works for
    // any project tree as long as the index has hits at all.
    const beforeCount = await page.locator('[data-testid^="command-palette-hit-"]').count();
    await page.getByTestId("command-palette-input").fill("xyzzy");
    await expect
      .poll(async () => await page.locator('[data-testid^="command-palette-hit-"]').count(), {
        timeout: 3_000,
      })
      .toBeLessThan(beforeCount);
  });
});
