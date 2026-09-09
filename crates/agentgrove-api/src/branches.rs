//! Branch listing + switching for a project's root folder.
//!
//! `GET /api/projects/:id/branches` returns the local branches plus a
//! flag indicating which one is currently checked out.
//!
//! `POST /api/projects/:id/branch` switches (or creates+switches with
//! `create: true`) to the requested branch.

use crate::state::AppState;
use agentgrove_git::{list_local, pull_current, switch_branch, GitError};
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

#[derive(Debug, Serialize)]
pub struct PullResultDto {
    /// Short human-readable summary from git (e.g. "Already up to date."
    /// or "Fast-forward").
    pub summary: String,
}

/// `POST /api/projects/:id/pull` — fast-forward the main repo's current
/// branch from its upstream. Operates on the project root, never on a
/// worktree.
pub async fn pull_handler(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<PullResultDto>, (StatusCode, String)> {
    let project = state
        .projects
        .get(&project_id)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "project not found".into()))?;
    match pull_current(&project.root).await {
        Ok(out) => {
            let summary = summarize_pull(&out);
            Ok(Json(PullResultDto { summary }))
        }
        Err(GitError::GitNotFound) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "git binary not found on PATH".into(),
        )),
        Err(GitError::NonZero { code, stderr }) => Err((
            StatusCode::BAD_REQUEST,
            format!("git pull failed (exit {code}): {stderr}"),
        )),
        Err(GitError::Io(e)) => Err((StatusCode::INTERNAL_SERVER_ERROR, format!("io: {e}"))),
    }
}

/// Reduce `git pull --ff-only` stdout to a single human-friendly line.
///
/// A fast-forward pull prints `Updating <a>..<b>`, `Fast-forward`, then a
/// diffstat; picking the last line would surface a noisy `create mode …`
/// entry. We prefer the recognizable status line and only fall back to
/// the first non-empty line for unexpected output shapes.
fn summarize_pull(out: &str) -> String {
    let lines: Vec<&str> = out
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    for l in &lines {
        if l.starts_with("Already up to date")
            || l.starts_with("Fast-forward")
            || l.starts_with("Updating ")
        {
            return (*l).to_string();
        }
    }
    lines
        .first()
        .copied()
        .unwrap_or("Pulled latest from remote.")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::summarize_pull;

    #[test]
    fn up_to_date() {
        assert_eq!(
            summarize_pull("Already up to date.\n"),
            "Already up to date."
        );
    }

    #[test]
    fn fast_forward_prefers_status_over_diffstat() {
        let out = "Updating a1b2c3d..e4f5g6h\nFast-forward\n scripts/x.sh | 2 +-\n create mode 100755 scripts/x.sh\n";
        assert_eq!(summarize_pull(out), "Updating a1b2c3d..e4f5g6h");
    }

    #[test]
    fn empty_output_falls_back() {
        assert_eq!(summarize_pull("\n\n"), "Pulled latest from remote.");
    }
}
