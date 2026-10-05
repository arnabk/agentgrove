#!/usr/bin/env node
// Daily AgentGrove Reddit value-drop: posts the next unposted draft from
// docs/marketing/reddit-drafts/day-NN.md as a top-level comment on the
// project thread, via the shared browser (CDP :9222). Runs directly from
// the scheduler (no LLM). One post per calendar day, never a duplicate.
//
//   node scripts/reddit-daily.mjs            post next day
//   node scripts/reddit-daily.mjs --dry-run  print what it would do
//
// Flow: lock → new tab → thread → skip if already posted today / draft
// already on thread → composer → Markdown mode → fill → Comment → reload →
// verify rendered → close tab. A post that shows up malformed is deleted.

import { chromium } from "playwright-core";
import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const CDP_URL = process.env.REDDIT_CDP_URL ?? "http://localhost:9222";
const THREAD_URL =
  "https://www.reddit.com/r/coolgithubprojects/comments/1wwsrm2/agentgrove_opensource_local_workspace_for_running/";
const STATE_FILE = "docs/marketing/reddit-state.md";
const DRAFTS_DIR = "docs/marketing/reddit-drafts";
const LOCK_DIR = ".data/reddit-daily.lock";
const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force"); // ignore once-per-day guard

const log = (...a) =>
  console.log(`[reddit-daily ${new Date().toISOString()}]`, ...a);
