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

> Only items that have been discussed and approved live here.
> Everything else sits in the [parking lot](#parking-lot-not-approved).

### Flagship track — the plan → execute → review loop

1. [GitHub Issues board](github-issues-board.md) — kanban UI over GitHub
   issues using labels as columns, with one-click "start work" → worktree
   + agent chat. **Current leading candidate.**
2. [Review loop: diff comments → agent](review-loop-diff-comments.md) —
   inline comments on the diff viewer become follow-up prompts.
3. [PR lifecycle](native-pr-flow.md) — create PR with AI title/body,
   checks, merge. Absorbs the `Closes #N` linking the board relies on.
4. [PR management (review center)](pr-management.md) — all PRs across
   projects: needs-my-review / assigned-to-me / authored, with age and
   review state, plus one-click "review with agent" checkout.

### Delight track

5. [Agent runs inbox & visual job manager](agent-runs-inbox.md) —
   watch CLI session dirs for runs (incl. cron-launched) and manage
   existing crontab jobs visually. **Native scheduling rejected** —
   that would compete with our own providers.

### Polish track

6. [Composer @-file mentions](composer-file-mentions.md) — file
   autocomplete in the chat composer.

## Parking lot (not approved)

Raw candidates from early brainstorming — **not on the roadmap** until
discussed and approved individually:

- Dev-server preview — per-worktree port detection + embedded browser pane.
- Attention system — OS notifications + unread badges on finished turns.
- Commit & push flow — one-click commit+push per worktree.
- Terminal splits & presets.
- Generic "any CLI" provider — user-defined launch templates.
- MCP server mode — expose AgentGrove as MCP tools.
- Remote headless mode — BE on a server, access from anywhere.
- Sandboxed unattended runs — containers per workspace.

## Tentative sequencing (not final)

1. Polish first (6) — fast, keeps release momentum.
2. Flagship: issues board (1) + review loop (2) + PR lifecycle (3).
3. PR management (4) + runs inbox (5).
