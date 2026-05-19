//! `/api/projects/:id/worktrees` routes.

use crate::state::AppState;
use agentgrove_git as git;
use agentgrove_scripts::{run_script, ScriptEvent, Shell};
use agentgrove_store::{NewWorktree, WorktreeError, WorktreeRecord, WorktreeStatus};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::mpsc;

#[derive(Debug, Deserialize)]
pub struct CreateWorktreeBody {
    pub branch: String,
    #[serde(default = "default_base_ref")]
    pub base_ref: String,
    /// Optional explicit path; default = `<state_dir>/worktrees/<project_id>/<branch>`.
    pub path: Option<String>,
    pub pre_script: Option<String>,
    pub post_script: Option<String>,
}

fn default_base_ref() -> String {
    "HEAD".into()
}

#[derive(Debug, Serialize)]
pub struct WorktreeDto {
    pub id: String,
    pub project_id: String,
    pub branch: String,
    pub base_ref: String,
    pub path: String,
    pub status: String,
    pub pre_script: Option<String>,
    pub post_script: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl From<WorktreeRecord> for WorktreeDto {
    fn from(r: WorktreeRecord) -> Self {
        let status = match r.status {
            WorktreeStatus::Creating => "creating",
            WorktreeStatus::PreScript => "pre_script",
            WorktreeStatus::Ready => "ready",
            WorktreeStatus::Removing => "removing",
            WorktreeStatus::Failed => "failed",
        }
        .to_string();
        Self {
            id: r.id,
            project_id: r.project_id,
            branch: r.branch,
            base_ref: r.base_ref,
            path: r.path.to_string_lossy().into_owned(),
            status,
            pre_script: r.pre_script,
            post_script: r.post_script,
            created_at: r.created_at.to_rfc3339(),
            updated_at: r.updated_at.to_rfc3339(),
        }
    }
}

fn map_wt_err(e: WorktreeError) -> (StatusCode, String) {
    use WorktreeError::*;
    match e {
        EmptyBranch => (StatusCode::BAD_REQUEST, "branch is empty".into()),
        EmptyBaseRef => (StatusCode::BAD_REQUEST, "base_ref is empty".into()),
        RelativePath(p) => (
            StatusCode::BAD_REQUEST,
            format!("path must be absolute: {}", p.display()),
        ),
        DuplicatePath(p) => (
            StatusCode::CONFLICT,
            format!("worktree at {} already exists", p.display()),
        ),
        NotFound(id) => (StatusCode::NOT_FOUND, format!("worktree {id} not found")),
        Db(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("db: {e}")),
    }
}

pub async fn list_for_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<Vec<WorktreeDto>>, (StatusCode, String)> {
    // Ensure project exists.
    state.projects.get(&project_id).await.map_err(|e| match e {
        agentgrove_store::ProjectError::NotFound(_) => (
            StatusCode::NOT_FOUND,
            format!("project {project_id} not found"),
        ),
        other => (StatusCode::INTERNAL_SERVER_ERROR, format!("db: {other}")),
    })?;
    let all = state
        .worktrees
        .list_for_project(&project_id)
        .await
        .map_err(map_wt_err)?;
    Ok(Json(all.into_iter().map(Into::into).collect()))
}

pub async fn create(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(body): Json<CreateWorktreeBody>,
) -> Result<Json<WorktreeDto>, (StatusCode, String)> {
    let project = state.projects.get(&project_id).await.map_err(|e| match e {
        agentgrove_store::ProjectError::NotFound(_) => (
            StatusCode::NOT_FOUND,
            format!("project {project_id} not found"),
        ),
        other => (StatusCode::INTERNAL_SERVER_ERROR, format!("db: {other}")),
    })?;

    let safe_branch = sanitize_branch(&body.branch);
    let wt_path = match body.path {
        Some(p) => PathBuf::from(p),
        None => state
            .state_dir
            .join("worktrees")
            .join(&project_id)
            .join(&safe_branch),
    };

    // Insert metadata row first so we can stream logs against it.
    let record = state
        .worktrees
        .create(NewWorktree {
            project_id: project_id.clone(),
            branch: body.branch.clone(),
            base_ref: body.base_ref.clone(),
            path: wt_path.clone(),
            pre_script: body.pre_script.clone(),
            post_script: body.post_script.clone(),
        })
        .await
        .map_err(map_wt_err)?;

    let topic = format!("worktree:{}:script", record.id);

    // git worktree add
    if let Err(e) = git::add_worktree(&project.root, &wt_path, &body.branch, &body.base_ref).await {
        let _ = state
            .worktrees
            .set_status(&record.id, WorktreeStatus::Failed)
            .await;
        let msg = format!("git worktree add failed: {e}");
        state.logbus.publish(
            &topic,
            serde_json::json!({"type":"stderr","line": msg}).to_string(),
        );
        state.logbus.publish(
            &topic,
            serde_json::json!({"type":"exit","code": -1}).to_string(),
        );
        return Err((StatusCode::BAD_REQUEST, msg));
    }

    // Pre-script
    if let Some(script) = &body.pre_script {
        let _ = state
            .worktrees
            .set_status(&record.id, WorktreeStatus::PreScript)
            .await;
        let (tx, mut rx) = mpsc::unbounded_channel::<ScriptEvent>();
        let bus = state.logbus.clone();
        let topic_c = topic.clone();
        tokio::spawn(async move {
            while let Some(ev) = rx.recv().await {
                bus.publish(&topic_c, serde_json::to_string(&ev).unwrap_or_default());
            }
        });
        let res = run_script(script, &wt_path, &Shell::Auto, Duration::from_secs(120), tx).await;
        match res {
            Ok(0) => {}
            Ok(code) => {
                let _ = state
                    .worktrees
                    .set_status(&record.id, WorktreeStatus::Failed)
                    .await;
                return Err((StatusCode::BAD_REQUEST, format!("pre-script exited {code}")));
            }
            Err(e) => {
                let _ = state
                    .worktrees
                    .set_status(&record.id, WorktreeStatus::Failed)
                    .await;
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("pre-script error: {e}"),
                ));
            }
        }
    }

    let _ = state
        .worktrees
        .set_status(&record.id, WorktreeStatus::Ready)
        .await;
    let fresh = state.worktrees.get(&record.id).await.map_err(map_wt_err)?;
    Ok(Json(fresh.into()))
}

