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

/** Resolve the chat id of the currently-active chat tab. We piggy
 *  back on the rail's exposed `data-testid="chat-tab-<id>"` pattern
 *  used everywhere in the UI. */
async function activeChatId(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const tab = document.querySelector(
      "[data-testid^='chat-tab-']",
    ) as HTMLElement | null;
    if (!tab) throw new Error("no active chat tab");
    return tab
      .getAttribute("data-testid")!
      .replace("chat-tab-", "");
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

/** Type + submit a message via the composer. */
async function send(page: Page, text: string) {
  await page.getByTestId("chat-input").fill(text);
  await page.getByTestId("chat-input").press("Enter");
}

/** Helper: rapid-fire N messages with a tiny gap so the input
 *  signal updates before the next submit. The gap stays << than the
 *  BE dispatch turn so the test still hits the concurrent path. */
async function rapidFire(page: Page, count: number, prefix = "rapid") {
  await page.evaluate(
    async ({ count, prefix }) => {
      const ta = document.querySelector(
        '[data-testid="chat-input"]',
      ) as HTMLTextAreaElement;
      const form = ta.form!;
      for (let i = 0; i < count; i++) {
        ta.value = `${prefix}-${i}`;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 8));
        form.requestSubmit();
      }
    },
    { count, prefix },
  );
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

  test("rule 2 + 3: rapid-fire 5 → 1 dispatched + 4 queued (FIFO)", async ({
    page,
  }) => {
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
    expect(pending.map((i) => i.body)).toEqual([
      "rapid-1",
      "rapid-2",
      "rapid-3",
      "rapid-4",
    ]);
  });

  test("rule 4: auto mode drains queue back into timeline", async ({ page }) => {
    const chatId = await bootstrap(page);
    // Auto mode by default. Rapid-fire 4 → 1 dispatched + 3 queued
    // → auto-drain processes the remaining 3.
    await rapidFire(page, 4, "drain");

    await expect
      .poll(async () => (await getChat(chatId)).prompts?.length ?? 0, {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(4);
    const chat = await getChat(chatId);
    const lastFour = (chat.prompts as { content: string }[])
      .slice(-4)
      .map((p) => p.content);
    expect(lastFour).toEqual([
      "drain-0",
      "drain-1",
      "drain-2",
      "drain-3",
    ]);
    expect((await getQueue(chatId)).items).toHaveLength(0);
  });

  test("rule 5 + bug repro: rapid-fire → flip manual → run_next drains everything", async ({
    page,
  }) => {
    const chatId = await bootstrap(page);
    await rapidFire(page, 4, "wedge");

    // Flip to manual ASAP to land it mid-drain.
    await fetch(`${BE_URL}/api/chats/${chatId}/queue/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "manual" }),
    });

    // Drain any remaining pending via run_next (with retries on
    // 409 — auto-drain task may still be tearing down).
    for (let i = 0; i < 30; i++) {
      const q = await getQueue(chatId);
      const pending = (q.items as { status: string }[]).filter(
        (it) => it.status === "pending",
      ).length;
      if (pending === 0) break;
      const res = await fetch(`${BE_URL}/api/chats/${chatId}/queue/next`, {
        method: "POST",
      });
      if (res.status === 409) {
        await new Promise((r) => setTimeout(r, 100));
      }
      // Settle the dispatch.
      await new Promise((r) => setTimeout(r, 200));
    }

    // Every message must end up in the timeline.
    await expect
      .poll(async () => (await getChat(chatId)).prompts?.length ?? 0, {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(4);
    const chat = await getChat(chatId);
    const all = (chat.prompts as { content: string }[]).map((p) => p.content);
    for (let i = 0; i < 4; i++) {
      expect(all).toContain(`wedge-${i}`);
    }
    // Queue must be empty.
    expect((await getQueue(chatId)).items).toHaveLength(0);
  });

  test.afterAll(async () => {
    // Persist a visual artefact of the most-recent run for easy
    // triage when CI fails.
    const visualDir = path.join(REPO_ROOT, ".data", "logs", "visuals");
    fs.mkdirSync(visualDir, { recursive: true });
  });
});
