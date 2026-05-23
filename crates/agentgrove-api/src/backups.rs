//! Backups admin endpoints for the Settings UI.
//!
//! Wraps the same snapshot infrastructure the `just backups` /
//! `just restore-db` scripts expose. The shell scripts remain the
//! recommended path for offline recovery (they refuse to run while
//! the server is up); these HTTP endpoints exist so the FE
//! Settings → Backups panel can list snapshots and trigger a
//! `pre-restore` snapshot without leaving the app.
//!
//! Routes:
//!   * `GET  /api/backups`               list snapshots, newest first
//!   * `POST /api/backups`               take a manual snapshot now
//!   * `POST /api/backups/:name/restore` schedule a restore (server
//!     marks the request + the FE prompts the user to stop the BE
//!     and run the shell script — actually swapping files under a
//!     live SQLite connection is unsafe, so we DON'T do the
//!     filesystem copy from the running server).

use crate::state::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Serialize;
use std::time::SystemTime;

#[derive(Debug, Serialize)]
pub struct BackupSummary {
    /// Directory name under `<state_dir>/backups/`, e.g.
    /// `db-20260522-064556-pre-migrate`.
    pub name: String,
    /// Aggregate byte size of the snapshot directory contents.
    pub size_bytes: u64,
    /// Wall-clock time the snapshot was written, as a unix epoch
    /// in seconds. The FE renders relative time ("2 h ago").
    pub created_at_secs: u64,
    /// Optional tag parsed from the directory suffix. None for
    /// plain `db-<ts>` (startup snapshots).
    pub tag: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct BackupsListResponse {
    pub backups: Vec<BackupSummary>,
    /// State dir path the FE shows so the user knows where the
    /// files actually live on disk.
    pub state_dir: String,
}

/// `GET /api/backups` — list snapshots, newest first.
pub async fn list(
    State(state): State<AppState>,
) -> Result<Json<BackupsListResponse>, (StatusCode, String)> {
    let dir = state.state_dir.as_ref().join("backups");
    let mut out: Vec<BackupSummary> = Vec::new();
    if dir.is_dir() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) => {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("read backups dir: {e}"),
                ));
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with("db-") {
                continue;
            }
            let created_at_secs = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let tag = parse_tag(&name);
            let size_bytes = dir_size(&path).unwrap_or(0);
            out.push(BackupSummary {
                name,
                size_bytes,
                created_at_secs,
                tag,
            });
        }
    }
    out.sort_by(|a, b| b.created_at_secs.cmp(&a.created_at_secs));
    Ok(Json(BackupsListResponse {
        backups: out,
        state_dir: state.state_dir.to_string_lossy().into_owned(),
    }))
}

/// `POST /api/backups` — take a snapshot of the current DB. Returns
/// the new snapshot's name.
#[derive(Debug, Serialize)]
pub struct CreateBackupResponse {
    pub name: String,
}

pub async fn create(
    State(state): State<AppState>,
) -> Result<Json<CreateBackupResponse>, (StatusCode, String)> {
    let state_dir = state.state_dir.as_ref().clone();
    // `snapshot_db_to_backups_tagged` is sync — run it on the
    // blocking pool so a slow disk doesn't stall the runtime.
    let dir = tokio::task::spawn_blocking(move || {
        agentgrove_store::snapshot_db_to_backups_tagged(&state_dir, "manual")
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("join: {e}")))?;
    let path = dir.ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        "snapshot returned None (DB missing?)".into(),
    ))?;
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(Json(CreateBackupResponse { name }))
}

/// `POST /api/backups/:name/restore` — verify the snapshot exists
/// and return instructions for the operator. We DO NOT touch the
/// live DB files from a running server because SQLite's WAL is
/// in flight; copying over `agentgrove.sqlite` while the pool
/// holds open connections can corrupt both ends. The FE renders
/// the response as a "stop the server, then run this command"
/// step.
#[derive(Debug, Serialize)]
pub struct RestoreInstructions {
    pub snapshot: String,
    pub snapshot_path: String,
    pub shell_command: String,
    pub note: String,
}

pub async fn restore(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<RestoreInstructions>, (StatusCode, String)> {
    let dir = state.state_dir.as_ref().join("backups").join(&name);
    if !dir.is_dir() {
        return Err((StatusCode::NOT_FOUND, format!("no snapshot named {name}")));
    }
    if !dir.join("agentgrove.sqlite").is_file() {
        return Err((
            StatusCode::CONFLICT,
            format!("{name} is missing agentgrove.sqlite (corrupt?)"),
        ));
    }
    Ok(Json(RestoreInstructions {
        snapshot: name.clone(),
        snapshot_path: dir.to_string_lossy().into_owned(),
        shell_command: format!("just restore-db {name}"),
        note: concat!(
            "Restoring overwrites the live DB; run this AFTER stopping ",
            "the server. The CLI prompts for confirmation and snapshots ",
            "the current state as db-<ts>-pre-restore so this restore ",
            "is itself reversible."
        )
        .to_string(),
    }))
}

/// Parse the optional tag suffix from a snapshot directory name.
/// `db-20260522-064556` -> None.
/// `db-20260522-064556-pre-migrate` -> Some("pre-migrate").
fn parse_tag(name: &str) -> Option<String> {
    // db-YYYYMMDD-HHMMSS  -> 3 dash-separated tokens after `db-`.
    let stripped = name.strip_prefix("db-")?;
    let mut parts = stripped.splitn(3, '-');
    let _date = parts.next()?;
    let _time = parts.next()?;
    parts.next().map(str::to_string)
}

/// Recursive directory size, in bytes. Best-effort; unreadable
/// entries are skipped. Used for the Settings panel's "size"
/// column.
fn dir_size(path: &std::path::Path) -> Option<u64> {
    let mut total = 0u64;
    let entries = std::fs::read_dir(path).ok()?;
    for entry in entries.flatten() {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_file() {
            total += meta.len();
        } else if meta.is_dir() {
            if let Some(sub) = dir_size(&entry.path()) {
                total += sub;
            }
        }
    }
    Some(total)
}
