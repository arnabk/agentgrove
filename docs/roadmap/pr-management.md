# PR management (review center)

> Status: approved for roadmap (2026-07). GitHub-integration track,
> alongside the [issues board](github-issues-board.md) and
> [PR lifecycle](native-pr-flow.md).

## Problem

PRs needing review are scattered across repos and GitHub's notification
inbox is noisy. There's no single local place answering: *what's open,
what's waiting on me, and how long has it been waiting?*

## Proposal

A **PR center** view aggregating pull requests across all AgentGrove
projects (every project maps to a repo):

- **Filters**: All · Needs my review · Assigned to @me · Authored by me.
  (`gh pr status` natively returns exactly these buckets; per-repo
  `gh pr list` / `gh search prs --review-requested=@me` for the rest.)
- **Columns**: PR #, repo, title, author, **age** (days open, colored:
  fresh / stale / ancient), review state (required / changes requested /
  approved), checks, mergeable.
- **Row actions**: open on GitHub, checkout locally, merge (reuse the
  existing rail merge path).

### Killer tie-in: review with agent

One click on a PR → `gh pr checkout` into a worktree + a chat seeded
with the PR diff and description, so the agent walks the change with
you (summarize, flag risks, answer questions). That turns "review
queue" into "review with a copilot" — squarely on-mission.

## Notes

- All data via `gh` (auth stays local); poll on focus, no webhooks.
- Age is computed from `createdAt`; staleness thresholds configurable
  later (defaults: <2d / <7d / older).
- Approve / request-changes actions are a v2 addition — v1 is read +
  checkout + merge.

## Effort

S-M for the list view (gh does the heavy lifting); +M for the
agent-review tie-in.

## Open questions

1. Global view across all projects (leaning: yes, with a repo filter)
   or per-project only?
2. Include draft PRs by default?
3. Show review-requested teams as well as @me?
