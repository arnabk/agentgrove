import { test, expect } from "@playwright/test";
import {
  ensureProject,
  waitForHydrated,
  waitForRecordingStart,
  waitForToast,
  REPO_ROOT,
} from "./demo-helpers";

test("git diff view", async ({ page }) => {
  test.setTimeout(90_000);
  await ensureProject();

  await page.goto("/");
  await waitForHydrated(page);
  await waitForToast(page);
  await waitForRecordingStart();

  // Scene 1: Select the project so the left rail shows the Changes action.
  const project = page.locator('[data-testid^="project-"]').first();
  await expect(project).toBeVisible();
  await project.click();
  await page.waitForTimeout(2_500);

  // Scene 2: Make a small change to a file so the diff has content.
  const readme = page.locator(`[data-testid="tree-file-${REPO_ROOT}/README.md"]`);
  await readme.waitFor({ state: "visible", timeout: 10_000 });
  await readme.click();
  await page.waitForTimeout(2_500);

  const editor = page.locator('[data-testid="editor-pane"] .cm-content').first();
  await editor.waitFor({ state: "visible", timeout: 10_000 });
  await editor.click();
  await page.keyboard.press("End");
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter");
  await page.keyboard.type("<!-- Demo edit -->", { delay: 40 });
  await page.waitForTimeout(1_500);
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(2_000);

  // Scene 3: Open the Changes panel from the project menu.
  const menu = page.locator('[data-testid^="project-menu-"]').first();
  await menu.click();
  await page.waitForTimeout(1_500);
  const changes = page.locator('[data-testid^="changes-"]').first();
  await changes.click();
  await page.waitForTimeout(2_500);

  // Scene 4: Show the diff panel and the file list.
  const panel = page.locator('[data-testid="changes-panel"]');
  await expect(panel).toBeVisible();
  await page.waitForTimeout(3_000);

  // Scene 5: Click a changed file to open the diff view.
  const changedFile = panel.locator('[data-testid="changes-row-README.md"]');
  await changedFile.waitFor({ state: "visible", timeout: 10_000 });
  await changedFile.click();
  await page.waitForTimeout(5_000);

  // Scene 6: Close the panel.
  const close = panel.locator('[data-testid="changes-close"]');
  await close.click();
  await page.waitForTimeout(2_000);
});
