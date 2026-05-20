//! Editor file I/O + simple git diff against HEAD.

use crate::state::AppState;
use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use tokio::fs;

#[derive(Default, Debug)]
pub struct EditorState {
    /// Paths that have been opened in this session (for left-rail history).
    pub open_history: HashSet<PathBuf>,
}

#[derive(Debug, Deserialize)]
pub struct ReadQuery {
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct TreeQuery {
    pub path: String,
    /// When true, include entries starting with `.` (e.g. `.git`).
    /// Defaults to false.
    #[serde(default)]
    pub show_hidden: bool,
}

#[derive(Debug, Serialize)]
pub struct TreeEntryDto {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
pub struct FileContent {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct WriteBody {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
pub struct DiffResponse {
    pub path: String,
    pub head: String,
    pub working: String,
}

#[derive(Debug, Serialize)]
pub struct TreeEntry {
    pub path: String,
    pub is_dir: bool,
}

pub async fn read(
    State(state): State<AppState>,
    Query(q): Query<ReadQuery>,
) -> Result<Json<FileContent>, (StatusCode, String)> {
    let path = PathBuf::from(&q.path);
    if !path.is_absolute() {
        return Err((StatusCode::BAD_REQUEST, "path must be absolute".into()));
    }
    let content = fs::read_to_string(&path).await.map_err(|e| {
        (
            StatusCode::NOT_FOUND,
            format!("cannot read {}: {e}", path.display()),
        )
    })?;
    state.editor.write().await.open_history.insert(path.clone());
    Ok(Json(FileContent {
        path: q.path,
        content,
    }))
}

pub async fn write_file(
    State(_state): State<AppState>,
    Json(body): Json<WriteBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    let path = PathBuf::from(&body.path);
    if !path.is_absolute() {
        return Err((StatusCode::BAD_REQUEST, "path must be absolute".into()));
    }
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent).await;
    }
    fs::write(&path, body.content)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn diff(Query(q): Query<ReadQuery>) -> Result<Json<DiffResponse>, (StatusCode, String)> {
    let path = PathBuf::from(&q.path);
    if !path.is_absolute() {
        return Err((StatusCode::BAD_REQUEST, "path must be absolute".into()));
    }
    let working = fs::read_to_string(&path).await.unwrap_or_default();
    // HEAD content: ask git for the blob at HEAD for this file. If the
    // file is untracked, HEAD is empty string. We invoke git in the
    // file's parent dir.
    let parent = path.parent().unwrap_or(&path).to_path_buf();
    let rel = path
        .strip_prefix(&parent)
        .unwrap_or(&path)
        .to_string_lossy()
        .into_owned();
    let head = match tokio::process::Command::new("git")
        .args(["show", &format!("HEAD:./{rel}")])
        .current_dir(&parent)
        .output()
        .await
    {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).into_owned(),
        _ => String::new(),
    };
    Ok(Json(DiffResponse {
        path: q.path,
        head,
        working,
    }))
}

pub async fn tree(
    Query(q): Query<TreeQuery>,
) -> Result<Json<Vec<TreeEntryDto>>, (StatusCode, String)> {
    let path = PathBuf::from(&q.path);
    if !path.is_absolute() {
        return Err((StatusCode::BAD_REQUEST, "path must be absolute".into()));
    }
    let mut entries = Vec::<TreeEntryDto>::new();
    let mut rd = fs::read_dir(&path)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    while let Ok(Some(e)) = rd.next_entry().await {
        let name = e.file_name().to_string_lossy().into_owned();
        if !q.show_hidden && name.starts_with('.') {
            continue;
        }
        let md = match e.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };
        entries.push(TreeEntryDto {
            name,
            path: e.path().to_string_lossy().into_owned(),
            is_dir: md.is_dir(),
        });
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(Json(entries))
}

#[allow(dead_code)]
pub async fn history(State(state): State<AppState>) -> Json<Vec<String>> {
    let s = state.editor.read().await;
    Json(
        s.open_history
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
    )
}
