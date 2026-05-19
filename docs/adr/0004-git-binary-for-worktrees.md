# ADR-0004: Use the `git` binary for worktree mutations

- Status: Accepted
- Date: 2026-05-19

## Context

`gix` is a pure-Rust git implementation we use for read-only operations
(inspection, blob lookup, status). At the time of M1, `gix` does not
expose a stable API for `worktree add` / `worktree remove`, the core
mutations AgentGrove relies on.

## Decision

For worktree mutations (`add`, `remove`, `list`) we shell out to the
`git` binary via `which::which("git")`. Read-only operations (status,
diff, blob fetch) continue to use `gix`.

We require **git >= 2.30** at runtime. If `git` is not on `PATH`, the API
surfaces a clear error to the user.

## Consequences

- Cross-platform via `git`'s own bundled binary on each OS.
- Slightly higher latency than pure-Rust calls (~10–30ms per call).
- Easier to debug: the same commands a user could run by hand.
- When `gix` ships worktree mutations, we migrate transparently.

## Migration plan

The `WorktreeManager` trait abstracts both implementations. We will swap
the default backend once `gix-worktree-mutations` lands.
