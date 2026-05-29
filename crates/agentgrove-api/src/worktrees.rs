//! `/api/projects/:id/worktrees` routes.

use crate::state::AppState;
use agentgrove_git as git;
use agentgrove_scripts::{run_script, run_script_with_env, ScriptEvent, Shell};
use agentgrove_store::{NewWorktree, WorktreeError, WorktreeRecord, WorktreeStatus};
use axum::{
    extract::{Path, Query, State},
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
    /// ISO timestamp when the worktree was soft-deleted, or `None` if
    /// still live. Present so the history view can show "removed at".
    pub removed_at: Option<String>,
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
            removed_at: r.removed_at.map(|t| t.to_rfc3339()),
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

    // Worktree creation requires a git remote — the freshness
    // guarantee ("always create from origin/<base_ref>") only
    // works if there's an origin to talk to. Local-only repos can
    // still use the editor, terminal, chat, etc.; worktrees are
    // an opt-in feature gated on `has_remote` (also enforced by
    // the FE LeftRail which hides the +worktree button without a
    // remote). Surface a 400 here rather than letting the task
    // silently degrade to a stale local ref.
    let repo_info = git::inspect_repo(&project.root).await;
    if !repo_info.has_remote {
        return Err((
            StatusCode::BAD_REQUEST,
            "project has no git remote — worktree creation requires a remote (add one with `git remote add origin <url>`)".into(),
        ));
    }

    let safe_branch = sanitize_branch(&body.branch);
    let wt_path = match body.path {
        Some(p) => PathBuf::from(p),
        None => state
            .state_dir
            .join("worktrees")
            .join(&project_id)
            .join(&safe_branch),
    };

    // Resolve the effective pre-script. Project setting wins as the
    // default; the per-worktree dialog override (if any) takes
    // precedence so power-users can still run a one-off command for
    // a specific branch (e.g. trying a different package manager).
    // Whitespace-only overrides collapse to "use the project default"
    // — matches the FE convention where leaving the field blank means
    // "inherit".
    let effective_pre_script: Option<String> = body
        .pre_script
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| project.pre_worktree_script.clone());

    // Insert metadata row first so we have an id to stream logs
    // against. The status is `creating` for the FE to render.
    let record = state
        .worktrees
        .create(NewWorktree {
            project_id: project_id.clone(),
            branch: body.branch.clone(),
            base_ref: body.base_ref.clone(),
            path: wt_path.clone(),
            pre_script: effective_pre_script.clone(),
            post_script: body.post_script.clone(),
        })
        .await
        .map_err(map_wt_err)?;

    // Hand the actual git+script work to a background task so the
    // HTTP response can return the row id immediately. The FE
    // subscribes to `worktree:{id}:script` for live output (LogBus
    // history replays the prefix so the FE never misses events even
    // if its WS connects a few ms late).
    let topic = format!("worktree:{}:script", record.id);
    let dto: WorktreeDto = record.clone().into();
    let state_for_task = state.clone();
    let pre_script = effective_pre_script.clone();
    let branch = body.branch.clone();
    let base_ref = body.base_ref.clone();
    let wt_id = record.id.clone();
    let project_root = project.root.clone();
    // Capture project_id by value into the task; the sync
    // publishes below clone it again so each json! macro gets a
    // String it can move into the Value tree.
    let project_id_for_task = project_id.clone();
    let wt_path_for_task = wt_path.clone();
    let topic_for_task = topic.clone();
    tokio::spawn(async move {
        // Step 1: fetch the latest of `base_ref` from `origin`.
        // The remote was validated at request time, so any failure
        // here is a hard error (network down, branch deleted
        // upstream, auth missing, …). We do NOT silently fall back
        // to a stale local ref — that defeats the freshness
        // guarantee the user expects from "create new worktree".
        state_for_task.logbus.publish(
            &topic_for_task,
            serde_json::json!({"type":"stage","stage":"git_fetch"}).to_string(),
        );
        if let Err(e) = git::fetch_ref(&project_root, &base_ref).await {
            let _ = state_for_task
                .worktrees
                .set_status(&wt_id, WorktreeStatus::Failed)
                .await;
            state_for_task.logbus.publish(
                "sync",
                serde_json::json!({
                    "kind": "worktree_updated",
                    "worktree_id": wt_id,
                    "project_id": project_id_for_task,
                })
                .to_string(),
            );
            state_for_task.logbus.publish(
                &topic_for_task,
                serde_json::json!({
                    "type":"stderr",
                    "line": format!("git fetch origin {base_ref} failed: {e}")
                })
                .to_string(),
            );
            state_for_task.logbus.publish(
                &topic_for_task,
                serde_json::json!({"type":"exit","code": -1}).to_string(),
            );
            return;
        }
        state_for_task.logbus.publish(
            &topic_for_task,
            serde_json::json!({"type":"stage","stage":"git_fetch_done"}).to_string(),
        );

        // Step 2: worktree-add against `origin/<base_ref>` (NOT
        // the local ref). After the fetch above this is the
        // freshest commit on that branch; passing the remote-
        // qualified ref is what makes "always create from remote"
        // actually mean what it says, even if a local copy of the
        // branch happens to be lagging.
        let remote_ref = format!("origin/{base_ref}");
        state_for_task.logbus.publish(
            &topic_for_task,
            serde_json::json!({"type":"stage","stage":"git_add"}).to_string(),
        );
        if let Err(e) =
            git::add_worktree(&project_root, &wt_path_for_task, &branch, &remote_ref).await
        {
            let _ = state_for_task
                .worktrees
                .set_status(&wt_id, WorktreeStatus::Failed)
                .await;
            state_for_task.logbus.publish(
                "sync",
                serde_json::json!({
                    "kind": "worktree_updated",
                    "worktree_id": wt_id,
                    "project_id": project_id_for_task,
                })
                .to_string(),
            );
            state_for_task.logbus.publish(
                &topic_for_task,
                serde_json::json!({"type":"stderr","line": format!("git worktree add failed: {e}")})
                    .to_string(),
            );
            state_for_task.logbus.publish(
                &topic_for_task,
                serde_json::json!({"type":"exit","code": -1}).to_string(),
            );
            return;
        }
        state_for_task.logbus.publish(
            &topic_for_task,
            serde_json::json!({"type":"stage","stage":"git_add_done"}).to_string(),
        );

        if let Some(script) = pre_script {
            let _ = state_for_task
                .worktrees
                .set_status(&wt_id, WorktreeStatus::PreScript)
                .await;
            state_for_task.logbus.publish(
                &topic_for_task,
                serde_json::json!({"type":"stage","stage":"pre_script"}).to_string(),
            );
            let (tx, mut rx) = mpsc::unbounded_channel::<ScriptEvent>();
            let bus = state_for_task.logbus.clone();
            let topic_relay = topic_for_task.clone();
            tokio::spawn(async move {
                while let Some(ev) = rx.recv().await {
                    bus.publish(&topic_relay, serde_json::to_string(&ev).unwrap_or_default());
                }
            });
            // Inject context envs so scripts can reference the
            // user's project root without guessing where the worktree
            // dir lives on disk. `cp $AGENTGROVE_PROJECT_ROOT/.env.local .`
            // is the canonical idiom.
            let envs: &[(&str, &std::path::Path)] = &[
                ("AGENTGROVE_PROJECT_ROOT", project_root.as_path()),
                ("AGENTGROVE_WORKTREE_PATH", wt_path_for_task.as_path()),
            ];
            let res = run_script_with_env(
                &script,
                &wt_path_for_task,
                &Shell::Auto,
                Duration::from_secs(120),
                envs,
                tx,
            )
            .await;
            match res {
                Ok(0) => {}
                Ok(code) => {
                    let _ = state_for_task
                        .worktrees
                        .set_status(&wt_id, WorktreeStatus::Failed)
                        .await;
                    state_for_task.logbus.publish(
                        "sync",
                        serde_json::json!({
                            "kind": "worktree_updated",
                            "worktree_id": wt_id,
                            "project_id": project_id_for_task,
                        })
                        .to_string(),
                    );
                    state_for_task.logbus.publish(
                        &topic_for_task,
                        serde_json::json!({"type":"stderr","line": format!("pre-script exited {code}")})
                            .to_string(),
                    );
                    state_for_task.logbus.publish(
                        &topic_for_task,
                        serde_json::json!({"type":"exit","code": code}).to_string(),
                    );
                    return;
                }
                Err(e) => {
                    let _ = state_for_task
                        .worktrees
                        .set_status(&wt_id, WorktreeStatus::Failed)
                        .await;
                    state_for_task.logbus.publish(
                        "sync",
                        serde_json::json!({
                            "kind": "worktree_updated",
                            "worktree_id": wt_id,
                            "project_id": project_id_for_task,
                        })
                        .to_string(),
                    );
                    state_for_task.logbus.publish(
                        &topic_for_task,
                        serde_json::json!({"type":"stderr","line": format!("pre-script error: {e}")})
                            .to_string(),
                    );
                    state_for_task.logbus.publish(
                        &topic_for_task,
                        serde_json::json!({"type":"exit","code": -1}).to_string(),
                    );
                    return;
                }
            }
        }

        let _ = state_for_task
            .worktrees
            .set_status(&wt_id, WorktreeStatus::Ready)
            .await;
        state_for_task.logbus.publish(
            &topic_for_task,
            serde_json::json!({"type":"stage","stage":"ready"}).to_string(),
        );
        // Cross-instance sync: tell other tabs the worktree is
        // ready so their LeftRail row stops showing the pending
        // chrome + a new chat can be created against it.
        state_for_task.logbus.publish(
            "sync",
            serde_json::json!({
                "kind": "worktree_updated",
                "worktree_id": wt_id,
                "project_id": project_id_for_task,
            })
            .to_string(),
        );
    });

    // Cross-instance sync on initial response: the row exists in
    // status=creating; other tabs render it with the pending
    // chrome until the ready broadcast above arrives.
    state.logbus.publish(
        "sync",
        serde_json::json!({
            "kind": "worktree_created",
            "worktree_id": dto.id,
            "project_id": dto.project_id,
        })
        .to_string(),
    );
    Ok(Json(dto))
}

