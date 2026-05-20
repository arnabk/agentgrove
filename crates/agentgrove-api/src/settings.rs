//! User settings persisted as a single JSON file under the state dir.

use crate::state::AppState;
use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::fs;

/// User-tunable preferences. All fields optional in the JSON form so we
/// can extend without breaking existing files.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Settings {
    /// Theme id (matches `Theme.id` from `/api/themes`).
    #[serde(default)]
    pub theme: Option<String>,
    /// CSS font-family stack used for UI text.
    #[serde(default)]
    pub ui_font: Option<String>,
    /// CSS font-family stack for code (editor, terminal, mono cells).
    #[serde(default)]
    pub mono_font: Option<String>,
    /// Base UI font size in px.
    #[serde(default)]
    pub font_size: Option<u32>,
}

fn settings_path(state_dir: &std::path::Path) -> PathBuf {
    state_dir.join("settings.json")
}

async fn read_settings(state_dir: &std::path::Path) -> Settings {
    let p = settings_path(state_dir);
    match fs::read(&p).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

async fn write_settings(state_dir: &std::path::Path, s: &Settings) -> std::io::Result<()> {
    let p = settings_path(state_dir);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).await?;
    }
    let json = serde_json::to_vec_pretty(s).unwrap_or_else(|_| b"{}".to_vec());
    fs::write(p, json).await
}

pub async fn get(State(state): State<AppState>) -> Json<Settings> {
    Json(read_settings(&state.state_dir).await)
}

pub async fn put(
    State(state): State<AppState>,
    Json(body): Json<Settings>,
) -> Result<Json<Settings>, (StatusCode, String)> {
    write_settings(&state.state_dir, &body)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(body))
}
