import { type Page } from "@playwright/test";

export const BE_URL = process.env.AGENTGROVE_BE_URL ?? "http://127.0.0.1:4320";
export const REPO_ROOT = process.env.REPO_ROOT ?? "/home/agentgrove/.data/demo-project";

export async function ensureProject(): Promise<string> {
  const res = await fetch(`${BE_URL}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "demo", root: REPO_ROOT }),
  });
  if (!res.ok) {
    const list = await fetch(`${BE_URL}/api/projects`).then((r) => r.json());
    if (list.length === 0) throw new Error("failed to create demo project");
    return list[0].id;
  }
  const created = await res.json();
  return created.id;
}

export async function createChat(projectId: string, provider: string, model: string): Promise<string> {
  const res = await fetch(`${BE_URL}/api/projects/${projectId}/chats`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Demo chat", provider, model }),
  });
  const created = await res.json();
  return created.id;
}

export async function waitForHydrated(page: Page) {
  await page.waitForSelector('[data-testid="project-list"], [data-testid="welcome"]', {
    state: "visible",
    timeout: 30_000,
  });
  await page.waitForTimeout(500);
}

export async function waitForToast(page: Page) {
  try {
    await page.waitForSelector('[data-testid^="toast-"]', { state: "visible", timeout: 3_000 });
    await page.waitForTimeout(8_000);
  } catch {
    // ignore
  }
}

export async function openChat(page: Page, chatId: string, projectId: string) {
  await page.goto(`/p/${projectId}?chat=${chatId}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="app-root"]', { state: "visible", timeout: 15_000 });
  await page.waitForTimeout(500);
}

export async function getVisibleComposer(page: Page) {
  return page
    .locator('.ag-shell [data-testid="chat-input"]')
    .filter({ visible: true })
    .first();
}

export async function typeIntoComposer(page: Page, text: string) {
  const composer = await getVisibleComposer(page);
  await composer.click();
  await page.keyboard.type(text);
  await page.waitForTimeout(500);
}

export async function send(page: Page) {
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
}
