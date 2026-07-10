import { test, expect } from "@playwright/test";
import {
  ensureProject,
  waitForHydrated,
  waitForToast,
  waitForRecordingStart,
} from "./demo-helpers";

test("team chat", async ({ page }) => {
  test.setTimeout(30_000);
  await ensureProject();

  await page.goto("/");
  await waitForHydrated(page);
  await waitForToast(page);
  await waitForRecordingStart();

  const teamChatTab = page.getByRole("button", { name: "Team Chat" });
  await expect(teamChatTab).toBeVisible({ timeout: 10_000 });
  await teamChatTab.click();
  await page.waitForTimeout(1000);

  const input = page
    .locator('[data-testid="team-chat-input"]')
    .or(page.locator("textarea"))
    .filter({ visible: true })
    .first();
  if ((await input.count()) > 0) {
    await input.click();
    await page.keyboard.type("Looks like the new build is ready");
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(1500);
});