/// Query params accepted by `DELETE /api/projects/:id/worktrees/:wid`.
///
/// `delete_branch=true` extends the remove flow to also drop the local
/// branch (`git branch -D <branch>`) after the worktree directory is
/// removed. This is the "single shot" UX option requested by the
/// product: the user no longer has to follow the worktree removal
/// with a manual branch cleanup. Default is `false` so existing
/// callers keep their current semantics.
#[derive(Debug, Deserialize, Default)]
pub struct DeleteQuery {
    #[serde(default)]
    pub delete_branch: bool,
}

pub async fn delete(
    State(state): State<AppState>,
    Path((project_id, worktree_id)): Path<(String, String)>,
    Query(q): Query<DeleteQuery>,
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
        // Tolerant case 1: the on-disk directory is gone (user
        // deleted by hand, prior crash mid-remove, …). git
        // `worktree remove` returns "not a working tree" or
        // similar — we treat that as "already removed" and
        // continue to the metadata cleanup so the row doesn't
        // stay stuck in `removing` forever. We still try
        // `git worktree prune` to clear any dangling
        // administrative state under <repo>/.git/worktrees/.
        let wt_path_missing = !wt.path.exists();
        let stderr = e.to_string().to_lowercase();
        let already_gone = wt_path_missing
            || stderr.contains("not a working tree")
            || stderr.contains("does not exist");
        if !already_gone {
            // Real failure: roll the status back to ready so the
            // FE doesn't keep showing "removing" + the user can
            // retry. Surfacing the original error message tells
            // them what to fix.
            let _ = state
                .worktrees
                .set_status(&worktree_id, WorktreeStatus::Ready)
                .await;
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("git worktree remove failed: {e}"),
            ));
        }
        // Best-effort prune to clear stale administrative state.
        let _ = git::prune_worktrees(&project.root).await;
    }

    // Optional follow-up: drop the local branch in the same call so
    // the user doesn't need a second action. We deliberately run this
    // AFTER `git worktree remove` — git refuses to delete a branch
    // that's still checked out by any worktree. Failure here does NOT
    // roll back the worktree removal: the worktree is gone either way,
    // and surfacing the branch-delete error gives the user a clear
    // signal of what (if anything) is left to clean up manually.
    if q.delete_branch {
        if let Err(e) = git::delete_branch(&project.root, &wt.branch).await {
            // Mark the metadata row deleted first so the UI doesn't
            // keep showing a stale "removing" entry indefinitely.
            let _ = state.worktrees.delete(&worktree_id).await;
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("worktree removed, but git branch -D failed: {e}"),
            ));
        }
    }

    state
        .worktrees
        .delete(&worktree_id)
        .await
        .map_err(map_wt_err)?;
    // Cross-instance sync: tabs in other browser instances drop
    // the row from their LeftRail.
    state.logbus.publish(
        "sync",
        serde_json::json!({
            "kind": "worktree_deleted",
            "worktree_id": worktree_id,
            "project_id": project_id,
        })
        .to_string(),
    );
    Ok(StatusCode::NO_CONTENT)
}

