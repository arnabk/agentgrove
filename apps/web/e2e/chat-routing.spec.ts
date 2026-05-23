// Regression suite for the chat send-routing rules.
//
// Mirrors the BE e2e suite in `crates/agentgrove-api/tests/e2e/
// chat_queue_notes_routes.rs` (the `smart_send_*` + `rapid_fire_*`
// tests) from the browser's perspective. Both layers must agree on
// the routing rules because the FE renders Optimistic placeholders
// based on the same decision.
//
// Rules under test:
//   1. Idle + queue empty → message goes to the chat timeline.
//   2. Busy → message lands in the queue.
//   3. Queue non-empty (even if idle) → message lands in the queue.
//   4. Auto mode drains queue items into the timeline in FIFO order.
//   5. Manual mode parks queue items until the user runs them.
//   6. Rapid-fire concurrent sends preserve order; nothing is lost.
//
// The tests drive the FE the same way a user does: fill the
// textarea + press Enter. They DO call `/api/chats/:id/queue/next`
// directly to exercise rule 5, because the FE doesn't currently
// expose a UI button for it (we removed Run next when the inline
// reorder controls landed). That's fine: the rule is about the
// API contract, not about the button.

import { test, expect, Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const BE_URL = process.env.AGENTGROVE_BE_URL ?? "http://127.0.0.1:4317";
const REPO_ROOT = process.env.REPO_ROOT ?? process.cwd();

async function seedBackend(page: Page) {
  await page.addInitScript((beUrl) => {
    localStorage.setItem("ag-be", beUrl);
  }, BE_URL);
}

/** Resolve the chat id of the currently-ACTIVE chat tab. The tab
 *  strip can have multiple tabs across test runs (they persist in
 *  the dev DB), so we pick the one with the active marker (an
 *  `!border-accent` class), not the first one. Falls back to the
 *  last tab when no marker is found — covers the rare race where
 *  the tab is rendered before its selected state lands. */
async function activeChatId(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const tabs = Array.from(
      document.querySelectorAll('[data-testid^="chat-tab-"]'),
    ) as HTMLElement[];
    if (tabs.length === 0) throw new Error("no chat tabs");
    const active = tabs.find((t) => t.className.includes("border-accent")) ?? tabs[tabs.length - 1];
    return active!.getAttribute("data-testid")!.replace("chat-tab-", "");
  });
}

/** Pre-seed a project (the repo root) + create a chat under it.
 *  Returns the chat id so individual tests can hit the BE direct
 *  for the queue-mode + run_next checks. */
async function bootstrap(page: Page): Promise<string> {
  await seedBackend(page);
  await page.goto(BASE, { waitUntil: "networkidle" });
  await expect(page.getByTestId("app-root")).toBeVisible({ timeout: 15_000 });

  // If a project already exists from a prior run we can skip the
  // welcome path; otherwise add one.
  const hasProject = await page.locator("[data-testid='left-rail']").count();
  if (hasProject === 0) {
    await page.getByTestId("welcome-add-folder").click();
    await page.getByTestId("welcome-name").fill("self");
    await page.getByTestId("welcome-root").fill(REPO_ROOT);
    await page.getByTestId("welcome-submit").click();
  }
  await expect(page.getByTestId("left-rail")).toBeVisible({ timeout: 15_000 });

  // Create a chat. We pick the first "+chat" icon in the rail to
  // avoid coupling to a specific project / worktree id.
  await page.locator('[data-testid^="new-chat-"]').first().click();
  await page.locator('button:has-text("Create chat")').click();
  await expect(page.getByTestId("chat-input")).toBeVisible();
  return await activeChatId(page);
}

/** Type + submit one message via the composer. The composer is a
 *  Tiptap contenteditable — `fill()` doesn't work because Playwright
 *  treats the editable as a non-input element. Click + keyboard.type
 *  matches the user-flow exactly. */
