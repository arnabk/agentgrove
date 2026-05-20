//! Axum router.

use crate::{
    branches, chats, diag, editor, fs as fsapi, git as gitapi, health::health, notes, projects,
    providers, queue, scratchpad, settings, state::AppState, terminal, themes, worktrees, ws,
};
use axum::{
    http::Method,
    routing::{delete, get, post},
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
            get(projects::get_one).delete(projects::delete),
        )
        // Project branches (list + switch)
        .route("/api/projects/:id/branches", get(branches::list_branches))
        .route("/api/projects/:id/branch", post(branches::switch_handler))
        // Worktrees
        .route(
            "/api/projects/:id/worktrees",
            get(worktrees::list_for_project).post(worktrees::create),
        )
        .route(
            "/api/projects/:project_id/worktrees/:worktree_id",
            delete(worktrees::delete),
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
            get(chats::list_for_project_handler)
                .post(chats::create_for_project_handler),
        )
        .route("/api/chats/:id", get(chats::get_one))
        .route(
            "/api/chats/:id/prompts",
            get(chats::list_prompts).post(chats::add_prompt),
        )
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
        // Git inspection
        .route("/api/git/status", get(gitapi::git_status))
        // Diagnostics (memory)
        .route("/api/diag/memory", get(diag::memory))
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
        .route("/api/providers", get(providers::list));

    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE, Method::OPTIONS])
        .allow_headers(Any)
        .allow_origin(Any);

    api.layer(cors).with_state(state)
}
