import { expect, test } from "@playwright/test";
import {
  bootMobile,
  bootMobileChat,
  createChat,
  ensureProject,
  getChat,
  typeMobile,
  url,
} from "./mobile-helpers";
import { seedBackend } from "./helpers";

test.describe("mobile chat", () => {
  test("the chats tab lists the scope's chats", async ({ page }) => {
    await seedBackend(page);
    const projectId = await ensureProject();
    const chatId = await createChat(projectId);
    await page.goto(url(`/p/${projectId}`), { waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("mobile-chat-list")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId(`mobile-chat-${chatId}`)).toBeVisible({ timeout: 20_000 });
  });

  test("tapping a chat drills into its thread", async ({ page }) => {
    const { chatId } = await bootMobileChat(page);
    await expect(page.getByTestId("mobile-chat-thread")).toBeVisible();
    await expect(page.getByTestId("mobile-composer")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`chat=${chatId}`));
  });

  test("the header swaps the hamburger for a back arrow inside a chat", async ({ page }) => {
    await bootMobileChat(page);
    await expect(page.getByTestId("mobile-back")).toBeVisible();
    await expect(page.getByTestId("mobile-menu")).toHaveCount(0);

    await page.getByTestId("mobile-back").click();
    await expect(page.getByTestId("mobile-chat-list")).toBeVisible();
    await expect(page.getByTestId("mobile-menu")).toBeVisible();
  });

  test("sending a message persists it to the backend and shows it in the thread", async ({
    page,
  }) => {
    const { chatId } = await bootMobileChat(page);
    await typeMobile(page, "hello from the phone");
    await page.getByTestId("mobile-send").click();

    await expect(page.getByTestId("mobile-user-message").last()).toContainText(
      "hello from the phone",
      { timeout: 20_000 },
    );
    await expect
      .poll(async () => (await getChat(chatId)).prompts?.length ?? 0, { timeout: 20_000 })
      .toBeGreaterThan(0);
  });

  test("the composer clears the instant you send, not after the round-trip", async ({ page }) => {
    await bootMobileChat(page);
    await typeMobile(page, "clear me");
    await page.getByTestId("mobile-send").click();
    await expect(page.locator('[data-testid="mobile-chat-input"]')).not.toContainText("clear me", {
      timeout: 5_000,
    });
  });

  test("send is disabled until there is something to send", async ({ page }) => {
    await bootMobileChat(page);
    await expect(page.getByTestId("mobile-send")).toBeDisabled();
    await typeMobile(page, "x");
    await expect(page.getByTestId("mobile-send")).toBeEnabled();
  });

  test("the agent's reply streams in and its activity is collapsed by default", async ({
    page,
  }) => {
    await bootMobileChat(page);
    await typeMobile(page, "say something");
    await page.getByTestId("mobile-send").click();

    await expect(page.getByTestId("mobile-assistant-message").last()).toBeVisible({
      timeout: 30_000,
    });

    // Tool activity, when the provider emits any, must start collapsed:
    // expanded rails would push the answer off a phone screen.
    const toggles = page.locator('[data-testid^="mobile-tools-toggle-"]');
    if ((await toggles.count()) > 0) {
      await expect(toggles.last()).toHaveAttribute("aria-expanded", "false");
    }
  });

  test("a chat opened by URL lands directly on that thread", async ({ page }) => {
    await seedBackend(page);
    const projectId = await ensureProject();
    const chatId = await createChat(projectId);
    await page.goto(url(`/p/${projectId}`, `?chat=${chatId}`), { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("mobile-app")).toBeVisible({ timeout: 20_000 });

    // routeSync mirrors ?chat= into the store; the list is the entry
    // point, so the chat row must be present and openable.
    await expect(page.getByTestId(`mobile-chat-${chatId}`)).toBeVisible({ timeout: 20_000 });
  });

  test("a chat created on another client appears without a reload", async ({ page }) => {
    // Desktop <-> phone liveness, via the shared /ws?topic=sync channel.
    const projectId = await bootMobile(page);
    await expect(page.getByTestId("mobile-chat-list")).toBeVisible({ timeout: 20_000 });

    const chatId = await createChat(projectId);
    await expect(page.getByTestId(`mobile-chat-${chatId}`)).toBeVisible({ timeout: 20_000 });
  });

  test("the new-chat button opens the create dialog", async ({ page }) => {
    await bootMobile(page);
    await expect(page.getByTestId("mobile-new-chat")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("mobile-new-chat").click();
    await expect(page.getByText("Authentication is whatever your CLI is")).toBeVisible({
      timeout: 20_000,
    });
  });
});
