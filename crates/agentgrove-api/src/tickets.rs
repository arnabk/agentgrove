//! `/api/projects/:id/tickets` — aggregate ticket/issue view + "work on
//! ticket" worktree bootstrap across GitHub / GitLab / ClickUp.
//!
//! GitHub and ClickUp are reached over their REST APIs using the OAuth
//! token stored in [`agentgrove_store::IntegrationRepo`]. GitLab uses
//! the already-authenticated `glab` CLI (no token stored), mirroring how
//! `prs.rs` fans out to forge CLIs.

use crate::state::AppState;
use crate::worktrees::{self, CreateWorktreeBody, WorktreeDto};
use agentgrove_git as git;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::path::Path as FsPath;

/// A single ticket/issue in the aggregated view.
#[derive(Debug, Clone, Serialize)]
pub struct TicketRow {
    pub provider: String,
    pub id: String,
    pub title: String,
    pub status: String,
    pub url: String,
    pub labels: Vec<String>,
    pub assignee: Option<String>,
    pub author: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub priority: Option<String>,
}

/// Body for `POST /api/projects/:id/tickets/:ticket_id/work`.
#[derive(Debug, Deserialize, Default)]
pub struct WorkOnTicketBody {
    /// Optional base ref for the new worktree branch. Defaults to `HEAD`.
    #[serde(default)]
    pub base_ref: Option<String>,
}

const GH_UA: &str = "agentgrove";

/// `GET /api/projects/:id/tickets` — list open tickets for a project's
/// forge. Errors from the provider degrade to an empty list (logged) so
/// one offline/unauthenticated repo can't sink the view.
pub async fn list_tickets(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<Vec<TicketRow>>, (StatusCode, String)> {
    let project = state.projects.get(&project_id).await.map_err(|e| match e {
        agentgrove_store::ProjectError::NotFound(_) => (
            StatusCode::NOT_FOUND,
            format!("project {project_id} not found"),
        ),
        other => (StatusCode::INTERNAL_SERVER_ERROR, format!("db: {other}")),
    })?;

    let forge = git::detect_forge(&project.root).await;
    let rows = match forge.forge.as_str() {
        "github" => {
            let Some(tok) = load_token(&state, "github").await else {
                tracing::info!(
                    project_id,
                    "github not connected; returning empty ticket list"
                );
                return Ok(Json(Vec::new()));
            };
            match remote_url(&project.root)
                .await
                .as_deref()
                .and_then(parse_github_remote)
            {
                Some((owner, repo)) => list_github_issues(&owner, &repo, &tok).await,
                None => {
                    tracing::warn!(project_id, "could not parse github remote");
                    Vec::new()
                }
            }
        }
        "gitlab" => list_gitlab_issues(&project.root).await,
        "clickup" => {
            let Some(tok) = load_token(&state, "clickup").await else {
                tracing::info!(
                    project_id,
                    "clickup not connected; returning empty ticket list"
                );
                return Ok(Json(Vec::new()));
            };
            list_clickup_tasks(&tok).await
        }
        other => {
            tracing::info!(project_id, forge = other, "no ticket provider for forge");
            Vec::new()
        }
    };
    Ok(Json(rows))
}

/// `POST /api/projects/:id/tickets/:ticket_id/work` — create a worktree
/// for a ticket, then assign it to the current user and move it to "In
/// Progress" on the provider.
///
/// The worktree is created via the shared [`worktrees::create`] flow so
/// the pre-script + fetch-from-origin freshness guarantees are identical
/// to a manually-created worktree. The provider mutations are
/// best-effort: a failed assign/transition is logged but does not fail
/// the request (the worktree is what the user actually needs).
pub async fn work_on_ticket(
    State(state): State<AppState>,
    Path((project_id, ticket_id)): Path<(String, String)>,
    Json(body): Json<WorkOnTicketBody>,
) -> Result<Json<WorktreeDto>, (StatusCode, String)> {
    let project = state.projects.get(&project_id).await.map_err(|e| match e {
        agentgrove_store::ProjectError::NotFound(_) => (
            StatusCode::NOT_FOUND,
            format!("project {project_id} not found"),
        ),
        other => (StatusCode::INTERNAL_SERVER_ERROR, format!("db: {other}")),
    })?;

    let forge = git::detect_forge(&project.root).await;

    // Find the ticket so we can build a descriptive branch slug.
    let tickets = list_tickets(State(state.clone()), Path(project_id.clone()))
        .await?
        .0;
    let ticket = tickets.iter().find(|t| t.id == ticket_id).ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            format!("ticket {ticket_id} not found in project {project_id}"),
        )
    })?;

    let branch = format!("ticket/{}-{}", ticket_id, slugify(&ticket.title));
    let base_ref = body
        .base_ref
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| "HEAD".to_owned());

    // Reuse the shared worktree creation handler.
    let created = worktrees::create(
        State(state.clone()),
        Path(project_id.clone()),
        Json(CreateWorktreeBody {
            branch,
            base_ref,
            path: None,
            pre_script: None,
            post_script: None,
        }),
    )
    .await?;

    // Best-effort provider mutations: assign to current user + move to
    // "In Progress". Failures are logged, never fatal.
    match forge.forge.as_str() {
        "github" => {
            if let Some(tok) = load_token(&state, "github").await {
                if let Some((owner, repo)) = remote_url(&project.root)
                    .await
                    .as_deref()
                    .and_then(parse_github_remote)
                {
                    github_assign_self(&owner, &repo, &ticket_id, &tok).await;
                }
            }
        }
        "gitlab" => {
            gitlab_start_issue(&project.root, &ticket_id).await;
        }
        "clickup" => {
            if let Some(tok) = load_token(&state, "clickup").await {
                clickup_start_task(&ticket_id, &tok).await;
            }
        }
        _ => {}
    }

    Ok(created)
}

