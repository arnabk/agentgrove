# AgentGrove — Agent Notes

## On session start: ALWAYS start the dev server

Every time this session is restarted, start the dev server (BE + FE, hot reload)
unless it is already running. Steps:

```bash
# 1. Use pinned toolchain (Homebrew cargo 1.83 CANNOT parse edition 2024)
export PATH="$HOME/.rustup/toolchains/1.95.0-aarch64-apple-darwin/bin:$PATH"
# NOTE: do NOT set AGENTGROVE_ENABLE_FAKE — dev uses REAL agents (Claude,
# opencode). Fake is a test-only provider, hidden from the FE dropdown.

# 2. Back up notes before any BE restart
mkdir -p /tmp/ag-notes-backup && cp .data/scratchpads/*.json /tmp/ag-notes-backup/ 2>/dev/null

# 3. Launch (background). scripts/dev.sh runs BE on :4317 + FE on :5173 w/ hot reload
nohup bash scripts/dev.sh > .data/logs/dev-wrapper.log 2>&1 &
```

Check first — skip launch if already up:

```bash
curl -fsS http://127.0.0.1:4317/health   # BE
curl -fsS -o /dev/null -w "%{http_code}" http://localhost:5173   # FE -> 200
```

Logs: `.data/logs/dev-backend.log`, `.data/logs/dev-frontend.log`.

## Toolchain gotcha

- BE builds need pinned toolchain:
  `export PATH="$HOME/.rustup/toolchains/1.95.0-aarch64-apple-darwin/bin:$PATH"`
  and use that cargo. Homebrew cargo 1.83 can't parse edition 2024.

## Commit / push flow

Stage source files only (NOT Cargo.lock):

```bash
git add <source files>
git commit -m "..."
git fetch origin main && git rebase origin/main
git checkout Cargo.lock   # discard local lock churn
git push origin main
```

Before commit: typecheck + eslint + prettier + test must be clean.

## README CI/CD badge rule

Before every commit, merge, or release (or after pushing, before PR), verify
that ALL three README badges (CI, Release, Nightly) show **`success`** /
**`passing`**. Run:

```bash
for w in ci.yml release.yml nightly.yml; do
  gh run list --workflow "$w" --limit 1 --json conclusion,status | grep -q '"success"' && echo "✅ $w" || echo "❌ $w"
done
```

If any badge is failing, investigate and fix before pushing. New security
advisories should be added to `.audit-context/audit.toml` (the CI ignore
list in `.github/workflows/ci.yml` must match).

## Release announcement rule (Reddit)

Every push to `main` makes `release.yml` cut a new version. After each
push that produces a release, post its notes as a comment on the project's
Reddit thread:

<https://www.reddit.com/r/coolgithubprojects/comments/1wwsrm2/agentgrove_opensource_local_workspace_for_running/>

1. Wait for the `release` run for your commit to succeed, then read the
   notes: `gh release view --json tagName,body`.
2. Open the thread in a **new tab** of the shared browser. If Reddit isn't
   logged in, stop and ask the user. Never enter credentials.
3. Skip if a comment for this tag already exists on the thread (no
   double posts).
4. Post one top-level comment: the version (`vX.Y.Z`), the notes body
   with commit hashes removed, and the release URL
   (`https://github.com/arnabk/agentgrove/releases/tag/vX.Y.Z`).
5. Confirm the comment shows on the thread, then close the tab.

If more than one release landed since the last announcement, post one
comment covering all of them, newest first.

Gotcha: Reddit's composer overlay intercepts clicks on **Comment**, so a
click can time out yet still post. After any failed or timed-out submit,
re-read the thread before retrying; never resubmit blind.
