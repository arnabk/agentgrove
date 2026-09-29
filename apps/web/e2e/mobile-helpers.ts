// Helpers for the `mobile` Playwright project. Shares the backend
// seeding in ./helpers and adds the mobile shell's own waits.

import { expect, Page } from "@playwright/test";
import { BASE, createChat, ensureProject, seedBackend } from "./helpers";

export { BE_URL, createChat, ensureProject, getChat } from "./helpers";

export const url = (path = "", qs = "") => `${BASE.replace(/\/$/, "")}${path}${qs}`;

/** Boot the mobile shell with at least one project registered. */
export async function bootMobile(page: Page): Promise<string> {
  await seedBackend(page);
  const projectId = await ensureProject();
  await page.goto(url(`/p/${projectId}`), { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("mobile-app")).toBeVisible({ timeout: 20_000 });
  return projectId;
}

/** Boot straight into a chat's thread, using the fake provider so no
 *  real agent CLI is needed on the runner. */
export async function bootMobileChat(page: Page): Promise<{ projectId: string; chatId: string }> {
  await seedBackend(page);
  const projectId = await ensureProject();
  const chatId = await createChat(projectId);
  await page.goto(url(`/p/${projectId}`, `?chat=${chatId}`), { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("mobile-app")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId(`mobile-chat-${chatId}`).click();
  await expect(page.getByTestId("mobile-chat-view")).toBeVisible({ timeout: 20_000 });
  return { projectId, chatId };
}

/** Type into the mobile Tiptap composer. */
export async function typeMobile(page: Page, text: string) {
  const input = page.locator('[data-testid="mobile-chat-input"]');
  await input.click();
  await input.pressSequentially(text, { delay: 8 });
}