/// Body for `PATCH /api/projects/:id/worktrees/:wid`.
///
/// Only `branch` is supported today — that's the rename operation. The
/// struct is shaped as a partial-update map so we can grow it (e.g.
/// pre-script edits, post-script edits) without breaking older
/// clients.
#[derive(Debug, Deserialize)]
pub struct UpdateWorktreeBody {
    /// New branch name. When present and different from the current
    /// branch, the worktree's branch is renamed both in git and in
    /// our metadata row.
    pub branch: Option<String>,
}

/// Rename a worktree's branch (and update the stored metadata row).
///
/// Per the product decision the on-disk worktree directory is NOT
/// moved — only the branch label changes. This keeps the path stable
/// across renames and avoids the failure modes of `git worktree move`
/// (which refuses if the directory is busy / has unstaged changes).
///
/// 409 is returned when the new name collides with any live or
/// soft-deleted worktree's branch — mirroring the suggester logic the
/// FE already uses on creation. The FE can react by showing the
/// `Suggest` button next to the rename input.
pub async fn update(
    State(state): State<AppState>,
    Path((project_id, worktree_id)): Path<(String, String)>,
    Json(body): Json<UpdateWorktreeBody>,
) -> Result<Json<WorktreeDto>, (StatusCode, String)> {
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

    let Some(raw) = body.branch.as_deref() else {
        // No-op patch — return the current row unchanged. This is
        // benign and saves clients from having to special-case empty
        // payloads.
        return Ok(Json(wt.into()));
    };
    let new_branch = raw.trim().to_owned();
    if new_branch.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "branch must not be empty".into()));
    }
    if new_branch == wt.branch {
        // Idempotent no-op.
        return Ok(Json(wt.into()));
    }

    // Collision check — live worktrees in this project + soft-deleted
    // rows everywhere (because restoring a history entry would clash
    // with a re-used name). We don't have to scan git's branch list
    // separately: any branch git knows about would have come from one
    // of our rows, OR was created outside AgentGrove — in which case
    // `git branch -m` will refuse below and we'll surface that as a
    // 409 too.
    let live = state
        .worktrees
        .list_for_project(&project_id)
        .await
        .map_err(map_wt_err)?;
    let history = state
        .worktrees
        .list_removed_all()
        .await
        .map_err(map_wt_err)?;
    if live
        .iter()
        .any(|w| w.id != worktree_id && w.branch == new_branch)
        || history.iter().any(|w| w.branch == new_branch)
    {
        return Err((
            StatusCode::CONFLICT,
            format!("a worktree on '{new_branch}' already exists"),
        ));
    }

    // Rename in git first — if git refuses (e.g. the branch name
    // contains a reserved character, or git knows of a collision we
    // didn't catch above), we want to fail BEFORE mutating our row.
    if let Err(e) = git::rename_branch(&project.root, &wt.branch, &new_branch).await {
        // Most failures from `git branch -m` indicate a name conflict
        // (existing branch). Map those to 409; leave the rest as 500.
        let status = if matches!(&e, git::GitError::NonZero { stderr, .. } if stderr.contains("already exists"))
        {
            StatusCode::CONFLICT
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        };
        return Err((status, format!("git branch -m failed: {e}")));
    }

    let updated = state
        .worktrees
        .rename(&worktree_id, &new_branch)
        .await
        .map_err(map_wt_err)?;
    let dto: WorktreeDto = updated.into();
    // Cross-instance sync: branch label changed.
    state.logbus.publish(
        "sync",
        serde_json::json!({
            "kind": "worktree_updated",
            "worktree_id": dto.id,
            "project_id": dto.project_id,
        })
        .to_string(),
    );
    Ok(Json(dto))
}

