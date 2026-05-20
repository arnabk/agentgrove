# Backend modules

All Rust. Tokio runtime. Each crate has unit tests in `src/` and component
tests in `tests/`.

## Crates

### agentgrove-core
Domain types and error enum. No I/O. Pure.

### agentgrove-store
`sqlx` + SQLite. Migrations under `migrations/`. Blob store on filesystem at
`<state_dir>/blobs/<aa>/<sha256>`. Repositories per aggregate.

### agentgrove-git
`gix` wrappers. Worktree add/remove, status, diff, blob lookup. Pre/post
script execution with timeout and abort-on-nonzero.

### agentgrove-pty
`portable-pty`. Session manager with bounded scrollback. Resize, kill, IO
mux. Works on ConPTY (Windows), `openpty` (Unix).

### agentgrove-fswatch
`notify-rs`. Debounced watcher per active worktree. Captures touched paths
during a running prompt for snapshot.

### agentgrove-agents
`AgentProvider` trait. Providers wrap external CLIs or call OpenAI-compatible
HTTP endpoints. Streams `AgentEvent`s to API layer.

### agentgrove-api
`axum` routes, WS hub, OpenAPI via `utoipa`. The server binds to
`127.0.0.1` by default; there is no built-in authentication.

### agentgrove-server
Binary. CLI flags, config, tracing, startup. Embeds static frontend assets
at release time.

## State directory

Default: `<repo>/.data` (the working directory the server is launched from,
joined with `.data`). This keeps all project state co-located with the
checkout and identical on every OS.

`.data/` is gitignored.

Override with the `AGENTGROVE_STATE_DIR` env var (later: `--state-dir`
CLI flag).

Layout inside the state dir:

```
.data/
  agentgrove.sqlite        # metadata DB (M1)
  blobs/<aa>/<sha256>      # content-addressed blob store
  logs/                    # rolling logs (optional)
```
