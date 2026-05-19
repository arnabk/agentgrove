# Architecture Overview

AgentGrove is a local-first server with a browser UI. A single Rust binary
serves both an HTTP API and a static SolidJS frontend. Default bind is
`127.0.0.1` with a bearer token; an opt-in remote mode allows binding to
other interfaces.

## High-level diagram

```
+-----------------------------------------------------------+
|                     Browser (SolidJS)                     |
|  Shell  Editor(CM6)  Diff(CM6 merge)  Term(xterm)  Chat   |
|  Theme  Queue  Notes  Timeline  Project picker            |
+----------------------^------------------^-----------------+
                       | WS (streams)     | HTTP (CRUD)
+----------------------v------------------v-----------------+
|                Rust BE (axum + tokio)                     |
|  api::http   api::ws   auth(token)                        |
|  services: projects, worktrees, chats, snapshots,         |
|            queue, notes, themes, scripts, agents          |
|  agent::{trait AgentProvider}                             |
|    -> claude_code, codex, kimi, openai_compat             |
|    spawn via portable-pty, parse stream, tool events      |
|  fs::watcher (notify-rs)   git (gix)   pty (portable-pty) |
|  store: sqlx(SQLite) + blobs/<sha256>                     |
+-----------------------------------------------------------+
```

## Crate layout

```
agentgrove/
  Cargo.toml                # workspace
  crates/
    agentgrove-core/        # domain types, errors
    agentgrove-store/       # sqlx migrations, repos, blob store
    agentgrove-git/         # gix wrappers
    agentgrove-pty/         # portable-pty session mgr
    agentgrove-fswatch/     # notify-rs debounced watcher
    agentgrove-agents/      # AgentProvider trait + providers
    agentgrove-api/         # axum routes, ws hub, auth, openapi
    agentgrove-server/      # binary: config, tracing, startup
  apps/
    web/                    # SolidJS + Vite + Tailwind + Kobalte
  scripts/                  # cross-platform dev scripts (.sh + .ps1)
  .github/workflows/        # CI
  docs/                     # all documentation
```

See [backend.md](./backend.md), [frontend.md](./frontend.md),
[cross-platform.md](./cross-platform.md).
