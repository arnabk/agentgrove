# Review loop: diff comments → agent

> Status: **approved for roadmap** (2026-07). Flagship track, pairs with
> the [GitHub Issues board](github-issues-board.md) — its *Review*
> column is where this loop lives.

## Problem

Reviewing agent diffs is where developers spend most of their time, and
the highest-friction step in the current flow is translating "what's
wrong on this line" into a fresh chat prompt: you have to remember the
file, the line, and phrase the complaint unambiguously, or the agent
fixes the wrong thing.

## Proposal

GitHub-PR-style inline comments in the Changes (diff) panel. Click a
diff line, write a comment in place, and the comment goes back to the
agent as a follow-up prompt — automatically wrapped with file path,
line number, and the code it anchors to. The agent fixes, produces a
new diff, you review again: **diff → comment → fix → new diff**.

## UX

1. Hover a diff line → a `+` gutter button appears (GitHub-style).
2. Click → a small comment box renders inline under the line
   (textarea + "Add to review" / "Send now").
3. Pending comments render as compact chips on their lines; editable
   and deletable until sent.
4. Changes-panel header gets **Send review to agent (N)** where N is the
   pending-comment count. Disabled when the scope has no chat; offers
   "start chat" instead.
5. The chat receives the review as a single queued prompt (lands via
   the existing pending-chat-injection path, so the user bubble appears
   instantly).

## Prompt format (batched review round)

```text
Review comments on the current diff — address each one:

1. `migrations/0042.sql:18` — line: `- DROP COLUMN last_login_at;`
   > don't drop this column, still needed

2. `src/auth.ts:104` — line: `+ const token = req.headers["x-token"]`
   > validate this before use; it can be undefined

Do not commit; update the working tree and summarize what changed.
```

## Design decisions (leanings)

- **Batch by default.** One "review round" = one prompt; cheaper on
  agent turns and matches the PR-review mental model. Each comment also
  has a "Send now" for one-off urgency.
- **Persist comments.** New `review_comments` table so a "3 unresolved"
  badge survives reloads and gives an audit trail. Status per comment:
  `pending | sent | addressed | outdated`.
- **Anchor by content, not just line number.** Store the anchored
  line's content; on re-render, re-locate by content search. If the
  agent's new edit moved/removed it, mark the comment `outdated` (same
  rule GitHub uses).
- **Plain comments first.** GitHub-style suggestion blocks (exact
  replacement code) are a v2 addition — mechanically they're a
  specialized prompt ("replace X with Y"), no schema change needed.

## Data model

```sql
review_comments(
  id            TEXT PRIMARY KEY,
  chat_id       TEXT NOT NULL,          -- owning chat (scope-derived)
  path          TEXT NOT NULL,          -- repo-relative file path
  side          TEXT NOT NULL,          -- 'old' | 'new'
  line_no       INTEGER NOT NULL,       -- line in the viewed diff
  line_content  TEXT NOT NULL,          -- for re-anchoring
  body          TEXT NOT NULL,
  status        TEXT NOT NULL,          -- pending|sent|addressed|outdated
  batch_id      TEXT,                   -- review-round grouping
  created_at    TEXT NOT NULL
)
```

## Mechanics

- The Changes panel already knows its scope (project/worktree); the
  linked chat is the active chat of that scope (or offer to create one).
- Sending reuses `setPendingChatInjection` (the drift-badge path) so
  ChatPane's optimistic insert fires and the bubble lands immediately,
  queueing normally if the agent is busy.
- Backend: CRUD endpoints under `/api/chats/:id/review-comments` +
  `POST .../send` that formats the batched prompt and enqueues it.

## Effort

M (~1 week): table + endpoints, inline-comment UI in ChangesPanel,
injection + prompt formatting, e2e test with the fake provider.

## Open questions

1. Batch vs immediate — leaning batch with per-comment "Send now".
2. Persisted vs ephemeral — leaning persisted (small table, big payoff).
3. Suggestion blocks in v2?
