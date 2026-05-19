import { test } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";

test("capture screenshot + diagnostics", async ({ page }) => {
  const log: string[] = [];
  page.on("console", (m) => log.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => log.push(`[pageerror] ${e.message}`));
  page.on("requestfailed", (r) =>
    log.push(`[reqfail] ${r.url()} :: ${r.failure()?.errorText}`),
  );

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.screenshot({ path: ".data/logs/page.png", fullPage: true });

  const html = await page.content();
  const root = await page.locator("#root").innerHTML().catch(() => "<missing>");
  console.log("--- BODY OUTER (first 500 chars) ---");
  console.log(html.slice(0, 500));
  console.log("--- #root innerHTML ---");
  console.log(root);
  console.log("--- BROWSER LOG ---");
  for (const l of log) console.log(l);
});
