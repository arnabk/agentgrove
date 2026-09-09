//! `/api/branches` — aggregate local branches across all projects.
//!
//! Mirrors the PR center (`/api/prs`) but for git branches: fan out to
//! every project root, list its local branches with commit metadata,
//! and merge into one searchable list tagged with the owning project.

use crate::state::AppState;
use agentgrove_git as git;
use axum::{extract::State, Json};
use serde::Serialize;

/// One branch row in the aggregate list.
#[derive(Debug, Clone, Serialize)]
pub struct BranchRow {
    pub project_id: String,
    pub project_name: String,
    pub name: String,
    pub current: bool,
    pub committed_at: Option<String>,
    pub subject: Option<String>,
    pub upstream: Option<String>,
}

/// `GET /api/branches` — list local branches across all projects.
///
/// Fans out concurrently (one `git for-each-ref` per project). Non-git
/// projects contribute nothing. Sorted newest-committed first.
pub async fn list_all(State(state): State<AppState>) -> Json<Vec<BranchRow>> {
    let projects = state.projects.list().await.unwrap_or_default();
    let futures = projects.into_iter().map(|p| async move {
        git::list_detailed(&p.root)
            .await
            .into_iter()
            .map(move |b| BranchRow {
                project_id: p.id.clone(),
                project_name: p.name.clone(),
                name: b.name,
                current: b.current,
                committed_at: b.committed_at,
                subject: b.subject,
                upstream: b.upstream,
            })
            .collect::<Vec<_>>()
    });
    let per_project = futures::future::join_all(futures).await;
    let mut out: Vec<BranchRow> = per_project.into_iter().flatten().collect();
    out.sort_by(|a, b| b.committed_at.cmp(&a.committed_at));
    Json(out)
}
