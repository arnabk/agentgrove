//! `/api/projects/:id/tickets` — aggregate ticket/issue view + "work on
//! ticket" worktree bootstrap across GitHub / GitLab / ClickUp.
//!
//! GitHub and GitLab ride their already-authenticated `gh` / `glab`
//! CLIs (no token stored), mirroring how `prs.rs` fans out to forge
//! CLIs. ClickUp is reached over its REST API using the stored API key
//! stored in [`agentgrove_store::IntegrationRepo`].

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

/// `GET /api/projects/:id/tickets` — list open GitHub/GitLab issues for
/// a project's forge (per-repo). ClickUp is workspace-level and lives on
/// its own `/api/clickup/tasks` endpoint. Errors from the provider
/// degrade to an empty list (logged) so one offline/unauthenticated repo
/// can't sink the view.
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
        "github" => list_github_issues_cli(&project.root).await,
        "gitlab" => list_gitlab_issues(&project.root).await,
        other => {
            tracing::info!(
                project_id,
                forge = other,
                "no git ticket provider for forge"
            );
            Vec::new()
        }
    };
    Ok(Json(rows))
}

/// How long a cached ClickUp task list stays fresh. ClickUp allows
/// ~100 requests/min/token; a 60s TTL keeps this endpoint to at most
/// one upstream call per minute no matter how often the FE polls.
const CLICKUP_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(60);

/// How long the ClickUp List catalog stays fresh. Lists rarely change,
/// so this is much longer than the task TTL.
const CLICKUP_LISTS_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(600);

/// TTL for the member + status catalogs (assignee/status filter pickers).
/// These change rarely and the status walk costs extra API calls, so a
/// long window keeps them served from cache almost always.
const CLICKUP_META_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(1800);

/// `GET /api/clickup/tasks` — list the authenticated user's ClickUp tasks.
/// Not scoped to any project (ClickUp is workspace-level, not repo-level).
///
/// Served from an in-memory TTL cache to avoid hammering the ClickUp API
/// (and tripping its rate limit) when the FE polls. The cache is
/// invalidated whenever a task is moved to "In Progress" via
/// [`work_on_clickup`] / [`work_on_ticket`].
pub async fn list_clickup(
    State(state): State<AppState>,
) -> Result<Json<Vec<TicketRow>>, (StatusCode, String)> {
    {
        let cache = state.clickup_cache.lock().await;
        if let Some((rows, at)) = cache.as_ref() {
            if at.elapsed() < CLICKUP_CACHE_TTL {
                return Ok(Json(rows.clone()));
            }
        }
    }
    let Some(tok) = load_token(&state, "clickup").await else {
        return Ok(Json(Vec::new()));
    };
    let filters = clickup_filters(&state).await;
    let rows = list_clickup_tasks(&tok, &filters).await;
    *state.clickup_cache.lock().await = Some((rows.clone(), std::time::Instant::now()));
    Ok(Json(rows))
}

/// Body for `POST /api/clickup/tasks/:task_id/work`.
#[derive(Debug, Deserialize)]
pub struct WorkOnClickUpBody {
    pub project_id: String,
}