// ---- token helper --------------------------------------------------------

async fn load_token(state: &AppState, provider: &str) -> Option<String> {
    match state.integration_store.get_token(provider).await {
        Ok(Some(t)) => Some(t.access_token),
        Ok(None) => None,
        Err(e) => {
            tracing::warn!(provider, error = %e, "failed to load integration token");
            None
        }
    }
}

// ---- GitHub --------------------------------------------------------------

/// Parse `https://github.com/owner/repo(.git)` or
/// `git@github.com:owner/repo.git` into `(owner, repo)`.
fn parse_github_remote(url: &str) -> Option<(String, String)> {
    let url = url.trim();
    let path = [
        "git@github.com:",
        "https://github.com/",
        "http://github.com/",
        "ssh://git@github.com/",
    ]
    .iter()
    .find_map(|prefix| url.strip_prefix(prefix))?;
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut parts = path.splitn(2, '/');
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim().trim_end_matches('/');
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner.to_owned(), repo.to_owned()))
}

async fn remote_url(cwd: &FsPath) -> Option<String> {
    let out = tokio::process::Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(cwd)
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if url.is_empty() {
        None
    } else {
        Some(url)
    }
}

async fn list_github_issues(owner: &str, repo: &str, token: &str) -> Vec<TicketRow> {
    let url = format!("https://api.github.com/repos/{owner}/{repo}/issues?state=open&per_page=100");
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, GH_UA)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .bearer_auth(token)
        .send()
        .await;
    let items: Vec<serde_json::Value> = match resp {
        Ok(r) if r.status().is_success() => r.json().await.unwrap_or_default(),
        Ok(r) => {
            tracing::warn!(status = %r.status(), "github issues list returned non-success");
            return Vec::new();
        }
        Err(e) => {
            tracing::warn!(error = %e, "github issues list request failed");
            return Vec::new();
        }
    };
    items
        .into_iter()
        // GitHub returns PRs in the issues endpoint; filter them out.
        .filter(|it| it.get("pull_request").is_none())
        .map(|it| {
            let number = it
                .get("number")
                .and_then(serde_json::Value::as_u64)
                .map(|n| n.to_string())
                .unwrap_or_default();
            let labels = it
                .get("labels")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|l| l.get("name").and_then(|v| v.as_str()).map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            TicketRow {
                provider: "github".into(),
                id: number,
                title: it
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                status: it
                    .get("state")
                    .and_then(|v| v.as_str())
                    .unwrap_or("open")
                    .to_string(),
                url: it
                    .get("html_url")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                labels,
                assignee: it
                    .get("assignee")
                    .and_then(|a| a.get("login"))
                    .and_then(|v| v.as_str())
                    .map(String::from),
                author: it
                    .get("user")
                    .and_then(|u| u.get("login"))
                    .and_then(|v| v.as_str())
                    .map(String::from),
                created_at: it
                    .get("created_at")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                updated_at: it
                    .get("updated_at")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                priority: None,
            }
        })
        .collect()
}

