//! Per-project scratchpad: a single rich-text document stored under
//! `<state_dir>/scratchpads/<project_id>.json`. Content is opaque HTML
//! produced by the FE rich-text editor; the BE never parses it.

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
        project_id,
        body: body.body,
        updated_at: Utc::now(),
    };
    write_one(&state.state_dir, &pad)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(pad))
}
