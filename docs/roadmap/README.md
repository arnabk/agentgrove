# AgentGrove Roadmap (working draft)

> Status: **in discussion — nothing here is final.** Each idea has its own
> doc; this page is the index and records the decisions made along the way.

## Context

Post-launch landscape (mid-2026):

- **vibe-kanban is sunsetting** and **Crystal is deprecated** — the two
  biggest OSS "AI agent workspace" projects just vacated the space.
- What users actually want is the **plan → execute → review loop**,
  not another agent chat UI.
- Our philosophy: **integrate, don't silo.** AgentGrove connects to the
  tools developers already use (GitHub, their CLIs, their database)
  instead of building private copies of them.

## Decision log

| Date | Decision | Outcome |
| --- | --- | --- |
| 2026-07 | Local kanban board (own task store) | **Rejected** — creates a private silo the team can't see; superseded by [GitHub Issues board](github-issues-board.md). |
| 2026-07 | GitHub Projects V2 integration | **Dropped** — use labels as kanban columns instead; simpler, no GraphQL, works for every repo. |
| 2026-07 | Branch naming for issue work | `<issue-number>-<slug>` (GitHub's own convention, e.g. `123-fix-login`). Celestial names stay for non-issue worktrees. |
| 2026-07 | Task state machine | **None local.** State lives on GitHub (labels + issue open/closed). GitHub Projects automations handle Done. |
| 2026-07 | Native cron scheduler for agent runs | **Rejected** — competes with our own providers (Claude/Kimi/opencode all racing there) and with plain `crontab + CLI`. Reframed as [runs inbox + visual job manager](agent-runs-inbox.md) (visibility, not ownership). |

## The ideas

### Flagship track — the plan → execute → review loop

1. [GitHub Issues board](github-issues-board.md) — kanban UI over GitHub
   issues using labels as columns, with one-click "start work" → worktree
   + agent chat. **Current leading candidate.**
2. [Review loop: diff comments → agent](review-loop-diff-comments.md) —
   inline comments on the diff viewer become follow-up prompts.
3. [Native PR flow](native-pr-flow.md) — create PR with AI title/body,
   checks, merge. Absorbs the `Closes #N` linking the board relies on.

### Delight track

4. [Dev-server preview](dev-server-preview.md) — per-worktree port
   detection + embedded browser pane.
5. [Agent runs inbox & visual job manager](agent-runs-inbox.md) —
   watch CLI session dirs for runs (incl. cron-launched) and manage
   existing crontab jobs visually. **Native scheduling rejected** —
   that would compete with our own providers.
6. [Attention system](attention-system.md) — OS notifications + unread
   badges when a turn finishes/errors.

### Polish track

7. [Composer @-file mentions](composer-file-mentions.md) — file
   autocomplete in the chat composer.
8. [Commit & push flow](commit-push-flow.md) — one-click commit+push
   per worktree with suggested message.
9. [Terminal splits & presets](terminal-splits.md).

### Platform track (later)

10. [Generic "any CLI" provider](generic-cli-provider.md).
11. [MCP server mode](mcp-server-mode.md).
12. [Remote headless mode](remote-headless.md).
13. [Sandboxed unattended runs](sandboxed-runs.md) — deferred; heavy
    infra, solo-dev case already works.

## Tentative sequencing (not final)

1. Polish trio first (7, 8, 6) — fast, keeps release momentum.
2. Flagship: issues board (1) + review loop (2) + PR flow (3).
3. Delight: preview (4), automations (5).
4. Platform items as the community asks for them.
