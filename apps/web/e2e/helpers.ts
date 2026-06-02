// Shared helpers for AgentGrove Playwright specs. Centralises the
// bootstrap + composer-typing + BE-query patterns so individual
// specs stay focused on their behaviour. Keeps the same shape as
// the inline helpers in `chat-routing.spec.ts` so existing tests
// can adopt this file later without re-learning the API.

import { expect, Page } from "@playwright/test";

export const BASE = process.env.BASE_URL ?? "http://localhost:5173";
export const BE_URL = process.env.AGENTGROVE_BE_URL ?? "http://127.0.0.1:4317";
export const REPO_ROOT = process.env.REPO_ROOT ?? process.cwd();

/** Tell the FE which BE to talk to before any module imports run.
 *  The localStorage key is read by the api/client module on first
 *  load; without this hook the FE defaults to same-origin which
 *  fails in headless Playwright runs against a separate BE port. */
export async function seedBackend(page: Page) {
  await page.addInitScript((beUrl) => {
    localStorage.setItem("ag-be", beUrl);
  }, BE_URL);
}

/** Boot the app + ensure at least one project + an open chat exist.
 *  Returns the chat id for direct BE queries.
 *
 *  Idempotent: re-uses the existing project when one is already
 *  registered on the BE (every spec shares the same dev DB and we
 *  don't want a project-per-test explosion). The chat creation
 *  step always runs since chats are per-test ephemeral. */
export async function bootstrapWithChat(page: Page): Promise<string> {
  await seedBackend(page);
  await page.goto(BASE, { waitUntil: "networkidle" });
  await expect(page.getByTestId("app-root")).toBeVisible({ timeout: 15_000 });

  const hasProject = await page.locator("[data-testid='left-rail']").count();
  if (hasProject === 0) {
    await fetch(`${BE_URL}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "self", root: REPO_ROOT }),
    });
  }
  await expect(page.getByTestId("left-rail")).toBeVisible({ timeout: 15_000 });

  // Create a fresh chat. We click the first "+chat" row icon to
  // avoid coupling to a specific project id.
  await page.locator('[data-testid^="new-chat-"]').first().click();
  await page.locator('button:has-text("Create chat")').click();
  await expect(page.getByTestId("chat-input")).toBeVisible();
  return await activeChatId(page);
}

/** Active chat id derived from the rendered `chat-tab-<id>` testid.
 *  The tab strip can carry multiple tabs across runs (dev DB
 *  persists everything); we pick the one with the active marker
 *  (`!border-accent` class) rather than the first one so freshly-
 *  created chats are returned even when older tabs sit to the
 *  left. */
export async function activeChatId(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const tabs = Array.from(
      document.querySelectorAll('[data-testid^="chat-tab-"]'),
    ) as HTMLElement[];
    if (tabs.length === 0) throw new Error("no chat tabs");
    const active = tabs.find((t) => t.className.includes("border-accent")) ?? tabs[tabs.length - 1];
    return active!.getAttribute("data-testid")!.replace("chat-tab-", "");
  });
}

/** Focus the rich-text composer and type `text`. The composer is a
 *  Tiptap contenteditable, NOT a textarea — `fill()` doesn't work
 *  because Playwright treats the host as a non-input element.
 *
 *  Tiptap puts our `data-testid="chat-input"` directly on the
 *  ProseMirror editable element (NOT a wrapper), so clicking the
 *  selector itself plants the caret. The 600 ms post-type wait
 *  lets `scheduleScopeLayoutWrite` debounce (~400 ms) flush the
 *  draft to the BE before the test does anything reload-shaped. */
export async function typeIntoComposer(page: Page, text: string) {
  const editable = page.locator('[data-testid="chat-input"]');
  await editable.click();
  await page.keyboard.type(text);
  await page.waitForTimeout(600);
}

/** Clear the composer's contents. ProseMirror's preferred clearing
 *  gesture is Ctrl/Cmd+A then Backspace; this works on every
 *  supported OS and keeps the editor's history intact. */
export async function clearComposer(page: Page) {
  const editable = page.locator('[data-testid="chat-input"]');
  await editable.click();
  const isMac = process.platform === "darwin";
  await page.keyboard.press(isMac ? "Meta+a" : "Control+a");
  await page.keyboard.press("Backspace");
}

/** Submit the composer via plain Enter (the routing the user sees). */
export async function submitComposer(page: Page) {
  const editable = page.locator('[data-testid="chat-input"]');
  await editable.press("Enter");
}

/** Read the composer's current text content. Strips ProseMirror's
 *  per-block trailing newlines for stable matching. */
export async function readComposer(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const root = document.querySelector('[data-testid="chat-input"]') as HTMLElement | null;
    if (!root) return "";
    return (root.innerText ?? "").trim();
  });
}

/** Read the BE's queue state directly. The FE only polls it every
 *  second, which is too slow for tight assertions. */
export async function getQueue(chatId: string) {
  const res = await fetch(`${BE_URL}/api/chats/${chatId}/queue`);
  return await res.json();
}

export async function getChat(chatId: string) {
  const res = await fetch(`${BE_URL}/api/chats/${chatId}`);
  return await res.json();
}
