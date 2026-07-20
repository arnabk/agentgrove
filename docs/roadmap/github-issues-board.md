# GitHub Issues board

> Status: **approved direction** (2026-07). Flagship track, item #1.
> Supersedes the rejected "local kanban" idea (see
> [decision log](README.md#decision-log)). Pairs with
> [review loop](review-loop-diff-comments.md) and
> [PR lifecycle](native-pr-flow.md).

## Why

Developers plan in GitHub issues and review agent output in AgentGrove.
Today those are two disconnected worlds: you read an issue on
github.com, then manually recreate the context in a chat. Meanwhile a
locally-built kanban (vibe-kanban's model) creates a private task silo
the team can't see.

**Principle: integrate, don't silo.** GitHub stays the task store and
the source of truth; AgentGrove provides a fast, elegant UI over it
plus one-click execution.

## The model: labels are the columns

No GitHub Projects, no GraphQL, no local state machine. Columns are
derived from plain issue labels:

| Column | Rule |
| --- | --- |
| **Todo** | open issue, no status label |
| **In Progress** | label `in-progress` |
| **In Review** | label `in-review` |
| **Done** | closed issue (collapsed by default, last ~20) |

Moving a card = `gh issue edit <n> --add-label X --remove-label Y`.
Anyone changing labels on github.com sees the same truth.

### Auto-labeling on the agent lifecycle

- **Start work** → add `in-progress` + self-assign.
- **PR opened** (body contains `Closes #N`) → add `in-review`.
- **PR merged** → GitHub auto-closes the issue → card lands in Done by
  itself. Zero bookkeeping on our side.

### Branch naming

`<issue-number>-<slug>` — e.g. `123-fix-login-redirect`. This is
GitHub's own convention (their "create branch from issue" panel), so it
reads naturally to every developer and makes the issue↔branch link
obvious. Celestial names stay for non-issue worktrees.

## UI

1. **Board view** (new tab kind, per project): four columns; cards show
   issue number, title, label chips, assignee avatar, and a PR badge
   when a linked PR exists. Top bar: search, assignee/milestone filter,
   and an inline **New issue** box (title + body, two fields).
2. **Card click → issue detail drawer** (right side): rendered markdown
   body, comments thread, state/labels/assignees, and an actions row:
   **Start work**, open linked chat, open/merge linked PR.
3. **Start work**: one click → branch `123-slug` + worktree + chat
   seeded with the issue title and body + `in-progress` label +
   self-assign. Issue comment ("agent started") is **off by default**.
4. **Refresh**: on board focus + instant local update after our own
   mutations. No webhook/realtime at this scale.

## Backend

- `gh`-backed issues client (auth stays local, same philosophy as the
  agent providers): list, get, create, edit labels, comment.
  Endpoints under `/api/projects/:id/issues[...]`.
- Detect `gh` like agent CLIs; show install hint when missing.
- Link record: chat/worktree ↔ issue number (small table or fields on
  the chat record) so the chat header can show the issue badge and the
  PR flow can inject `Closes #N`.

## Effort

M-L: issues client + endpoints, board tab UI, detail drawer,
start-work flow, label mutations, e2e with a stubbed `gh`.

## Open questions

1. Ship fixed `in-progress` / `in-review` labels first; per-repo
   label→column mapping later? (leaning: yes)
2. Done column: collapsed "last 20 closed" vs hidden until expanded?
3. "Start work" always self-assigns + labels `in-progress` — confirm.
