import { test, expect } from "@playwright/test";
import { BASE, BE_URL } from "./helpers";

// Verification-only spec for the worktree-suggest duplicate fix.
// Confirms the ✦ Suggest button never offers a name that already
// exists as a git branch (live, history, or plain git branch) for a
// project with a large branch set (the backend repo has ~470 branches,
// several of which collide with the celestial name pool).
const PROJECT_ID = "019e8b9e-35ed-7561-b619-4a45408e8792";

test("suggest never offers a name that collides with an existing git branch", async ({ page }) => {
  // Ground truth: every branch git knows about for this project.
  const res = await fetch(`${BE_URL}/api/projects/${PROJECT_ID}/branches`);
  expect(res.ok).toBeTruthy();
  const branches = (await res.json()) as { name: string }[];
  const taken = new Set(branches.map((b) => b.name));
  expect(taken.size).toBeGreaterThan(100);

  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  // Open the project's action menu, then New worktree.
  const menuBtn = page.locator(`[data-testid="project-menu-${PROJECT_ID}"]`);
  await expect(menuBtn).toBeVisible({ timeout: 15_000 });
  await menuBtn.click();
  const newWt = page.locator(`[data-testid="new-worktree-${PROJECT_ID}"]`);
  await expect(newWt).toBeVisible();
  await newWt.click();

  const dialog = page.locator('[data-testid="worktree-dialog"]');
  await expect(dialog).toBeVisible();
  const input = page.locator('[data-testid="worktree-branch"]');
  const suggest = page.locator('[data-testid="worktree-suggest"]');

  // Give the async git-branch fetch time to land in the taken set.
  await page.waitForTimeout(500);

  const seen: string[] = [];
  for (let i = 0; i < 20; i++) {
    await suggest.click();
    const val = (await input.inputValue()).trim();
    expect(val, `suggestion ${i} should be non-empty`).not.toEqual("");
    expect(taken.has(val), `suggestion "${val}" collides with an existing git branch`).toBeFalsy();
    seen.push(val);
  }

  // Sanity: we actually exercised the suggester with some variety.
  expect(new Set(seen).size).toBeGreaterThan(3);
});
