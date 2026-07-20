# Dev-server preview

> Status: candidate — not yet discussed in detail. Delight track.

## Idea

Detect dev-server ports per worktree and offer an embedded browser
pane to preview the running app (vibe-kanban and Superset both ship
this; it was their best demo feature).

## Notes

- Port detection is the hard part (poll listening sockets in the
  worktree's processes); the pane itself is an iframe tab kind.
- X-Frame-Options will block some apps — likely need a backend proxy
  fallback for those.
- Best demo-ability-per-effort on the list.

## Open questions

- iframe-first with proxy fallback, or proxy from day one?
- One preview per worktree (auto-detected port) vs user-picked port?

## Effort

M.
