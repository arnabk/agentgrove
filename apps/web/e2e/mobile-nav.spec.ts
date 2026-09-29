import { expect, test } from "@playwright/test";
import { bootMobile } from "./mobile-helpers";

test.describe("mobile navigation", () => {
  test("the shell shows a header, a view and a bottom tab bar", async ({ page }) => {
    await bootMobile(page);
    await expect(page.getByTestId("mobile-header")).toBeVisible();
    await expect(page.getByTestId("mobile-main")).toBeVisible();
    await expect(page.getByTestId("mobile-tab-bar")).toBeVisible();
  });

  test("the hamburger opens the drawer and the backdrop closes it", async ({ page }) => {
    await bootMobile(page);
    await page.getByTestId("mobile-menu").click();
    await expect(page.getByTestId("mobile-drawer")).toBeVisible();
    await expect(page.getByTestId("mobile-project-list")).toBeVisible();

    // Tap the sliver of backdrop the drawer leaves exposed, which is
    // the gesture a user actually makes. The backdrop spans the whole
    // viewport, so its centre is underneath the drawer.
    const drawer = (await page.getByTestId("mobile-drawer").boundingBox())!;
    const viewport = page.viewportSize()!;
    const exposed = viewport.width - (drawer.x + drawer.width);
    expect(exposed, "the drawer should leave backdrop exposed to tap").toBeGreaterThan(20);
    await page.mouse.click(drawer.x + drawer.width + exposed / 2, viewport.height / 2);

    await expect(page.getByTestId("mobile-drawer")).toHaveCount(0);
  });

  test("the close button also dismisses the drawer", async ({ page }) => {
    await bootMobile(page);
    await page.getByTestId("mobile-menu").click();
    await page.getByTestId("mobile-drawer-close").click();
    await expect(page.getByTestId("mobile-drawer")).toHaveCount(0);
  });

  test("picking a project sets the scope, closes the drawer and updates the URL", async ({
    page,
  }) => {
    const projectId = await bootMobile(page);
    await page.getByTestId("mobile-menu").click();
    await page.getByTestId(`mobile-project-${projectId}`).click();

    await expect(page.getByTestId("mobile-drawer")).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/p/${projectId}`));
  });

  test("the drawer auto-expands the project the user is scoped to", async ({ page }) => {
    const projectId = await bootMobile(page);
    await page.getByTestId("mobile-menu").click();
    await expect(page.getByTestId(`mobile-worktrees-${projectId}`)).toBeVisible();
  });

  test("worktrees collapse and expand", async ({ page }) => {
    const projectId = await bootMobile(page);
    await page.getByTestId("mobile-menu").click();
    const toggle = page.getByTestId(`mobile-toggle-${projectId}`);

    await toggle.click();
    await expect(page.getByTestId(`mobile-worktrees-${projectId}`)).toHaveCount(0);
    await toggle.click();
    await expect(page.getByTestId(`mobile-worktrees-${projectId}`)).toBeVisible();
  });

  test("worktrees are read-write: the create affordance is present", async ({ page }) => {
    const projectId = await bootMobile(page);
    await page.getByTestId("mobile-menu").click();
    await expect(page.getByTestId(`mobile-new-worktree-${projectId}`)).toBeVisible();
  });

  test("every header and tab target clears the 44px touch minimum", async ({ page }) => {
    await bootMobile(page);
    for (const id of ["mobile-menu", "mobile-tab-chats", "mobile-tab-settings"]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box, `${id} should be laid out`).not.toBeNull();
      expect(box!.height, `${id} height`).toBeGreaterThanOrEqual(44);
    }
  });
});
