import { test, expect, type Page } from "@playwright/test";

const BE_URL = process.env.AGENTGROVE_BE_URL ?? "http://127.0.0.1:4320";
const REPO_ROOT = process.env.REPO_ROOT ?? "/home/agentgrove/.data/demo-project";

async function seedBackend(page: Page) {
  // Create a project via the API so the UI has something to show.
  const res = await fetch(`${BE_URL}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "demo", root: REPO_ROOT }),
  });
  if (!res.ok) {
    // Project may already exist; list and use the first one.
    const list = await fetch(`${BE_URL}/api/projects`).then((r) => r.json());
    if (list.length === 0) throw new Error("failed to create demo project");
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

test("ai chat overview", async ({ page }) => {
  test.setTimeout(60_000);
  const projectId = await seedBackend(page);
  const chatId = await createChat(projectId, "opencode", "9router/cc/claude-sonnet-4-6");

  await page.goto("/");
  await waitForHydrated(page);
  await waitForToast(page);

  // Open the demo chat.
  await page.goto(`/p/${projectId}?chat=${chatId}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="app-root"]', { state: "visible", timeout: 15_000 });
  await page.waitForTimeout(500);

  const composer = page
    .locator('.ag-shell [data-testid="chat-input"]')
    .filter({ visible: true })
    .first();
  await expect(composer).toBeVisible({ timeout: 15_000 });

  // Type a short prompt so the video shows real typing.
  await composer.click();
  await page.keyboard.type("Say hi like a friendly coding assistant");
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter");

  // Wait for the streaming response to complete.
  await page.waitForTimeout(20_000);
});