/// `POST /api/clickup/tasks/:task_id/work` — create a worktree in the
/// chosen project for a ClickUp task.
///
/// ClickUp isn't repo-scoped, so the caller must pick which project the
/// worktree lands in. The worktree is created via the shared
/// [`worktrees::create`] flow; the provider mutation (assign + move to
/// "In Progress") is best-effort and never fatal.
pub async fn work_on_clickup(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    Json(body): Json<WorkOnClickUpBody>,
) -> Result<Json<WorktreeDto>, (StatusCode, String)> {
    let project = state
        .projects
        .get(&body.project_id)
        .await
        .map_err(|e| match e {
            agentgrove_store::ProjectError::NotFound(_) => (
                StatusCode::NOT_FOUND,
                format!("project {} not found", body.project_id),
            ),
            other => (StatusCode::INTERNAL_SERVER_ERROR, format!("db: {other}")),
        })?;

    let Some(tok) = load_token(&state, "clickup").await else {
        return Err((StatusCode::BAD_REQUEST, "clickup not connected".into()));
    };

    // Find the task so we can build a descriptive branch slug. Search
    // the whole workspace (no filters) — you can work on any task, not
    // only ones matching the saved filters.
    let title = list_clickup_tasks(&tok, &ClickUpFilters::default())
        .await
        .into_iter()
        .find(|t| t.id == task_id)
        .map(|t| t.title)
        .unwrap_or_default();

    let branch = format!("ticket/{}-{}", task_id, slugify(&title));

    let created = worktrees::create(
        State(state.clone()),
        Path(project.id.clone()),
        Json(CreateWorktreeBody {
            branch,
            base_ref: "HEAD".to_owned(),
            path: None,
            pre_script: None,
            post_script: None,
        }),
    )
    .await?;

    // Best-effort: assign to current user + move to "In Progress".
    clickup_start_task(&task_id, &tok).await;
    // The task just changed status; drop the cache so the next list
    // reflects it instead of showing it stale for up to the TTL.
    *state.clickup_cache.lock().await = None;

    Ok(created)
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
            github_start_issue(&project.root, &ticket_id).await;
        }
        "gitlab" => {
            gitlab_start_issue(&project.root, &ticket_id).await;
        }
        "clickup" => {
            if let Some(tok) = load_token(&state, "clickup").await {
                clickup_start_task(&ticket_id, &tok).await;
                *state.clickup_cache.lock().await = None;
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

// ---- GitHub (gh CLI) -----------------------------------------------------

/// List open GitHub issues via `gh issue list --json ...` in the
/// project's root dir. The `gh` CLI resolves the repo automatically from
/// the git remote.
async fn list_github_issues_cli(cwd: &FsPath) -> Vec<TicketRow> {
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        tokio::process::Command::new("gh")
            .args([
                "issue",
                "list",
                "--state",
                "open",
                "--json",
                "number,title,state,url,labels,assignees,author,createdAt,updatedAt",
                "--limit",
                "100",
            ])
            .current_dir(cwd)
            .output(),
    )
    .await;
    let stdout = match out {
        Ok(Ok(o)) if o.status.success() => o.stdout,
        Ok(Ok(o)) => {
            tracing::warn!(
                stderr = %String::from_utf8_lossy(&o.stderr),
                "gh issue list failed"
            );
            return Vec::new();
        }
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "gh not runnable");
            return Vec::new();
        }
        Err(_) => {
            tracing::warn!("gh issue list timed out after 15s");
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
                        .filter_map(|l| l.get("name").and_then(|v| v.as_str()).map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            TicketRow {
                provider: "github".into(),
                id: it
                    .get("number")
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
                    .unwrap_or("OPEN")
                    .to_string(),
                url: it
                    .get("url")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                labels,
                assignee: it
                    .get("assignees")
                    .and_then(|a| a.as_array())
                    .and_then(|arr| arr.first())
                    .and_then(|a| a.get("login"))
                    .and_then(|v| v.as_str())
                    .map(String::from),
                author: it
                    .get("author")
                    .and_then(|a| a.get("login"))
                    .and_then(|v| v.as_str())
                    .map(String::from),
                created_at: it
                    .get("createdAt")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                updated_at: it
                    .get("updatedAt")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                priority: None,
            }
        })
        .collect()
}

async fn github_start_issue(cwd: &FsPath, number: &str) {
    // Self-assign + move to an "in progress" label (best-effort). GitHub
    // issues have no native "In Progress" state; a label is the standard
    // convention.
    let out = tokio::process::Command::new("gh")
        .args([
            "issue",
            "edit",
            number,
            "--add-assignee",
            "@me",
            "--add-label",
            "in progress",
        ])
        .current_dir(cwd)
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => {}
        Ok(o) => {
            tracing::warn!(
                stderr = %String::from_utf8_lossy(&o.stderr),
                "gh issue edit failed"
            );
        }
        Err(e) => {
            tracing::warn!(error = %e, "gh not runnable for issue edit");
        }
    }
}

// ---- GitLab (glab CLI) ---------------------------------------------------