async fn github_assign_self(owner: &str, repo: &str, issue: &str, token: &str) {
    let client = reqwest::Client::new();
    // Resolve the token's own login so we can self-assign.
    let login = match client
        .get("https://api.github.com/user")
        .header(reqwest::header::USER_AGENT, GH_UA)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .bearer_auth(token)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("login").and_then(|l| l.as_str()).map(String::from)),
        _ => None,
    };
    let Some(login) = login else {
        tracing::warn!("github: could not resolve current user for self-assign");
        return;
    };
    let url = format!("https://api.github.com/repos/{owner}/{repo}/issues/{issue}/assignees");
    let res = client
        .post(&url)
        .header(reqwest::header::USER_AGENT, GH_UA)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .bearer_auth(token)
        .json(&serde_json::json!({ "assignees": [login] }))
        .send()
        .await;
    if let Err(e) = res {
        tracing::warn!(error = %e, "github: assign self failed");
    }
    // GitHub issues have no native "In Progress" state; the standard
    // convention is a label. Add an "in progress" label best-effort.
    let label_url = format!("https://api.github.com/repos/{owner}/{repo}/issues/{issue}/labels");
    let _ = client
        .post(&label_url)
        .header(reqwest::header::USER_AGENT, GH_UA)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .bearer_auth(token)
        .json(&serde_json::json!({ "labels": ["in progress"] }))
        .send()
        .await;
}

// ---- GitLab (glab CLI) ---------------------------------------------------

