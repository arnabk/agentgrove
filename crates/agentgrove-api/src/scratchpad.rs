//! Per-project scratchpad: a single rich-text document stored under
//! `<state_dir>/scratchpads/<project_id>.json`. Content is opaque HTML
//! produced by the FE rich-text editor; the BE never parses it.
//!
//! A workspace-**global** note also lives here under the reserved id
//! [`GLOBAL_NOTE_ID`] (`<state_dir>/scratchpads/__global__.json`). It is
//! exposed via `/api/notes` (no project id) and is what the Notes panel
//! now shows — notes are no longer tied to the selected project.

use crate::state::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::fs;

/// Scratchpad payload exchanged with clients.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scratchpad {
    pub project_id: String,
    /// Rich-text body, HTML.
    pub body: String,
    /// RFC3339 timestamp of last save.
    pub updated_at: DateTime<Utc>,
}

/// Reserved id for the single workspace-global note. Lives alongside the
/// per-project scratchpads but is never a real project id (projects use
/// UUIDs), so it can't collide.
pub const GLOBAL_NOTE_ID: &str = "__global__";

fn pad_path(state_dir: &std::path::Path, project_id: &str) -> PathBuf {
    state_dir
        .join("scratchpads")
        .join(format!("{project_id}.json"))
}

async fn read_one(state_dir: &std::path::Path, project_id: &str) -> Scratchpad {
    let p = pad_path(state_dir, project_id);
    match fs::read(&p).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|_| Scratchpad {
            project_id: project_id.to_owned(),
            body: String::new(),
            updated_at: Utc::now(),
        }),
        Err(_) => Scratchpad {
            project_id: project_id.to_owned(),
            body: String::new(),
            updated_at: Utc::now(),
        },
    }
}

async fn write_one(state_dir: &std::path::Path, pad: &Scratchpad) -> std::io::Result<()> {
    let p = pad_path(state_dir, &pad.project_id);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).await?;
    }
    let json = serde_json::to_vec_pretty(pad).unwrap_or_else(|_| b"{}".to_vec());
    fs::write(p, json).await
}

#[derive(Debug, Deserialize)]
pub struct UpdateBody {
    pub body: String,
}

pub async fn get(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Json<Scratchpad> {
    Json(read_one(&state.state_dir, &project_id).await)
}

pub async fn put(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(body): Json<UpdateBody>,
) -> Result<Json<Scratchpad>, (StatusCode, String)> {
    let pad = Scratchpad {
        project_id: project_id.clone(),
        body: body.body,
        updated_at: Utc::now(),
    };
    write_one(&state.state_dir, &pad)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    // Cross-instance sync: every connected client (any browser,
    // any machine) subscribed to the `sync` topic gets a small
    // notification frame and re-fetches the scratchpad. The
    // payload deliberately stays minimal (project_id +
    // updated_at) — clients pull the body themselves so we don't
    // round-trip the entire document over the WS for every
    // keystroke save.
    state.logbus.publish(
        "sync",
        serde_json::json!({
            "kind": "scratchpad_updated",
            "project_id": pad.project_id,
            "updated_at": pad.updated_at.to_rfc3339(),
        })
        .to_string(),
    );
    Ok(Json(pad))
}

/// Workspace-global note (not scoped to any project). Stored under the
/// reserved [`GLOBAL_NOTE_ID`]. The `project_id` field in the returned
/// payload echoes that reserved id so the FE can reuse the [`Scratchpad`]
/// shape unchanged.
pub async fn get_global(State(state): State<AppState>) -> Json<Scratchpad> {
    Json(read_one(&state.state_dir, GLOBAL_NOTE_ID).await)
}

pub async fn put_global(
    State(state): State<AppState>,
    Json(body): Json<UpdateBody>,
) -> Result<Json<Scratchpad>, (StatusCode, String)> {
    let pad = Scratchpad {
        project_id: GLOBAL_NOTE_ID.to_owned(),
        body: body.body,
        updated_at: Utc::now(),
    };
    write_one(&state.state_dir, &pad)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    // Cross-instance sync: notify every connected client that the global
    // note changed so they re-fetch. Distinct `kind` from the per-project
    // scratchpad frame so clients can route it without a project id.
    state.logbus.publish(
        "sync",
        serde_json::json!({
            "kind": "notes_updated",
            "updated_at": pad.updated_at.to_rfc3339(),
        })
        .to_string(),
    );
    Ok(Json(pad))
}