/// List open GitLab issues via `glab issue list -F json` in the
/// project's root dir.
async fn list_gitlab_issues(cwd: &FsPath) -> Vec<TicketRow> {
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        tokio::process::Command::new("glab")
            .args(["issue", "list", "-F", "json"])
            .current_dir(cwd)
            .output(),
    )
    .await;
    let stdout = match out {
        Ok(Ok(o)) if o.status.success() => o.stdout,
        Ok(Ok(o)) => {
            tracing::warn!(
                stderr = %String::from_utf8_lossy(&o.stderr),
                "glab issue list failed"
            );
            return Vec::new();
        }
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "glab not runnable");
            return Vec::new();
        }
        Err(_) => {
            tracing::warn!("glab issue list timed out after 15s");
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

/// Map a single ClickUp task JSON object into a [`TicketRow`].
fn map_clickup_task(it: &serde_json::Value) -> TicketRow {
    TicketRow {
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
    }
}

/// Resolve the first authorized team (workspace) id for `token`.
async fn clickup_team_id(client: &reqwest::Client, token: &str) -> Option<String> {
    let teams: serde_json::Value = match client
        .get("https://api.clickup.com/api/v2/team")
        .header(reqwest::header::AUTHORIZATION, token)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r.json().await.unwrap_or_default(),
        Ok(r) => {
            tracing::warn!(status = %r.status(), "clickup team list non-success");
            return None;
        }
        Err(e) => {
            tracing::warn!(error = %e, "clickup team list failed");
            return None;
        }
    };
    teams
        .get("teams")
        .and_then(|t| t.as_array())
        .and_then(|arr| arr.first())
        .and_then(|t| t.get("id"))
        .and_then(|v| v.as_str())
        .map(String::from)
}

/// True if a raw ClickUp task JSON passes the assignee + status filters.
/// Assignee matches when ANY of the task's assignees has the wanted id;
/// status matches (case-insensitive) any of the wanted statuses. An
/// empty filter clause matches everything.
fn clickup_task_matches(it: &serde_json::Value, f: &ClickUpFilters) -> bool {
    if !f.assignees.is_empty() {
        let hit = it
            .get("assignees")
            .and_then(|a| a.as_array())
            .is_some_and(|arr| {
                arr.iter().any(|a| {
                    a.get("id")
                        .map(|id| {
                            let as_str = id.as_i64().map(|n| n.to_string());
                            f.assignees.iter().any(|want| {
                                as_str.as_deref() == Some(want.as_str())
                                    || id.as_str() == Some(want.as_str())
                            })
                        })
                        .unwrap_or(false)
                })
            });
        if !hit {
            return false;
        }
    }
    if !f.statuses.is_empty() {
        let st = it
            .get("status")
            .and_then(|s| s.get("status"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !f.statuses.iter().any(|s| s.eq_ignore_ascii_case(&st)) {
            return false;
        }
    }
    true
}

/// List ClickUp tasks. When `filters.lists` is non-empty, fetch each
/// watched List directly (`GET /list/{id}/task`) and concatenate — this
/// avoids the documented single-List quirk of the team filter endpoint.
/// When empty, fall back to the whole-workspace team feed. Assignee and
/// status filters are applied client-side (they work identically in both
/// modes; the per-List endpoint has no assignee filter param).
/// Fetch every page of a ClickUp task endpoint. Both `/list/{id}/task`
/// and `/team/{id}/task` cap at 100 tasks/page and expose `?page=N`
/// (0-based) plus a `last_page` flag — without this, tasks past the
/// first 100 (e.g. older tickets) silently vanish from the feed.
/// `base` must already carry its query string; we append `&page=N`.
async fn clickup_fetch_all_pages(
    client: &reqwest::Client,
    token: &str,
    base: &str,
) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    // ponytail: hard 50-page (5000-task) safety cap so a bad last_page
    // flag can't loop forever; raise if a workspace ever exceeds it.
    for page in 0..50u32 {
        let url = format!("{base}&page={page}");
        let body: serde_json::Value = match client
            .get(&url)
            .header(reqwest::header::AUTHORIZATION, token)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r.json().await.unwrap_or_default(),
            Ok(r) => {
                tracing::warn!(url, status = %r.status(), "clickup task page non-success");
                break;
            }
            Err(e) => {
                tracing::warn!(url, error = %e, "clickup task page failed");
                break;
            }
        };
        let arr = body.get("tasks").and_then(|t| t.as_array());
        let count = arr.map_or(0, |a| a.len());
        if let Some(a) = arr {
            out.extend(a.iter().cloned());
        }
        // Stop on the flagged last page, or a short/empty page (defensive
        // when the flag is missing).
        if body.get("last_page").and_then(|v| v.as_bool()) == Some(true) || count < 100 {
            break;
        }
    }
    out
}

