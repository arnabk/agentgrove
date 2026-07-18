import { test, expect, Page } from "@playwright/test";
import { bootstrapWithChat, BE_URL, getChat, clearComposer, send as sendViaUI } from "./helpers";

async function sendViaApi(chatId: string, content: string) {
  const res = await fetch(`${BE_URL}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`sendViaApi failed: ${res.status}`);
}

async function getTimelineScroll(page: Page) {
  return await page.evaluate(() => {
    const elements = Array.from(
      document.querySelectorAll('[data-testid="chat-timeline"]'),
    ) as HTMLElement[];
    const el = elements.find((e) => e.clientHeight > 0) ?? elements[0] ?? null;
    if (!el) return null;
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
  });
}

async function isAtBottom(page: Page, threshold = 10) {
  const scroll = await getTimelineScroll(page);
  if (!scroll) return false;
  return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= threshold;
}

async function getVisibleTimelineCenter(page: Page) {
  return page.evaluate(() => {
    const elements = Array.from(
      document.querySelectorAll('[data-testid="chat-timeline"]'),
    ) as HTMLElement[];
    const el = elements.find((e) => e.clientHeight > 0) ?? elements[0] ?? null;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
}

async function scrollToBottom(page: Page) {
  const center = await getVisibleTimelineCenter(page);
  if (!center) throw new Error("No visible chat timeline");
  await page.mouse.move(center.x, center.y);
  await page.mouse.wheel(0, 100_000);
  await page.waitForTimeout(200);
}

async function scrollUp(page: Page, amount = 800) {
  const center = await getVisibleTimelineCenter(page);
  if (!center) throw new Error("No visible chat timeline");
  await page.mouse.move(center.x, center.y);
  await page.mouse.wheel(0, -amount);
  await page.waitForTimeout(200);
}

test.describe("chat scroll behavior", () => {
  test("keeps bottom when at bottom, preserves position when scrolled up", async ({ page }) => {
    const chatId = await bootstrapWithChat(page);
    await clearComposer(page);

    // Send enough tall messages to make the timeline scrollable.
    for (let i = 0; i < 30; i++) {
      await sendViaApi(chatId, `scroll-test-message-${i}\n${"x".repeat(800)}`);
    }
    // Wait for the FE to receive and render all messages.
    await expect
      .poll(async () => (await getChat(chatId)).prompts?.length ?? 0, {
        timeout: 60_000,
        intervals: [500],
      })
      .toBeGreaterThanOrEqual(30);

    // Wait for the virtualizer to settle and the timeline to become scrollable.
    await expect
      .poll(
        async () => {
          const scroll = await getTimelineScroll(page);
          return scroll ? scroll.scrollHeight - scroll.clientHeight : 0;
        },
        { timeout: 15_000, intervals: [200] },
      )
      .toBeGreaterThan(100);

    console.log("after load", await getTimelineScroll(page));

    // Initial load should be at the bottom.
    await expect.poll(async () => await isAtBottom(page)).toBe(true);

    // Scroll up away from the bottom.
    await scrollUp(page, 1200);
    await page.waitForTimeout(300);
    console.log("after scroll up", await getTimelineScroll(page));
    await expect.poll(async () => await isAtBottom(page)).toBe(false);
    const scrollBefore = await getTimelineScroll(page);

    // Send a new message while scrolled up; the reading position should be preserved.
    await sendViaApi(chatId, "scrolled-up-message");
    await expect
      .poll(async () => (await getChat(chatId)).prompts?.length ?? 0, {
        timeout: 30_000,
        intervals: [500],
      })
      .toBeGreaterThanOrEqual(16);
    await page.waitForTimeout(1000);

    const scrollAfter = await getTimelineScroll(page);
    expect(scrollAfter!.scrollTop).toBeCloseTo(scrollBefore!.scrollTop, 0);
    expect(await isAtBottom(page)).toBe(false);

    // Scroll back to the bottom and send a message; it should stay at the bottom.
    await scrollToBottom(page);
    await page.waitForTimeout(300);
    await expect.poll(async () => await isAtBottom(page)).toBe(true);

    await sendViaApi(chatId, "bottom-message");
    await expect
      .poll(async () => (await getChat(chatId)).prompts?.length ?? 0, {
        timeout: 30_000,
        intervals: [500],
      })
      .toBeGreaterThanOrEqual(17);
    await page.waitForTimeout(1000);

    await expect.poll(async () => await isAtBottom(page)).toBe(true);
  });

  test("stays at the bottom when sending via the UI composer", async ({ page }) => {
    const chatId = await bootstrapWithChat(page);
    await clearComposer(page);

    for (let i = 0; i < 30; i++) {
      await sendViaApi(chatId, `scroll-test-message-${i}\n${"x".repeat(800)}`);
    }
    await expect
      .poll(async () => (await getChat(chatId)).prompts?.length ?? 0, {
        timeout: 60_000,
        intervals: [500],
      })
      .toBeGreaterThanOrEqual(30);

    await expect
      .poll(
        async () => {
          const scroll = await getTimelineScroll(page);
          return scroll ? scroll.scrollHeight - scroll.clientHeight : 0;
        },
        { timeout: 15_000, intervals: [200] },
      )
      .toBeGreaterThan(100);

    await expect.poll(async () => await isAtBottom(page)).toBe(true);

    await sendViaUI(page, "bottom-ui-message");
    await expect
      .poll(async () => (await getChat(chatId)).prompts?.length ?? 0, {
        timeout: 30_000,
        intervals: [500],
      })
      .toBeGreaterThanOrEqual(31);
    await page.waitForTimeout(500);

    await expect.poll(async () => await isAtBottom(page)).toBe(true);
  });
});