pub async fn delete(
    State(state): State<AppState>,
    Path((project_id, worktree_id)): Path<(String, String)>,
) -> Result<StatusCode, (StatusCode, String)> {
    let project = state
        .projects
        .get(&project_id)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "project not found".into()))?;
    let wt = state
        .worktrees
        .get(&worktree_id)
        .await
        .map_err(map_wt_err)?;
    if wt.project_id != project_id {
        return Err((StatusCode::BAD_REQUEST, "worktree not in project".into()));
    }

    // Post-script first (best effort).
    if let Some(script) = wt.post_script.as_deref() {
        let topic = format!("worktree:{}:script", wt.id);
        let (tx, mut rx) = mpsc::unbounded_channel::<ScriptEvent>();
        let bus = state.logbus.clone();
        let topic_c = topic.clone();
        tokio::spawn(async move {
            while let Some(ev) = rx.recv().await {
                bus.publish(&topic_c, serde_json::to_string(&ev).unwrap_or_default());
            }
        });
        let _ = run_script(script, &wt.path, &Shell::Auto, Duration::from_secs(120), tx).await;
    }

    let _ = state
        .worktrees
        .set_status(&worktree_id, WorktreeStatus::Removing)
        .await;
    if let Err(e) = git::remove_worktree(&project.root, &wt.path).await {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("git worktree remove failed: {e}"),
        ));
    }
    state
        .worktrees
        .delete(&worktree_id)
        .await
        .map_err(map_wt_err)?;
    Ok(StatusCode::NO_CONTENT)
}

fn sanitize_branch(branch: &str) -> String {
    branch
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | ' ' => '-',
            c => c,
        })
        .collect()
}