async fn list_clickup_tasks(token: &str, filters: &ClickUpFilters) -> Vec<TicketRow> {
    let client = reqwest::Client::new();

    let raw: Vec<serde_json::Value> = if !filters.lists.is_empty() {
        let mut acc = Vec::new();
        for list_id in &filters.lists {
            let base = format!(
                "https://api.clickup.com/api/v2/list/{list_id}/task?subtasks=true&include_closed=false"
            );
            acc.extend(clickup_fetch_all_pages(&client, token, &base).await);
        }
        acc
    } else {
        let Some(team_id) = clickup_team_id(&client, token).await else {
            return Vec::new();
        };
        let base = format!(
            "https://api.clickup.com/api/v2/team/{team_id}/task?subtasks=true&include_closed=false"
        );
        clickup_fetch_all_pages(&client, token, &base).await
    };

    raw.iter()
        .filter(|it| clickup_task_matches(it, filters))
        .map(map_clickup_task)
        .collect()
}

/// A pickable ClickUp List for the "watch these lists" settings picker.
#[derive(Debug, Clone, Serialize)]
pub struct ClickUpList {
    pub id: String,
    /// `Space / Folder / List` breadcrumb so the user can tell duplicates apart.
    pub path: String,
}

/// `GET /api/clickup/lists` — enumerate every List in the workspace as a
/// flat, breadcrumbed set the FE renders as checkboxes. Walks
/// team → spaces → (folders → lists) + folderless lists. Best-effort:
/// a failed sub-fetch is skipped, never fatal.
pub async fn list_clickup_lists(
    State(state): State<AppState>,
) -> Result<Json<Vec<ClickUpList>>, (StatusCode, String)> {
    {
        let cache = state.clickup_lists_cache.lock().await;
        if let Some((lists, at)) = cache.as_ref() {
            if at.elapsed() < CLICKUP_LISTS_CACHE_TTL {
                return Ok(Json(lists.clone()));
            }
        }
    }
    let Some(tok) = load_token(&state, "clickup").await else {
        return Ok(Json(Vec::new()));
    };
    let client = reqwest::Client::new();
    let Some(team_id) = clickup_team_id(&client, &tok).await else {
        return Ok(Json(Vec::new()));
    };

    async fn get_json(client: &reqwest::Client, token: &str, url: &str) -> serde_json::Value {
        match client
            .get(url)
            .header(reqwest::header::AUTHORIZATION, token)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r.json().await.unwrap_or_default(),
            _ => serde_json::Value::Null,
        }
    }

    let mut out = Vec::new();
    let spaces = get_json(
        &client,
        &tok,
        &format!("https://api.clickup.com/api/v2/team/{team_id}/space"),
    )
    .await;
    for space in spaces
        .get("spaces")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        let space_id = space.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        let space_name = space
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("Space");

        // Folderless lists.
        let fl = get_json(
            &client,
            &tok,
            &format!("https://api.clickup.com/api/v2/space/{space_id}/list"),
        )
        .await;
        for l in fl
            .get("lists")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
        {
            if let Some(id) = l.get("id").and_then(|v| v.as_str()) {
                let name = l.get("name").and_then(|v| v.as_str()).unwrap_or("List");
                out.push(ClickUpList {
                    id: id.into(),
                    path: format!("{space_name} / {name}"),
                });
            }
        }

        // Folders → lists.
        let folders = get_json(
            &client,
            &tok,
            &format!("https://api.clickup.com/api/v2/space/{space_id}/folder"),
        )
        .await;
        for f in folders
            .get("folders")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
        {
            let folder_name = f.get("name").and_then(|v| v.as_str()).unwrap_or("Folder");
            for l in f
                .get("lists")
                .and_then(|v| v.as_array())
                .into_iter()
                .flatten()
            {
                if let Some(id) = l.get("id").and_then(|v| v.as_str()) {
                    let name = l.get("name").and_then(|v| v.as_str()).unwrap_or("List");
                    out.push(ClickUpList {
                        id: id.into(),
                        path: format!("{space_name} / {folder_name} / {name}"),
                    });
                }
            }
        }
    }
    *state.clickup_lists_cache.lock().await = Some((out.clone(), std::time::Instant::now()));
    Ok(Json(out))
}