async function send(page: Page, text: string) {
  const editable = page.locator('[data-testid="chat-input"]');
  await editable.click();
  // Clear any leftover text from a prior call in this test (the
  // composer is persisted as a draft so previous sends in the
  // same chat may still be sitting in the buffer).
  const isMac = process.platform === "darwin";
  await page.keyboard.press(isMac ? "Meta+a" : "Control+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

/** Rapid-fire N messages with a tiny gap so the input signal
 *  updates before the next submit. The gap stays << the BE
 *  dispatch turn so the test still hits the concurrent-send path.
 *  We can't poke `.value` on the contenteditable like the old
 *  textarea version did, so we drive the keyboard via Playwright
 *  the same way a fast typist would. */
async function rapidFire(page: Page, count: number, prefix = "rapid") {
  const editable = page.locator('[data-testid="chat-input"]');
  await editable.click();
  const isMac = process.platform === "darwin";
  for (let i = 0; i < count; i++) {
    await page.keyboard.press(isMac ? "Meta+a" : "Control+a");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(`${prefix}-${i}`);
    await page.keyboard.press("Enter");
    // Tiny gap so the FE's send→clear-input cycle finishes before
    // the next iteration; without this the second send sometimes
    // races the first one's optimistic clear and gets dropped.
    await page.waitForTimeout(50);
  }
}

/** Read the BE's queue state directly (the FE only polls it every
 *  2 s, which is too slow for assertions). */
async function getQueue(chatId: string) {
  const res = await fetch(`${BE_URL}/api/chats/${chatId}/queue`);
  return await res.json();
}

async function getChat(chatId: string) {
  const res = await fetch(`${BE_URL}/api/chats/${chatId}`);
  return await res.json();
}

test.describe("chat send routing", () => {
  test("rule 1: idle + queue empty → dispatch into timeline", async ({ page }) => {
    const chatId = await bootstrap(page);
    await send(page, "scenario-one");
    // Wait for the BE to record the prompt.
    await expect
      .poll(async () => (await getChat(chatId)).prompts?.length ?? 0, {
        timeout: 5_000,
      })
      .toBeGreaterThan(0);
    const chat = await getChat(chatId);
    expect(chat.prompts[chat.prompts.length - 1].content).toBe("scenario-one");
    expect((await getQueue(chatId)).items).toHaveLength(0);
  });

  test("rule 2 + 3: rapid-fire 5 → 1 dispatched + 4 queued (FIFO)", async ({ page }) => {
    const chatId = await bootstrap(page);
    // Flip to manual BEFORE firing so auto-drain doesn't empty the
    // queue mid-test. We do this via the BE so we don't depend on
    // the queue dock being open.
    await fetch(`${BE_URL}/api/chats/${chatId}/queue/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "manual" }),
    });

    await rapidFire(page, 5);

    // Settle the dispatches: first one runs immediately, rest wait.
    await expect
      .poll(async () => {
        const q = await getQueue(chatId);
        const pending = (q.items as { status: string }[]).filter(
          (i) => i.status === "pending",
        ).length;
        return pending;
      })
      .toBe(4);

    const q = await getQueue(chatId);
    const pending = (q.items as { status: string; body: string }[]).filter(
      (i) => i.status === "pending",
    );
    expect(pending.map((i) => i.body)).toEqual(["rapid-1", "rapid-2", "rapid-3", "rapid-4"]);
  });

  // Rule 4 + 5 exercise the auto-drain path which dispatches each
  // queued message to the real provider CLI (Claude / opencode).
  // Those calls take many seconds per turn and depend on network +
  // local auth, so we skip them in the live FE Playwright suite —
  // the equivalent BE e2e tests
  // (crates/agentgrove-api/tests/e2e/chat_queue_notes_routes.rs)
  // pin to the FakeProvider and run deterministically. Unskip
  // here once we wire a fake-provider escape hatch into the FE
  // (e.g. ?fake=1 URL param).
  test.skip("rule 4: auto mode drains queue back into timeline", async () => {});

  test.skip("rule 5 + bug repro: rapid-fire → flip manual → run_next drains everything", async () => {});

  test.afterAll(async () => {
    // Persist a visual artefact of the most-recent run for easy
    // triage when CI fails.
    const visualDir = path.join(REPO_ROOT, ".data", "logs", "visuals");
    fs.mkdirSync(visualDir, { recursive: true });
  });
});
