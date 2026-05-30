//! Axum router.

use crate::{
    backups, branches, chats, diag, editor, files, fs as fsapi, git as gitapi, health::health,
    layout, notes, projects, providers, queue, scratchpad, settings, state::AppState, terminal,
    themes, uploads, worktrees, ws,
};
use axum::{
    http::Method,
    routing::{delete, get, post, put},
    Router,
};
use tower_http::cors::{Any, CorsLayer};

/// Build the full router. Used by both the binary and L4 endpoint tests.
pub fn build_router(state: AppState) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        .route("/ws", get(ws::handler))
        // Projects
        .route("/api/projects", get(projects::list).post(projects::create))
        .route(
            "/api/projects/:id",
            get(projects::get_one)
                .patch(projects::update)
                .delete(projects::delete),
        )
        // Project branches (list + switch)
        .route("/api/projects/:id/branches", get(branches::list_branches))
        .route("/api/projects/:id/branch", post(branches::switch_handler))
        // Cmd+P fuzzy file finder. The index is lazy: the first
        // search call scans the project root with `ignore`
        // (parallel, gitignore-aware), subsequent calls reuse the
        // cached entries. /reindex forces a re-scan.
        .route("/api/projects/:id/files/search", get(files::search))
        .route("/api/projects/:id/files/reindex", post(files::reindex))
        // Worktrees
        .route(
            "/api/projects/:id/worktrees",
            get(worktrees::list_for_project).post(worktrees::create),
        )
        .route(
            "/api/projects/:project_id/worktrees/:worktree_id",
            delete(worktrees::delete).patch(worktrees::update),
        )
        // Worktree history (soft-deleted) + restore
        .route("/api/worktrees/history", get(worktrees::history))
        .route("/api/worktrees/:id/restore", post(worktrees::restore))
        // Chats
        .route(
            "/api/worktrees/:id/chats",
            get(chats::list).post(chats::create),
        )
        .route(
            "/api/projects/:id/chats",
            get(chats::list_for_project_handler).post(chats::create_for_project_handler),
        )
        .route("/api/chats/:id", get(chats::get_one).patch(chats::patch))
        .route(
            "/api/chats/:id/prompts",
            get(chats::list_prompts).post(chats::add_prompt),
        )
        // "Smart send": the BE decides whether to dispatch immediately
        // or park on the queue based on authoritative server state.
        // FE callers should prefer this over POST .../prompts +
        // POST .../queue to avoid racing on busy / pending counts.
        .route("/api/chats/:id/messages", post(chats::send_message))
        // Cancel the in-flight agent turn (kills the provider
        // subprocess, appends a synthetic `cancelled by user`
        // error event, frees the chat for the next message).
        .route("/api/chats/:id/stop", post(chats::stop_turn))
        .route(
            "/api/chats/:chat_id/prompts/:prompt_id/revert",
            post(chats::revert_prompt),
        )
        // Queue
        .route(
            "/api/chats/:id/queue",
            get(queue::get_queue).post(queue::enqueue),
        )
        .route("/api/chats/:id/queue/mode", post(queue::set_mode))
        .route("/api/chats/:id/queue/next", post(queue::run_next))
        .route("/api/chats/:chat_id/queue/:item_id", delete(queue::cancel))
        // Notes (chat-scoped, legacy)
        .route("/api/chats/:id/notes", get(notes::list).post(notes::add))
        .route("/api/chats/:chat_id/notes/:note_id", delete(notes::delete))
        // Notes (project-scoped)
        .route(
            "/api/projects/:id/notes",
            get(notes::list_for_project).post(notes::add_for_project),
        )
        .route(
            "/api/projects/:project_id/notes/:note_id",
            delete(notes::delete_for_project),
        )
        // Settings
        .route("/api/settings", get(settings::get).put(settings::put))
        // Per-scope + global UI layout state (chat tabs, active
        // pane, queue dock visibility, etc.). Replaces the previous
        // localStorage-only model so the FE survives restarts and
        // follows the user across machines. See
        // `docs/architecture/chat-queue-routing.md` for the full
        // session-state model.
        .route("/api/layout", get(layout::get_all))
        .route("/api/layout/global", put(layout::put_global))
        .route("/api/layout/scope", put(layout::put_scope))
        // Per-project rich-text scratchpad
        .route(
            "/api/projects/:id/scratchpad",
            get(scratchpad::get).put(scratchpad::put),
        )
        // Terminal
        .route("/api/terminals", get(terminal::list).post(terminal::create))
        .route("/api/terminals/:id", delete(terminal::delete))
        .route("/api/terminals/:id/write", post(terminal::write))
        .route("/api/terminals/:id/resize", post(terminal::resize))
        .route("/api/terminals/:id/history", get(terminal::history))
        .route("/api/terminals/:id/status", get(terminal::status))
        // Filesystem browser (for folder picker)
        .route("/api/fs/home", get(fsapi::home))
        .route("/api/fs/browse", get(fsapi::browse))
        // Git inspection + per-file discard
        .route("/api/git/status", get(gitapi::git_status))
        .route("/api/git/discard", post(gitapi::git_discard))
        // Diagnostics (memory)
        .route("/api/diag/memory", get(diag::memory))
        // Backups (Settings -> Backups panel). The shell scripts
        // (`just backups` / `just restore-db`) remain the path
        // for offline recovery; this surface lets the FE list +
        // snapshot from a running server.
        .route("/api/backups", get(backups::list).post(backups::create))
        .route("/api/backups/:name/restore", post(backups::restore))
        // Editor
        .route(
            "/api/editor/file",
            get(editor::read).post(editor::write_file),
        )
        .route("/api/editor/diff", get(editor::diff))
        .route("/api/editor/tree", get(editor::tree))
        // Themes
        .route("/api/themes", get(themes::list).post(themes::import_theme))
        // Agent providers (Claude / future Codex / OpenCode / ...).
        // GET returns the detection status of every provider this
        // build knows about (installed? path? version?).
        .route("/api/providers", get(providers::list))
        .route("/api/providers/:id/commands", get(providers::commands))
        // Per-provider config — base URL + (optional) encrypted API
        // key for HTTP providers. Stored under
        // `<state_dir>/agentgrove.sqlite` (encrypted) + the key file
        // at `<state_dir>/secrets.key`. The GET response never echoes
        // the plaintext key; only the `has_api_key` flag.
        .route(
            "/api/providers/:id/config",
            get(providers::get_config)
                .put(providers::put_config)
                .delete(providers::delete_config),
        )
        // Manual refresh hook: invalidates the in-memory model
        // cache for `:id` and returns the freshly-detected
        // descriptor. The FE wires this to a refresh icon on the
        // Settings → Providers card + the new-chat model picker.
        .route(
            "/api/providers/:id/refresh",
            axum::routing::post(providers::refresh),
        )
        // Uploads (drag-drop + image paste in chat input). The body
        // limit is lifted just for these routes via a per-route layer
        // below.
        .route(
            "/api/uploads",
            post(uploads::create).layer(uploads::body_limit_layer()),
        )
        .route("/api/uploads/:id/raw", get(uploads::raw));

    let cors = CorsLayer::new()
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers(Any)
        .allow_origin(Any);

    let router = api.layer(cors).with_state(state);

    // Optional: serve a static FE bundle from `AGENTGROVE_STATIC_DIR`.
    // When set, every request that doesn't match an API / WS route
    // falls through to the SPA's `index.html` via
    // `tower_http::services::ServeDir`. This lets a single Docker
    // container serve both the API and the FE on the same port so
    // the browser's same-origin default in `api/client.ts` works
    // without any manual `ag-be` localStorage override.
    if let Ok(dir) = std::env::var("AGENTGROVE_STATIC_DIR") {
        let serve = tower_http::services::ServeDir::new(&dir)
            .not_found_service(tower_http::services::ServeFile::new(
                format!("{dir}/index.html"),
            ));
        router.fallback_service(serve)
    } else {
        router
    }
}
