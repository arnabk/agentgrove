//! Branch listing + switching for a project's root folder.
//!
//! `GET /api/projects/:id/branches` returns the local branches plus a
//! flag indicating which one is currently checked out.
//!
//! `POST /api/projects/:id/branch` switches (or creates+switches with
//! `create: true`) to the requested branch.

use crate::state::AppState;
use agentgrove_git::{list_local, switch_branch, GitError};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
pub struct BranchDto {
    pub name: String,
    pub current: bool,
}

pub async fn list_branches(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<Vec<BranchDto>>, (StatusCode, String)> {
    let project = state
        .projects
        .get(&project_id)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "project not found".into()))?;
    let entries = list_local(&project.root).await;
    Ok(Json(
        entries
            .into_iter()
            .map(|b| BranchDto {
                name: b.name,
                current: b.current,
            })
            .collect(),
    ))
}

#[derive(Debug, Deserialize)]
pub struct SwitchBranchBody {
    pub branch: String,
    /// When true, create the branch off HEAD (`git switch -c <name>`).
    #[serde(default)]
    pub create: bool,
}

pub async fn switch_handler(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(body): Json<SwitchBranchBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    let branch = body.branch.trim();
    if branch.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "branch name is required".into()));
    }
    let project = state
        .projects
        .get(&project_id)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "project not found".into()))?;
    match switch_branch(&project.root, branch, body.create).await {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(GitError::GitNotFound) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "git binary not found on PATH".into(),
        )),
        Err(GitError::NonZero { code, stderr }) => Err((
            StatusCode::BAD_REQUEST,
            format!("git switch failed (exit {code}): {stderr}"),
        )),
        Err(GitError::Io(e)) => Err((StatusCode::INTERNAL_SERVER_ERROR, format!("io: {e}"))),
    }
}