/// List open GitLab issues via `glab issue list -F json` in the
/// project's root dir.
async fn list_gitlab_issues(cwd: &FsPath) -> Vec<TicketRow> {
    let out = tokio::process::Command::new("glab")
        .args(["issue", "list", "-F", "json"])
        .current_dir(cwd)
        .output()
        .await;
    let stdout = match out {
        Ok(o) if o.status.success() => o.stdout,
        Ok(o) => {
            tracing::warn!(
                stderr = %String::from_utf8_lossy(&o.stderr),
                "glab issue list failed"
            );
            return Vec::new();
        }
        Err(e) => {
            tracing::warn!(error = %e, "glab not runnable");
            return Vec::new();
        }
    };
    let items: Vec<serde_json::Value> = serde_json::from_slice(&stdout).unwrap_or_default();
    items
        .into_iter()
        .map(|it| {
            let labels = it
                .get("labels")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|l| {
                            l.as_str().map(String::from).or_else(|| {
                                l.get("name").and_then(|n| n.as_str()).map(String::from)
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            TicketRow {
                provider: "gitlab".into(),
                id: it
                    .get("iid")
                    .and_then(serde_json::Value::as_u64)
                    .map(|n| n.to_string())
                    .unwrap_or_default(),
                title: it
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                status: it
                    .get("state")
                    .and_then(|v| v.as_str())
                    .unwrap_or("opened")
                    .to_string(),
                url: it
                    .get("web_url")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                labels,
                assignee: it
                    .get("assignee")
                    .and_then(|a| a.get("username"))
                    .and_then(|v| v.as_str())
                    .map(String::from),
                author: it
                    .get("author")
                    .and_then(|a| a.get("username"))
                    .and_then(|v| v.as_str())
                    .map(String::from),
                created_at: it
                    .get("created_at")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                updated_at: it
                    .get("updated_at")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                priority: None,
            }
        })
        .collect()
}

async fn gitlab_start_issue(cwd: &FsPath, iid: &str) {
    // Self-assign via glab.
    let assign = tokio::process::Command::new("glab")
        .args(["issue", "update", iid, "--assignee", "@me"])
        .current_dir(cwd)
        .output()
        .await;
    if let Err(e) = assign {
        tracing::warn!(error = %e, "glab issue update --assignee failed to run");
    }
    // Move to an "In Progress"-style workflow label (repo-dependent).
    let _ = tokio::process::Command::new("glab")
        .args(["issue", "update", iid, "--label", "In Progress"])
        .current_dir(cwd)
        .output()
        .await;
}

// ---- ClickUp -------------------------------------------------------------

async fn list_clickup_tasks(token: &str) -> Vec<TicketRow> {
    // ClickUp requires a team/list scope to list tasks; without a
    // configured list id we can only surface the authenticated user's
    // tasks via the team endpoint. We keep this best-effort: resolve the
    // first team, then pull its filtered tasks.
    let client = reqwest::Client::new();
    let teams: serde_json::Value = match client
        .get("https://api.clickup.com/api/v2/team")
        .header(reqwest::header::AUTHORIZATION, token)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r.json().await.unwrap_or_default(),
        Ok(r) => {
            tracing::warn!(status = %r.status(), "clickup team list non-success");
            return Vec::new();
        }
        Err(e) => {
            tracing::warn!(error = %e, "clickup team list failed");
            return Vec::new();
        }
    };
    let Some(team_id) = teams
        .get("teams")
        .and_then(|t| t.as_array())
        .and_then(|arr| arr.first())
        .and_then(|t| t.get("id"))
        .and_then(|v| v.as_str())
    else {
        return Vec::new();
    };
    let url = format!(
        "https://api.clickup.com/api/v2/team/{team_id}/task?subtasks=true&include_closed=false"
    );
    let tasks: serde_json::Value = match client
        .get(&url)
        .header(reqwest::header::AUTHORIZATION, token)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r.json().await.unwrap_or_default(),
        _ => return Vec::new(),
    };
    tasks
        .get("tasks")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .map(|it| TicketRow {
                    provider: "clickup".into(),
                    id: it
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    title: it
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    status: it
                        .get("status")
                        .and_then(|s| s.get("status"))
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    url: it
                        .get("url")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    labels: Vec::new(),
                    assignee: it
                        .get("assignees")
                        .and_then(|a| a.as_array())
                        .and_then(|arr| arr.first())
                        .and_then(|a| a.get("username"))
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    author: it
                        .get("creator")
                        .and_then(|c| c.get("username"))
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    created_at: it
                        .get("date_created")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    updated_at: it
                        .get("date_updated")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    priority: it
                        .get("priority")
                        .and_then(|p| p.get("priority"))
                        .and_then(|v| v.as_str())
                        .map(String::from),
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn clickup_start_task(task_id: &str, token: &str) {
    let client = reqwest::Client::new();
    // Resolve current user id for assignment.
    let uid = match client
        .get("https://api.clickup.com/api/v2/user")
        .header(reqwest::header::AUTHORIZATION, token)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {
            r.json::<serde_json::Value>().await.ok().and_then(|v| {
                v.get("user")
                    .and_then(|u| u.get("id"))
                    .and_then(|id| id.as_i64())
            })
        }
        _ => None,
    };
    let mut body = serde_json::json!({ "status": "in progress" });
    if let Some(uid) = uid {
        body["assignees"] = serde_json::json!({ "add": [uid] });
    }
    let url = format!("https://api.clickup.com/api/v2/task/{task_id}");
    if let Err(e) = client
        .put(&url)
        .header(reqwest::header::AUTHORIZATION, token)
        .json(&body)
        .send()
        .await
    {
        tracing::warn!(error = %e, "clickup: start task update failed");
    }
}

// ---- helpers -------------------------------------------------------------

/// Lowercase, hyphenate, and truncate a title into a branch-safe slug.
fn slugify(title: &str) -> String {
    let mut slug = String::new();
    let mut prev_dash = false;
    for c in title.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !slug.is_empty() {
            slug.push('-');
            prev_dash = true;
        }
    }
    let slug = slug.trim_end_matches('-');
    slug.chars()
        .take(40)
        .collect::<String>()
        .trim_end_matches('-')
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_https_github_remote() {
        assert_eq!(
            parse_github_remote("https://github.com/owner/repo"),
            Some(("owner".into(), "repo".into()))
        );
        assert_eq!(
            parse_github_remote("https://github.com/owner/repo.git"),
            Some(("owner".into(), "repo".into()))
        );
    }

    #[test]
    fn parse_ssh_github_remote() {
        assert_eq!(
            parse_github_remote("git@github.com:owner/repo.git"),
            Some(("owner".into(), "repo".into()))
        );
        assert_eq!(
            parse_github_remote("ssh://git@github.com/owner/repo.git"),
            Some(("owner".into(), "repo".into()))
        );
    }

    #[test]
    fn parse_non_github_remote_is_none() {
        assert_eq!(parse_github_remote("https://gitlab.com/o/r.git"), None);
        assert_eq!(parse_github_remote("not a url"), None);
    }

    #[test]
    fn slugify_makes_branch_safe() {
        assert_eq!(slugify("Fix the Login Bug!"), "fix-the-login-bug");
        assert_eq!(slugify("  Spaces   & symbols  "), "spaces-symbols");
        assert!(slugify(&"a".repeat(100)).len() <= 40);
    }
}
