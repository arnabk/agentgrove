import { expect, test } from "@playwright/test";
import { bootMobile } from "./mobile-helpers";

test.describe("mobile tabs", () => {
  test("chats is the default tab", async ({ page }) => {
    await bootMobile(page);
    await expect(page.getByTestId("mobile-tab-chats")).toHaveAttribute("aria-current", "page");
  });

  test("the team tab shows team chat", async ({ page }) => {
    await bootMobile(page);
    await page.getByTestId("mobile-tab-team").click();
    await expect(page.getByPlaceholder("Type a message...")).toBeVisible({ timeout: 15_000 });
  });

  test("the notes tab lazy-loads the scratchpad", async ({ page }) => {
    await bootMobile(page);
    await page.getByTestId("mobile-tab-notes").click();
    await expect(page.locator(".ag-prose")).toBeVisible({ timeout: 20_000 });
  });

  test("the settings tab renders all six tabs inline, not as a dialog", async ({ page }) => {
    await bootMobile(page);
    await page.getByTestId("mobile-tab-settings").click();
    await expect(page.getByTestId("mobile-settings")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("settings-tabs")).toBeVisible();
    for (const t of ["appearance", "agents", "prompts", "providers", "backups", "integrations"]) {
      await expect(page.getByTestId(`settings-tab-${t}`)).toBeVisible();
    }
    // Inline, so there is no modal overlay and no Done button.
    await expect(page.getByTestId("settings-modal")).toHaveCount(0);
    await expect(page.getByTestId("settings-done")).toHaveCount(0);
  });

  test("settings tabs switch bodies", async ({ page }) => {
    await bootMobile(page);
    await page.getByTestId("mobile-tab-settings").click();
    await expect(page.getByTestId("settings-tabs")).toBeVisible({ timeout: 20_000 });

    await page.getByTestId("settings-tab-agents").click();
    await expect(page.getByTestId("settings-agents-tab")).toBeVisible();

    await page.getByTestId("settings-tab-providers").click();
    await expect(page.getByTestId("settings-providers-tab")).toBeVisible();
  });

  test("the backups tab loads its data inline, not only in the dialog", async ({ page }) => {
    // The tab bodies used to gate their fetches on `settingsOpen()`,
    // which is only ever true for the desktop dialog.
    await bootMobile(page);
    await page.getByTestId("mobile-tab-settings").click();
    await page.getByTestId("settings-tab-backups").click();
    await expect(page.getByTestId("settings-backups-tab")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Database snapshots")).toBeVisible();
  });

  test("the active tab survives a reload", async ({ page }) => {
    await bootMobile(page);
    await page.getByTestId("mobile-tab-notes").click();
    await expect(page.getByTestId("mobile-tab-notes")).toHaveAttribute("aria-current", "page");

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("mobile-tab-notes")).toHaveAttribute("aria-current", "page", {
      timeout: 20_000,
    });
  });

  test("the header gear jumps to the settings tab", async ({ page }) => {
    await bootMobile(page);
    await page.getByTestId("mobile-open-settings").click();
    await expect(page.getByTestId("mobile-settings")).toBeVisible({ timeout: 20_000 });
  });
});