/// A pickable option for the assignee/status filters (member or status).
#[derive(Debug, Clone, Serialize)]
pub struct ClickUpOption {
    /// Stable value stored in the filter (member user id, or status name).
    pub value: String,
    /// Human label shown in the picker.
    pub label: String,
}

/// Deserialize a field that may be a bare string (legacy single
/// assignee), a list of strings, or null — always into a `Vec<String>`.
fn de_string_or_vec<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany {
        One(String),
        Many(Vec<String>),
        Null,
    }
    Ok(match OneOrMany::deserialize(d)? {
        OneOrMany::One(s) => vec![s],
        OneOrMany::Many(v) => v,
        OneOrMany::Null => Vec::new(),
    })
}

/// The ClickUp task-feed filters, persisted as JSON in the token row's
/// `scope` column. All-empty = the whole workspace, unfiltered.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ClickUpFilters {
    /// Watched List ids (empty = whole workspace).
    #[serde(default)]
    pub lists: Vec<String>,
    /// Assignee user ids to filter by (empty = any assignee). A task
    /// matches if ANY of its assignees is in this set.
    #[serde(default, alias = "assignee", deserialize_with = "de_string_or_vec")]
    pub assignees: Vec<String>,
    /// Status names to include (empty = any status).
    #[serde(default)]
    pub statuses: Vec<String>,
}

/// Read the persisted ClickUp filters from the token's `scope` column.
/// A malformed/absent value degrades to the default (unfiltered).
async fn clickup_filters(state: &AppState) -> ClickUpFilters {
    match state.integration_store.get_token("clickup").await {
        Ok(Some(tok)) => tok
            .scope
            .as_deref()
            .filter(|s| !s.is_empty())
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default(),
        _ => ClickUpFilters::default(),
    }
}

/// `GET /api/clickup/filters` — the persisted filter config.
pub async fn get_clickup_filters(State(state): State<AppState>) -> Json<ClickUpFilters> {
    Json(clickup_filters(&state).await)
}

