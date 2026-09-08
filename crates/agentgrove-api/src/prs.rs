//! `/api/prs` — aggregate open PRs/MRs across all projects.
//!
//! Each AgentGrove project maps to a repo checkout. We fan out to the
//! forge CLI (`gh`/`glab`) in every project root and merge the results
//! into one list, tagged with the owning project so the FE can render a
//! single searchable "PR center". Repos without a forge CLI (or not on
//! a supported host) simply contribute nothing.

use crate::state::AppState;
use agentgrove_git as git;
use axum::{extract::State, Json};
use serde::Serialize;

/// One open PR/MR row in the aggregate list.
#[derive(Debug, Clone, Serialize)]
pub struct PrRow {
    pub project_id: String,
    pub project_name: String,
    pub number: u64,
    pub title: String,
    pub state: String,
    pub url: String,
    pub source: String,
    pub branch: String,
    pub author: Option<String>,
    pub draft: bool,
    pub created_at: Option<String>,
    pub checks_status: Option<String>,
    pub review_decision: Option<String>,
}

/// `GET /api/prs` — list every open PR/MR across all projects.
///
/// Fans out concurrently (one forge-CLI call per project) so a dozen
/// repos don't serialize into a slow request. Errors per project are
/// swallowed to empty so one unauthenticated/offline repo can't sink
/// the whole view.
pub async fn list_all(State(state): State<AppState>) -> Json<Vec<PrRow>> {
    let projects = state.projects.list().await.unwrap_or_default();
    let futures = projects.into_iter().map(|p| async move {
        let items = git::list_open_prs(&p.root).await;
        items
            .into_iter()
            .map(move |it| PrRow {
                project_id: p.id.clone(),
                project_name: p.name.clone(),
                number: it.number,
                title: it.title,
                state: it.state,
                url: it.url,
                source: it.source,
                branch: it.branch,
                author: it.author,
                draft: it.draft,
                created_at: it.created_at,
                checks_status: it.checks_status,
                review_decision: it.review_decision,
            })
            .collect::<Vec<_>>()
    });
    let per_project = futures::future::join_all(futures).await;
    let mut out: Vec<PrRow> = per_project.into_iter().flatten().collect();
    // Newest first by creation time (missing timestamps sort last).
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Json(out)
}
