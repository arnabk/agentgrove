//! `/api/prs` — aggregate open PRs/MRs across all projects.
//!
//! Each AgentGrove project maps to a repo checkout. We fan out to the
//! forge CLI (`gh`/`glab`) in every project root and merge the results
//! into one list, tagged with the owning project so the FE can render a
//! single searchable "PR center". Repos without a forge CLI (or not on
//! a supported host) simply contribute nothing.

use crate::state::AppState;
use agentgrove_git as git;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::path::Path as FsPath;

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

/// Body for `POST /api/projects/:id/prs/:number/close`.
#[derive(Debug, Deserialize)]
pub struct ClosePrBody {
    /// Which forge CLI to use: `"gh"` (GitHub) or `"glab"` (GitLab).
    pub source: String,
}

/// `POST /api/projects/:id/prs/:number/close` — close an open PR/MR via
/// the matching forge CLI in the project root. Returns 204 on success.
pub async fn close_pr(
    State(state): State<AppState>,
    Path((project_id, pr_number)): Path<(String, u64)>,
    Json(body): Json<ClosePrBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    let project = state
        .projects
        .get(&project_id)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "project not found".into()))?;

    let number = pr_number.to_string();
    let (bin, args): (&str, [&str; 3]) = match body.source.as_str() {
        "gh" => ("gh", ["pr", "close", &number]),
        "glab" => ("glab", ["mr", "close", &number]),
        other => {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("unsupported source: {other} (expected \"gh\" or \"glab\")"),
            ));
        }
    };

    run_close(bin, &args, &project.root).await
}

/// Run a forge-CLI close command with a 15s timeout (mirrors the pattern
/// in `tickets.rs`). Maps failures to HTTP errors.
async fn run_close(
    bin: &str,
    args: &[&str],
    cwd: &FsPath,
) -> Result<StatusCode, (StatusCode, String)> {
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        tokio::process::Command::new(bin)
            .args(args)
            .current_dir(cwd)
            .output(),
    )
    .await;
    match out {
        Ok(Ok(o)) if o.status.success() => Ok(StatusCode::NO_CONTENT),
        Ok(Ok(o)) => Err((
            StatusCode::BAD_REQUEST,
            format!("{bin} close failed: {}", String::from_utf8_lossy(&o.stderr)),
        )),
        Ok(Err(e)) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("{bin} not runnable: {e}"),
        )),
        Err(_) => Err((
            StatusCode::GATEWAY_TIMEOUT,
            format!("{bin} close timed out after 15s"),
        )),
    }
}
