//! Open a project or worktree root in the OS file manager.
//!
//! The browser cannot reveal a local path (no `file://` directory access),
//! so the FE asks the backend to shell out. We use the cross-platform
//! `open` crate — Finder on macOS, Explorer on Windows, xdg-open on Linux
//! — so there is no per-OS `Command` code to maintain.
//!
//! Security: the handler NEVER accepts a client-supplied path. It resolves
//! the registered project / worktree by id and opens its stored root, so a
//! hostile web page can't use this endpoint to open arbitrary local paths.

use crate::state::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
};

/// Spawn the file-manager open off the async runtime so a slow / blocking
/// `open` call (e.g. Finder taking a moment to focus) never stalls a worker
/// thread. Errors are logged, not surfaced — the user sees the file manager
/// appear or nothing happens, and a 500 here would be a worse UX than a
/// silent no-op with a log line.
fn spawn_open(path: std::path::PathBuf) {
    tokio::task::spawn_blocking(move || {
        if let Err(e) = open::that(&path) {
            tracing::warn!(path = %path.display(), error = %e, "open in file manager failed");
        }
    });
}

/// `POST /api/projects/:id/open` — reveal the project root.
pub async fn open_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> StatusCode {
    let project = match state.projects.get(&project_id).await {
        Ok(p) => p,
        Err(_) => return StatusCode::NOT_FOUND,
    };
    spawn_open(project.root);
    StatusCode::NO_CONTENT
}

/// `POST /api/worktrees/:id/open` — reveal the worktree path.
pub async fn open_worktree(
    State(state): State<AppState>,
    Path(worktree_id): Path<String>,
) -> StatusCode {
    let wt = match state.worktrees.get(&worktree_id).await {
        Ok(w) => w,
        Err(_) => return StatusCode::NOT_FOUND,
    };
    spawn_open(wt.path);
    StatusCode::NO_CONTENT
}
