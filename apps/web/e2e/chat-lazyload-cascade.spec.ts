import { test, expect, Page } from "@playwright/test";
import { BASE, BE_URL } from "./helpers";

// Regression for the large-chat lazy-load cascade: on a chat with many
// tall rows spanning several pages, a burst of scroll-up gestures must
// NOT cascade through every page until the start of the chat. The risk
// is that after a backfill lands and the anchor is restored, scrollTop
// stays < the trigger threshold and scroll-settling events re-fire the
// load in a tight loop. The `programmaticUntil` guard (introduced with
// the scroll-jump fix) bails onScroll during the restore window, so at
// most one backfill fires per real gesture. This uses a 220-prompt
// (5-page) seed chat so a cascade would be unmistakable.
const CHAT_ID = "019f92c5-394d-77d3-99a5-31d180452b1d";
const PROJECT_ID = "019e86c8-641b-7d92-9e74-4c54b8a30396";
const PAGE_SIZE = 50;

async function trackBackfills(page: Page): Promise<() => number[]> {
  const stamps: number[] = [];
  await page.route(`${BE_URL}/api/chats/${CHAT_ID}/prompts**`, async (route) => {
    stamps.push(Date.now());
    await route.continue();
  });
  return () => stamps;
}

async function timelineCenter(page: Page) {
  return page.evaluate(() => {
    const els = Array.from(
      document.querySelectorAll('[data-testid="chat-timeline"]'),
    ) as HTMLElement[];
    const el = els.find((e) => e.clientHeight > 0) ?? els[0] ?? null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

test("scroll-up burst does not cascade through every page", async ({ page }) => {
  const getStamps = await trackBackfills(page);

  await page.goto(`${BASE.replace(/\/$/, "")}/p/${PROJECT_ID}?chat=${CHAT_ID}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByTestId("app-root")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-testid="chat-timeline"]').first()).toBeVisible({
    timeout: 15_000,
  });
  // Let the initial window settle.
  await page.waitForTimeout(800);

  // A rapid burst of scroll-up flicks — the pattern that used to fire a
  // cascade off scroll-settling events after each anchor restore.
  const center = await timelineCenter(page);
  expect(center).not.toBeNull();
  await page.mouse.move(center!.x, center!.y);
  for (let i = 0; i < 60; i++) {
    await page.mouse.wheel(0, -1200);
    await page.waitForTimeout(30);
  }
  // Let any runaway backfill drain.
  await page.waitForTimeout(3000);

  const stamps = getStamps();

  // The cascade signature is many backfills fired within a few
  // milliseconds of each other (scroll-settling re-triggers), rapidly
  // walking the chat back to its start. A healthy timeline fires at most
  // a small number of gesture-driven loads, never the full 5 pages, and
  // never two within the ~250ms programmatic-guard window.
  const tightPairs = stamps
    .slice(1)
    .map((t, i) => t - stamps[i]!)
    .filter((gap) => gap < 250).length;
  expect(tightPairs, `saw ${tightPairs} backfills within the programmatic guard window`).toEqual(0);

  // The 220-prompt chat has 5 pages. A cascade would load them all
  // (~220 rows); the windowed timeline should stay far below that after
  // one burst of gestures near the top.
  const loaded = await page.evaluate(
    () => document.querySelectorAll('[data-testid^="prompt-"]').length,
  );
  expect(loaded, `loaded ${loaded} rows — a cascade would load the whole chat`).toBeLessThan(
    3 * PAGE_SIZE,
  );
});
