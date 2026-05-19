import { test, expect } from "@playwright/test";

test("app loads and theme toggles", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "AgentGrove" })).toBeVisible();
  const root = page.getByTestId("app-root");
  await expect(root).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await expect(root).toHaveAttribute("data-theme", "light");
});
