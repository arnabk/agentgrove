// Live verification: runs against an already-running FE dev server.
// scripts/verify.sh launches the FE and passes BASE_URL.

import { test, expect } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";

test.describe("live frontend", () => {
  test("solid app renders, theme toggles, Tailwind applies", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
    });

    await page.goto(BASE, { waitUntil: "domcontentloaded" });

    // 1. The H1 is present — proves Solid mounted.
    const h1 = page.getByRole("heading", { level: 1, name: "AgentGrove" });
    await expect(h1).toBeVisible({ timeout: 10_000 });

    // 2. <main> has data-theme=dark by default.
    const root = page.getByTestId("app-root");
    await expect(root).toHaveAttribute("data-theme", "dark");

    // 3. <html> also has data-theme=dark (so global vars apply to body).
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    // 4. Tailwind applied: body bg uses dark CSS variable #0b0d10.
    await expect
      .poll(async () => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
      .toBe("rgb(11, 13, 16)");

    // 5. Toggle theme to light.
    const toggle = page.getByRole("button", { name: "Toggle theme" });
    await toggle.click();
    await expect(root).toHaveAttribute("data-theme", "light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect
      .poll(async () => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
      .toBe("rgb(255, 255, 255)");

    // 6. Toggle back.
    await toggle.click();
    await expect(root).toHaveAttribute("data-theme", "dark");

    // 7. No console errors during the run.
    expect(errors, errors.join("\n")).toHaveLength(0);
  });
});