const pad = (n) => String(n).padStart(2, "0");
const today = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD local
const norm = (s) =>
  s
    .replace(/[*_`>#|\[\]()\\-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

async function readState() {
  const s = { lastPostedDay: 0, lastPostDate: "" };
  if (!existsSync(STATE_FILE)) return s;
  const t = await readFile(STATE_FILE, "utf-8");
  s.lastPostedDay = Number(t.match(/last_posted_day:\s*(\d+)/)?.[1] ?? 0);
  s.lastPostDate = t.match(/last_post_date:\s*(\S+)/)?.[1] ?? "";
  s.lastCommentId = t.match(/last_comment_id:\s*(\S+)/)?.[1] ?? "";
  return s;
}

async function writeState(s, status) {
  await writeFile(
    STATE_FILE,
    [
      "# AgentGrove Reddit thread — job state",
      "",
      "Written by scripts/reddit-daily.mjs. Edit only to skip/redo a day.",
      "",
      `last_posted_day: ${s.lastPostedDay}`,
      `last_post_date: ${s.lastPostDate || "-"}`,
      `last_comment_id: ${s.lastCommentId || "-"}`,
      `last_run: ${new Date().toISOString()}`,
      `last_status: ${status}`,
      "",
    ].join("\n"),
  );
}

// First non-empty body line: the fingerprint we look for on the thread.
function fingerprint(body) {
  return norm(body.split("\n").find((l) => l.trim()) ?? "").slice(0, 70);
}

async function threadComments(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("shreddit-comment[depth='0']")].map((c) => ({
      id: c.getAttribute("thingid"),
      author: c.getAttribute("author"),
      text: c.querySelector("[slot='comment']")?.innerText ?? "",
      html: c.querySelector("[slot='comment']")?.innerHTML ?? "",
    })),
  );
}

// Delete one of our comments using the logged-in session (old.reddit modhash).
async function deleteComment(context, thingId) {
  const p = await context.newPage();
  try {
    await p.goto("https://old.reddit.com/api/me.json", { waitUntil: "load" });
    return await p.evaluate(async (id) => {
      const me = JSON.parse(document.body.innerText);
      const r = await fetch("/api/del", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-modhash": me.data.modhash,
        },
        body: `id=${id}&uh=${me.data.modhash}`,
        credentials: "include",
      });
      return r.status;
    }, thingId);
  } finally {
    await p.close();
  }
}

async function acquireLock() {
  await mkdir(".data", { recursive: true });
  try {
    await mkdir(LOCK_DIR);
    return true;
  } catch {
    // stale lock (> 15 min) from a killed run
    const age = Date.now() - (await stat(LOCK_DIR)).mtimeMs;
    if (age > 15 * 60_000) {
      await rm(LOCK_DIR, { recursive: true, force: true });
      await mkdir(LOCK_DIR);
      return true;
    }
    return false;
  }
}

async function run() {
  const state = await readState();
  if (!FORCE && state.lastPostDate === today()) {
    log(`already posted today (day ${state.lastPostedDay}); skip`);
    await writeState(state, "skipped: already posted today");
    return 0;
  }
  const day = state.lastPostedDay + 1;
  const file = path.join(DRAFTS_DIR, `day-${pad(day)}.md`);
  if (!existsSync(file)) {
    log(`no draft for day ${day} (${file}); nothing to post`);
    await writeState(state, `blocked: missing ${file}`);
    return 0;
  }
  const body = (await readFile(file, "utf-8")).replace(/^#.*\n+/, "").trim();
  const fp = fingerprint(body);
  log(`day ${day}: ${body.length} chars, fingerprint "${fp.slice(0, 40)}…"`);
  if (DRY_RUN) {
    log("dry-run: would post as top-level Markdown comment, then verify");
    return 0;
  }

  const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 15_000 });
  const context = browser.contexts()[0];
  const page = await context.newPage();
  try {
    await page.goto(THREAD_URL, { waitUntil: "load", timeout: 45_000 });
    const host = page.locator("comment-composer-host").first();
    await host.waitFor({ state: "visible", timeout: 20_000 });

    // Dedupe: draft already on the thread (posted manually, or a run that
    // submitted but died before saving state).
    const existing = (await threadComments(page)).find((c) =>
      norm(c.text).includes(fp),
    );
    if (existing) {
      log(`day ${day} already on thread (${existing.id}); syncing state`);
      Object.assign(state, {
        lastPostedDay: day,
        lastPostDate: today(),
        lastCommentId: existing.id,
      });
      await writeState(state, `synced: day ${day} found on thread`);
      return 0;
    }

    // Composer: only the thread-level "Join the conversation" box.
    await host
      .locator('faceplate-textarea-input[data-testid="trigger-button"]')
      .click();
    await host
      .locator('div[slot="rte"][contenteditable="true"]')
      .waitFor({ state: "visible", timeout: 15_000 });
    const mdBtn = host.getByRole("button", { name: "Switch to Markdown" });
    if (!(await mdBtn.isVisible()))
      await host
        .getByRole("button", { name: "Show formatting options" })
        .click();
    await mdBtn.click();
    const ta = host.locator("textarea:visible").first();
    await ta.waitFor({ state: "visible", timeout: 10_000 });
    await ta.fill(body);
    if ((await ta.inputValue()) !== body)
      throw new Error("composer did not accept the full draft");

    const before = new Set((await threadComments(page)).map((c) => c.id));
    await host
      .locator('button[slot="submit-button"]')
      .click({ timeout: 10_000 })
      .catch((e) => log("submit click:", e.message));

    // Verify (never resubmit blind — AGENTS.md gotcha): reload until it shows.
    let posted;
    for (let i = 0; i < 6 && !posted; i++) {
      await page.waitForTimeout(5_000);
      await page.reload({ waitUntil: "load" });
      await page
        .locator("comment-composer-host")
        .first()
        .waitFor({ timeout: 20_000 })
        .catch(() => {});
      posted = (await threadComments(page)).find(
        (c) => !before.has(c.id) && norm(c.text).includes(fp),
      );
    }
    if (!posted) {
      await writeState(
        state,
        `error: submitted but day ${day} not visible on thread; NOT retrying`,
      );
      log("not visible after submit; stopping without retry");
      return 1;
    }

    // Formatting check: raw markdown must not leak into the rendered comment.
    const leaked =
      /\*\*|\|---|^\s*\|.*\|\s*$/m.test(posted.text) ||
      posted.text.includes("`");
    if (leaked) {
      const st = await deleteComment(context, posted.id);
      await writeState(
        state,
        `error: day ${day} rendered badly; deleted ${posted.id} (HTTP ${st})`,
      );
      log(`malformed render; deleted ${posted.id} (HTTP ${st})`);
      return 1;
    }

    Object.assign(state, {
      lastPostedDay: day,
      lastPostDate: today(),
      lastCommentId: posted.id,
    });
    await writeState(state, `posted day ${day} as ${posted.id}`);
    log(`posted + verified day ${day}: ${posted.id}`);
    return 0;
  } finally {
    await page.close().catch(() => {});
  }
}

if (!(await acquireLock())) {
  log("another run holds the lock; exit");
  process.exit(0);
}
let code = 1;
try {
  code = await run();
} catch (e) {
  log("error:", e.message);
  await writeState(await readState(), `error: ${e.message}`).catch(() => {});
} finally {
  await rm(LOCK_DIR, { recursive: true, force: true });
}
process.exit(code); // CDP connection would otherwise keep node alive
