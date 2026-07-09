import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

import { seedBackend } from "./helpers";

const DEMOS_DIR = path.join(process.cwd(), "..", "..", "docs", "demos");
const RESULTS_DIR = path.join(process.cwd(), "test-results");
const BE_URL = process.env.AGENTGROVE_BE_URL ?? "http://127.0.0.1:4320";
const REPO_ROOT = process.env.REPO_ROOT ?? "/home/agentgrove/.data/demo-project";

async function waitForHydrated(page: Page) {
  await page.waitForSelector('[data-testid="project-list"], [data-testid="welcome"]', {
    state: "visible",
    timeout: 30_000,
  });
  await page.waitForTimeout(500);
}

async function waitForToast(page: Page) {
  try {
    await page.waitForSelector('[data-testid^="toast-"]', { state: "visible", timeout: 3_000 });
    await page.waitForTimeout(8_000);
  } catch {
    // ignore
  }
}

async function recordFeature(page: Page, setup: () => Promise<void>) {
  await seedBackend(page);
  await page.goto("/");
  await waitForHydrated(page);
  await waitForToast(page);
  await setup();
  await page.waitForTimeout(2000);
}

async function ensureProject(): Promise<string> {
  const res = await fetch(`${BE_URL}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "demo", root: REPO_ROOT }),
  });
  if (!res.ok) {
    const list = await fetch(`${BE_URL}/api/projects`).then((r) => r.json());
    return list[0].id;
  }
  const created = await res.json();
  return created.id;
}

async function createChat(projectId: string, provider: string, model: string): Promise<string> {
  const res = await fetch(`${BE_URL}/api/projects/${projectId}/chats`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Demo chat", provider, model }),
  });
  const created = await res.json();
  return created.id;
}

async function openChat(page: Page, chatId: string, projectId: string) {
  await page.goto(`/p/${projectId}?chat=${chatId}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="app-root"]', { state: "visible", timeout: 15_000 });
  await page.waitForTimeout(500);
  await expect(
    page.locator('.ag-shell [data-testid="chat-input"]').filter({ visible: true }).first(),
  ).toBeVisible({ timeout: 15_000 });
}

async function typeIntoComposer(page: Page, text: string) {
  const editable = page
    .locator('.ag-shell [data-testid="chat-input"]')
    .filter({ visible: true })
    .first();
  await editable.click();
  await page.keyboard.type(text);
  await page.waitForTimeout(500);
}

async function send(page: Page) {
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
}

function copyVideos() {
  fs.mkdirSync(DEMOS_DIR, { recursive: true });
  if (!fs.existsSync(RESULTS_DIR)) return;
  const entries = fs.readdirSync(RESULTS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Only copy videos produced by the demo specs; other specs also
    // record on failure and we don't want them landing in docs/demos.
    if (!entry.name.startsWith("demos-demo-videos-")) continue;
    const src = path.join(RESULTS_DIR, entry.name, "video.webm");
    if (!fs.existsSync(src)) continue;
    const parts = entry.name.split("-");
    const title = parts.length > 3 ? parts.slice(3, -1).join("-") : entry.name;
    const dest = path.join(DEMOS_DIR, `${title}.webm`);
    fs.copyFileSync(src, dest);
    console.log(`[demo] video saved to ${dest}`);
  }
}

test.describe("demo videos", () => {
  test.afterAll(() => copyVideos());

  test("overview", async ({ page }) => {
    await recordFeature(page, async () => {
      const project = page.locator('[data-testid^="project-"]').first();
      await expect(project).toBeVisible();
      await project.click();
      await page.waitForTimeout(500);
    });
  });

  test("ai-chat", async ({ page }) => {
    test.setTimeout(60_000);
    const projectId = await ensureProject();
    const chatId = await createChat(projectId, "opencode", "9router/cc/claude-sonnet-4-6");
    await recordFeature(page, async () => {
      await openChat(page, chatId, projectId);
      await typeIntoComposer(page, "Write a one-sentence greeting for a developer landing page");
      await send(page);
      // Wait for streaming response to complete.
      await page.waitForTimeout(20_000);
    });
  });

  test("team chat", async ({ page }) => {
    await recordFeature(page, async () => {
      const teamChatTab = page.getByRole("button", { name: "Team Chat" });
      await teamChatTab.click();
      await page.waitForTimeout(500);
    });
  });

  test("prompt-queue", async ({ page }) => {
    test.setTimeout(60_000);
    const projectId = await ensureProject();
    const chatId = await createChat(projectId, "opencode", "9router/cc/claude-sonnet-4-6");
    await recordFeature(page, async () => {
      await openChat(page, chatId, projectId);
      await typeIntoComposer(page, "Explain the benefits of Git worktrees in detail");
      await send(page);
      await page.waitForTimeout(1000);
      // Second message auto-enqueues while the first is streaming.
      await typeIntoComposer(page, "Show a short code example");
      await send(page);
      // Wait for both prompts to stream through.
      await page.waitForTimeout(25_000);
    });
  });

  test("left rail toggle", async ({ page }) => {
    await recordFeature(page, async () => {
      const toggle = page.locator('[data-testid="left-rail-toggle"]');
      await toggle.click();
      await page.waitForTimeout(1000);
      await toggle.click();
    });
  });

  test("settings", async ({ page }) => {
    await recordFeature(page, async () => {
      const settings = page.locator('[data-testid="open-settings"]');
      await settings.click();
      await page.waitForTimeout(1000);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
    });
  });
});
