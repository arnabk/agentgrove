//! `/api/projects` routes.

use crate::state::AppState;
use agentgrove_git::inspect_repo;
use agentgrove_store::{NewProject, ProjectError, ProjectRecord};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct CreateProjectBody {
    /// Optional. When omitted, the basename of `root` is used.
    #[serde(default)]
    pub name: Option<String>,
    pub root: String,
}

#[derive(Debug, Serialize)]
pub struct ProjectDto {
    pub id: String,
    pub name: String,
    pub root: String,
    pub created_at: String,
    pub updated_at: String,
    /// Folder is a git repository.
    pub is_git: bool,
    /// Folder is git AND has at least one remote configured.
    pub has_remote: bool,
    /// Current branch name (when discoverable).
    pub current_branch: Option<String>,
    /// Configured git remote names.
    pub remotes: Vec<String>,
    /// Project-level pre-worktree script. Inherited by every new
    /// worktree of this project (unless the create call supplies an
    /// explicit override).
    pub pre_worktree_script: Option<String>,
}

async fn record_to_dto(r: ProjectRecord) -> ProjectDto {
    let info = inspect_repo(&r.root).await;
    ProjectDto {
        id: r.id,
        name: r.name,
        root: r.root.to_string_lossy().into_owned(),
        created_at: r.created_at.to_rfc3339(),
        updated_at: r.updated_at.to_rfc3339(),
        is_git: info.is_git,
        has_remote: info.has_remote,
        current_branch: info.current_branch,
        remotes: info.remotes,
        pre_worktree_script: r.pre_worktree_script,
    }
}

fn map_err(e: ProjectError) -> (StatusCode, String) {
    use ProjectError::*;
    match e {
        EmptyName => (StatusCode::BAD_REQUEST, "name is empty".into()),
        RelativeRoot(p) => (
            StatusCode::BAD_REQUEST,
            format!("root must be absolute: {}", p.display()),
        ),
        DuplicateRoot(p) => (
            StatusCode::CONFLICT,
            format!("project at {} already exists", p.display()),
        ),
        NotFound(id) => (StatusCode::NOT_FOUND, format!("project {id} not found")),
        Db(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("db: {e}")),
    }
}

pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<CreateProjectBody>,
) -> Result<Json<ProjectDto>, (StatusCode, String)> {
    let root = std::path::PathBuf::from(&body.root);
    if !root.exists() {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("path does not exist: {}", root.display()),
        ));
    }
    let name = body
        .name
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            root.file_name()
                .map(|os| os.to_string_lossy().into_owned())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| root.to_string_lossy().into_owned());
    let rec = state
        .projects
        .create(NewProject { name, root })
        .await
        .map_err(map_err)?;
    let dto = record_to_dto(rec).await;
    // Cross-instance sync: the LeftRail in every connected
    // browser refreshes its project list when a `project_created`
    // event lands. The payload carries only the id so other
    // clients pull the canonical record themselves.
    state.logbus.publish(
        "sync",
        serde_json::json!({
            "kind": "project_created",
            "project_id": dto.id,
        })
        .to_string(),
    );
    Ok(Json(dto))
}

pub async fn list(
    State(state): State<AppState>,
) -> Result<Json<Vec<ProjectDto>>, (StatusCode, String)> {
    let all = state.projects.list().await.map_err(map_err)?;
    let mut out = Vec::with_capacity(all.len());
    for r in all {
        out.push(record_to_dto(r).await);
    }
    Ok(Json(out))
}

pub async fn get_one(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ProjectDto>, (StatusCode, String)> {
    let rec = state.projects.get(&id).await.map_err(map_err)?;
    Ok(Json(record_to_dto(rec).await))
}

pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    // Cascade related state BEFORE deleting the project row so a
    // mid-cascade crash leaves the project visible (rather than a
    // dangling worktree / chat under a project that no longer
    // exists). Each step is best-effort: a failure logs but
    // doesn't abort. The project row is the last thing to go;
    // its disappearance is what flips the FE to "deleted".

    // Drop the file index for this project (cheap; in-memory).
    state.file_index.forget(&id).await;

    // Hard-delete any chats that lived under this project. The
    // chat row has no FK on project_id (see migration 0005); we
    // own cleanup here. ChatRepo also takes care of cascading
    // prompts via its own SQL.
    if let Ok(chats) = state.chat_store.list_for_project(&id).await {
        for c in chats {
            let _ = state.chat_store.delete(&c.id).await;
        }
    }

    // Drop in-memory chat aggregates pointing at this project
    // (the store delete is the source of truth, but the registry
    // is what the WS broadcasts off of).
    {
        let mut reg = state.chats.write().await;
        reg.retain_chats(|c| c.project_id != id);
    }

    // Hard-delete worktrees (soft-delete leaves orphans pointing
    // at a removed project — surfaced in WorktreeHistoryDialog).
    if let Ok(wts) = state.worktrees.list_for_project(&id).await {
        for w in wts {
            let _ = state.worktrees.hard_delete(&w.id).await;
        }
    }

    // Forget the layout blob for any scope rooted at this project.
    let _ = state.layouts.delete_for_project(&id).await;

    let removed = state.projects.delete(&id).await.map_err(map_err)?;
    if !removed {
        return Err((StatusCode::NOT_FOUND, format!("project {id} not found")));
    }
    // Cross-instance sync: tabs pinning this project drop it from
    // their LeftRail + flip back to a sibling. Tabs unrelated to
    // the project ignore the message.
    state.logbus.publish(
        "sync",
        serde_json::json!({
            "kind": "project_deleted",
            "project_id": id,
        })
        .to_string(),
    );
    Ok(StatusCode::NO_CONTENT)
}

/// PATCH a project. Currently only updates the pre-worktree script;
/// the partial-update shape is intentional so callers won't have to
/// migrate as we add more mutable fields.
pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(raw): Json<serde_json::Value>,
) -> Result<Json<ProjectDto>, (StatusCode, String)> {
    // Ensure the project exists up front so a no-op patch still 404s
    // on a bogus id (matches the symmetric behaviour of GET).
    let current = state.projects.get(&id).await.map_err(map_err)?;

    // Hand-parse so we can distinguish "field absent" from "field set
    // to empty string". `serde_json::Value::get(key)` returns `None`
    // only when the key is missing.
    let obj = raw.as_object();
    let mut record = current;
    if let Some(map) = obj {
        if let Some(v) = map.get("pre_worktree_script") {
            // Accept either a string (set/clear) or `null` (clear).
            let new_value: Option<&str> = match v {
                serde_json::Value::Null => None,
                serde_json::Value::String(s) => Some(s.as_str()),
                _ => {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        "pre_worktree_script must be a string or null".into(),
                    ));
                }
            };
            record = state
                .projects
                .update_pre_worktree_script(&id, new_value)
                .await
                .map_err(map_err)?;
        }
    }
    let dto = record_to_dto(record).await;
    // Cross-instance sync: project metadata changed (name,
    // pre_worktree_script, etc.). Other tabs refresh their copy
    // so the ProjectSettingsDialog + the rail row label stay
    // consistent.
    state.logbus.publish(
        "sync",
        serde_json::json!({
            "kind": "project_updated",
            "project_id": dto.id,
        })
        .to_string(),
    );
    Ok(Json(dto))
}