/// Query params for `GET /api/worktrees/history`.
#[derive(Debug, Deserialize)]
pub struct HistoryQuery {
    /// Optional substring filter against branch name (case-insensitive).
    pub q: Option<String>,
    /// Optional project filter — when set, only history for this
    /// project is returned.
    pub project_id: Option<String>,
}

/// List soft-deleted worktrees across all projects (newest-removed
/// first). Supports a case-insensitive substring filter on branch via
/// `?q=` and a `?project_id=` filter.
pub async fn history(
    State(state): State<AppState>,
    axum::extract::Query(q): axum::extract::Query<HistoryQuery>,
) -> Result<Json<Vec<WorktreeDto>>, (StatusCode, String)> {
    let mut all = state
        .worktrees
        .list_removed_all()
        .await
        .map_err(map_wt_err)?;
    if let Some(pid) = q.project_id.as_deref() {
        all.retain(|w| w.project_id == pid);
    }
    if let Some(needle) = q.q.as_deref() {
        let needle = needle.to_lowercase();
        if !needle.is_empty() {
            all.retain(|w| w.branch.to_lowercase().contains(&needle));
        }
    }
    Ok(Json(all.into_iter().map(Into::into).collect()))
}

/// Restore a soft-deleted worktree row by clearing `removed_at`. This
/// only restores the database record; the git worktree on disk is **not
/// re-created** — restoring a row whose path was physically removed via
/// `git worktree remove` is informational only. Callers who need a
/// functioning worktree should create a new one based on the restored
/// row's branch.
///
/// Returns 404 if the id is unknown, and 409 if the row is already
/// live.
pub async fn restore(
    State(state): State<AppState>,
    Path(worktree_id): Path<String>,
) -> Result<Json<WorktreeDto>, (StatusCode, String)> {
    // Pre-flight: fetch the record so we can distinguish 404 vs 409.
    let existing = state
        .worktrees
        .get(&worktree_id)
        .await
        .map_err(map_wt_err)?;
    if existing.removed_at.is_none() {
        return Err((
            StatusCode::CONFLICT,
            format!("worktree {worktree_id} is already live"),
        ));
    }
    let changed = state
        .worktrees
        .restore(&worktree_id)
        .await
        .map_err(map_wt_err)?;
    if !changed {
        return Err((
            StatusCode::CONFLICT,
            format!("worktree {worktree_id} could not be restored"),
        ));
    }
    let fresh = state
        .worktrees
        .get(&worktree_id)
        .await
        .map_err(map_wt_err)?;
    let dto: WorktreeDto = fresh.into();
    state.logbus.publish(
        "sync",
        serde_json::json!({
            "kind": "worktree_restored",
            "worktree_id": dto.id,
            "project_id": dto.project_id,
        })
        .to_string(),
    );
    Ok(Json(dto))
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
