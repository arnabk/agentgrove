//! Git inspection endpoints.
//!
//! `GET /api/git/status?path=...` returns the changed-file list for the
//! working tree at `path`. Empty list = clean (or not a git repo).
//!
//! Diff for a single file is exposed by the existing
//! `GET /api/editor/diff?path=...` route, which the FE reuses.
//!
//! `POST /api/git/discard` discards working-tree changes for a single
//! file, VSCode-style: restores tracked files from HEAD, deletes
//! untracked files from disk. See `agentgrove_git::discard_path` for
//! the per-case logic.

use agentgrove_git::{discard_path, status, DiscardOutcome, GitError};
use axum::{extract::Query, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
pub struct StatusQuery {
    /// Absolute path to the working-tree root (project or worktree).
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct StatusEntryDto {
    pub path: String,
    pub orig_path: Option<String>,
    /// Index (staged) marker. Space when clean.
    pub x: String,
    /// Working tree marker. Space when clean.
    pub y: String,
    pub modified: bool,
    pub added: bool,
    pub deleted: bool,
    pub renamed: bool,
    pub untracked: bool,
    pub ignored: bool,
}

#[derive(Debug, Serialize)]
pub struct StatusResponse {
    pub path: String,
    pub entries: Vec<StatusEntryDto>,
}

pub async fn git_status(
    Query(q): Query<StatusQuery>,
) -> Result<Json<StatusResponse>, (StatusCode, String)> {
    let path = PathBuf::from(&q.path);
    if !path.is_absolute() {
        return Err((StatusCode::BAD_REQUEST, "path must be absolute".into()));
    }
    if !path.is_dir() {
        return Err((StatusCode::NOT_FOUND, "path is not a directory".into()));
    }
    let entries = status(&path)
        .await
        .into_iter()
        .filter(|e| !e.is_ignored())
        .map(|e| StatusEntryDto {
            path: e.path.clone(),
            orig_path: e.orig_path.clone(),
            x: e.x.to_string(),
            y: e.y.to_string(),
            modified: e.is_modified(),
            added: e.is_added() && !e.is_untracked(),
            deleted: e.is_deleted(),
            renamed: e.is_renamed(),
            untracked: e.is_untracked(),
            ignored: e.is_ignored(),
        })
        .collect();
    Ok(Json(StatusResponse {
        path: q.path,
        entries,
    }))
}

/// Body for `POST /api/git/discard`.
///
/// `cwd` is the absolute working-tree root (project root or
/// worktree path — same value the FE already passes to
/// `/api/git/status`). `rel_path` is the repo-relative path of the
/// single file the user clicked Discard on in ChangesPanel.
///
/// Both fields are required; the BE does NOT infer `cwd` from
/// `rel_path` because the same relative path can exist in multiple
/// worktrees of the same project and we want the FE to be explicit
/// about which one is being mutated.
#[derive(Debug, Deserialize)]
pub struct DiscardBody {
    /// Absolute path to the working-tree root.
    pub cwd: String,
    /// Repo-relative path of the file to discard.
    pub rel_path: String,
}

/// Response from `POST /api/git/discard` — echoes the outcome so the
/// FE can show a precise toast ("Restored foo.ts" vs "Deleted untracked
/// foo.ts"). `noop` covers the idempotent case where the file is no
/// longer changed (e.g. the user clicked Discard twice in quick
/// succession).
#[derive(Debug, Serialize)]
pub struct DiscardResponse {
    /// One of `restored` | `deleted_untracked` | `noop`.
    pub outcome: &'static str,
    /// Echo of the discarded path so the FE can match it to a row
    /// without tracking request state.
    pub path: String,
}

pub async fn git_discard(
    Json(body): Json<DiscardBody>,
) -> Result<Json<DiscardResponse>, (StatusCode, String)> {
    let cwd = PathBuf::from(&body.cwd);
    if !cwd.is_absolute() {
        return Err((StatusCode::BAD_REQUEST, "cwd must be absolute".into()));
    }
    if !cwd.is_dir() {
        return Err((StatusCode::NOT_FOUND, "cwd is not a directory".into()));
    }
    let outcome = discard_path(&cwd, &body.rel_path).await.map_err(|e| {
        // Validation failures from the git crate (empty path, absolute
        // rel_path, `..` traversal) are reported as `NonZero { code: -1 }`.
        // Treat those as 400; everything else is a server error.
        match &e {
            GitError::NonZero { code: -1, stderr } => {
                (StatusCode::BAD_REQUEST, stderr.clone())
            }
            _ => (StatusCode::INTERNAL_SERVER_ERROR, format!("discard failed: {e}")),
        }
    })?;
    let label = match outcome {
        DiscardOutcome::Restored => "restored",
        DiscardOutcome::DeletedUntracked => "deleted_untracked",
        DiscardOutcome::Noop => "noop",
    };
    Ok(Json(DiscardResponse {
        outcome: label,
        path: body.rel_path,
    }))
}
