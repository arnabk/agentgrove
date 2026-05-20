//! Git inspection endpoints.
//!
//! `GET /api/git/status?path=...` returns the changed-file list for the
//! working tree at `path`. Empty list = clean (or not a git repo).
//!
//! Diff for a single file is exposed by the existing
//! `GET /api/editor/diff?path=...` route, which the FE reuses.

use agentgrove_git::status;
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
