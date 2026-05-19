//! Axum router.

use crate::{
    auth::require_bearer, chats, editor, health::health, notes, projects, queue, state::AppState,
    terminal, themes, worktrees, ws,
};
use axum::{
    http::Method,
    middleware,
    routing::{delete, get, post},
    Router,
};
use tower_http::cors::{Any, CorsLayer};

/// Build the full router. Used by both the binary and L4 endpoint tests.
pub fn build_router(state: AppState) -> Router {
    let public = Router::new()
        .route("/health", get(health))
        .route("/ws", get(ws::handler));

    let protected = Router::new()
        .route("/whoami", get(whoami))
        // Projects
        .route("/api/projects", get(projects::list).post(projects::create))
        .route(
            "/api/projects/:id",
            get(projects::get_one).delete(projects::delete),
        )
        // Worktrees
        .route(
            "/api/projects/:id/worktrees",
            get(worktrees::list_for_project).post(worktrees::create),
        )
        .route(
            "/api/projects/:project_id/worktrees/:worktree_id",
            delete(worktrees::delete),
        )
        // Chats
        .route(
            "/api/worktrees/:id/chats",
            get(chats::list).post(chats::create),
        )
        .route("/api/chats/:id", get(chats::get_one))
        .route("/api/chats/:id/prompts", post(chats::add_prompt))
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
        // Notes
        .route("/api/chats/:id/notes", get(notes::list).post(notes::add))
        .route("/api/chats/:chat_id/notes/:note_id", delete(notes::delete))
        // Terminal
        .route("/api/terminals", get(terminal::list).post(terminal::create))
        .route("/api/terminals/:id", delete(terminal::delete))
        .route("/api/terminals/:id/write", post(terminal::write))
        .route("/api/terminals/:id/resize", post(terminal::resize))
        .route("/api/terminals/:id/history", get(terminal::history))
        // Editor
        .route(
            "/api/editor/file",
            get(editor::read).post(editor::write_file),
        )
        .route("/api/editor/diff", get(editor::diff))
        .route("/api/editor/tree", get(editor::tree))
        // Themes
        .route("/api/themes", get(themes::list).post(themes::import_theme))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_bearer,
        ));

    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
        .allow_headers(Any)
        .allow_origin(Any);

    Router::new()
        .merge(public)
        .merge(protected)
        .layer(cors)
        .with_state(state)
}

async fn whoami() -> &'static str {
    "authenticated"
}