/// `PUT /api/clickup/filters` — persist the filter config as JSON in the
/// `scope` column and drop the task cache so the next list reflects it.
pub async fn put_clickup_filters(
    State(state): State<AppState>,
    Json(body): Json<ClickUpFilters>,
) -> Result<StatusCode, (StatusCode, String)> {
    let Ok(Some(tok)) = state.integration_store.get_token("clickup").await else {
        return Err((StatusCode::BAD_REQUEST, "clickup not connected".into()));
    };
    // Normalize: drop blanks so an all-empty config stores as NULL scope.
    let filters = ClickUpFilters {
        lists: body
            .lists
            .into_iter()
            .filter(|s| !s.trim().is_empty())
            .collect(),
        assignees: body
            .assignees
            .into_iter()
            .filter(|s| !s.trim().is_empty())
            .collect(),
        statuses: body
            .statuses
            .into_iter()
            .filter(|s| !s.trim().is_empty())
            .collect(),
    };
    let is_empty =
        filters.lists.is_empty() && filters.assignees.is_empty() && filters.statuses.is_empty();
    let json = serde_json::to_string(&filters).unwrap_or_default();
    let scope = if is_empty { None } else { Some(json.as_str()) };
    state
        .integration_store
        .save_token(
            "clickup",
            &tok.access_token,
            tok.refresh_token.as_deref(),
            tok.token_type.as_deref(),
            scope,
            tok.user_name.as_deref(),
            tok.user_id.as_deref(),
            tok.expires_at,
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("save: {e}")))?;
    *state.clickup_cache.lock().await = None;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/clickup/members` — workspace members for the assignee
/// picker. Free from the `/team` response; cached on a long TTL.
pub async fn list_clickup_members(
    State(state): State<AppState>,
) -> Result<Json<Vec<ClickUpOption>>, (StatusCode, String)> {
    {
        let cache = state.clickup_members_cache.lock().await;
        if let Some((m, at)) = cache.as_ref() {
            if at.elapsed() < CLICKUP_META_CACHE_TTL {
                return Ok(Json(m.clone()));
            }
        }
    }
    let Some(tok) = load_token(&state, "clickup").await else {
        return Ok(Json(Vec::new()));
    };
    let client = reqwest::Client::new();
    let teams: serde_json::Value = match client
        .get("https://api.clickup.com/api/v2/team")
        .header(reqwest::header::AUTHORIZATION, &tok)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r.json().await.unwrap_or_default(),
        _ => return Ok(Json(Vec::new())),
    };
    let members = teams
        .get("teams")
        .and_then(|t| t.as_array())
        .and_then(|arr| arr.first())
        .and_then(|t| t.get("members"))
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let u = m.get("user")?;
                    let id = u
                        .get("id")
                        .and_then(|v| v.as_i64())
                        .map(|n| n.to_string())?;
                    let label = u
                        .get("username")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .or_else(|| u.get("email").and_then(|v| v.as_str()))
                        .unwrap_or(&id)
                        .to_string();
                    Some(ClickUpOption { value: id, label })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    *state.clickup_members_cache.lock().await = Some((members.clone(), std::time::Instant::now()));
    Ok(Json(members))
}

/// `GET /api/clickup/statuses` — the distinct status names that tasks can
/// actually carry, for the status filter picker. Lists/folders can
/// override the space's statuses (`override_statuses`), so a space-only
/// walk misses names like `d3-ready` that tasks really use. We union
/// statuses at every level: space → folders → lists + folderless lists.
/// Extra calls, cached on a long TTL.
pub async fn list_clickup_statuses(
    State(state): State<AppState>,
) -> Result<Json<Vec<ClickUpOption>>, (StatusCode, String)> {
    {
        let cache = state.clickup_statuses_cache.lock().await;
        if let Some((s, at)) = cache.as_ref() {
            if at.elapsed() < CLICKUP_META_CACHE_TTL {
                return Ok(Json(s.clone()));
            }
        }
    }
    let Some(tok) = load_token(&state, "clickup").await else {
        return Ok(Json(Vec::new()));
    };
    let client = reqwest::Client::new();
    let Some(team_id) = clickup_team_id(&client, &tok).await else {
        return Ok(Json(Vec::new()));
    };

    async fn get_json(client: &reqwest::Client, token: &str, url: &str) -> serde_json::Value {
        match client
            .get(url)
            .header(reqwest::header::AUTHORIZATION, token)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r.json().await.unwrap_or_default(),
            _ => serde_json::Value::Null,
        }
    }

    // De-dupe case-insensitively; first spelling wins for the label.
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    let mut add_statuses = |node: &serde_json::Value| {
        for s in node
            .get("statuses")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
        {
            if let Some(name) = s.get("status").and_then(|v| v.as_str()) {
                if seen.insert(name.to_ascii_lowercase()) {
                    out.push(ClickUpOption {
                        value: name.to_string(),
                        label: name.to_string(),
                    });
                }
            }
        }
    };

    let spaces = get_json(
        &client,
        &tok,
        &format!("https://api.clickup.com/api/v2/team/{team_id}/space"),
    )
    .await;
    for space in spaces
        .get("spaces")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        add_statuses(space);
        let space_id = space.get("id").and_then(|v| v.as_str()).unwrap_or_default();

        // Folderless lists carry their own (possibly overridden) statuses.
        let fl = get_json(
            &client,
            &tok,
            &format!("https://api.clickup.com/api/v2/space/{space_id}/list"),
        )
        .await;
        for l in fl
            .get("lists")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
        {
            add_statuses(l);
        }

        // Folders → their lists.
        let folders = get_json(
            &client,
            &tok,
            &format!("https://api.clickup.com/api/v2/space/{space_id}/folder"),
        )
        .await;
        for f in folders
            .get("folders")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
        {
            add_statuses(f);
            for l in f
                .get("lists")
                .and_then(|v| v.as_array())
                .into_iter()
                .flatten()
            {
                add_statuses(l);
            }
        }
    }
    *state.clickup_statuses_cache.lock().await = Some((out.clone(), std::time::Instant::now()));
    Ok(Json(out))
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
    fn slugify_makes_branch_safe() {
        assert_eq!(slugify("Fix the Login Bug!"), "fix-the-login-bug");
        assert_eq!(slugify("  Spaces   & symbols  "), "spaces-symbols");
        assert!(slugify(&"a".repeat(100)).len() <= 40);
    }
}
