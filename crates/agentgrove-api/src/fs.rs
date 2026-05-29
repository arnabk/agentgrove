//! Filesystem browser endpoints used by the FE folder picker.
//!
//! These intentionally have no auth (the server is loopback-only by
//! default) and never modify the filesystem.

use axum::{extract::Query, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::fs;

#[derive(Debug, Serialize)]
pub struct HomeResponse {
    /// Suggested starting directory for the picker (user's home or CWD).
    pub home: String,
    /// Coarse-grained roots — drive letters on Windows, `/` on Unix.
    pub roots: Vec<String>,
}

pub async fn home() -> Json<HomeResponse> {
    let home = home_dir().to_string_lossy().into_owned();
    let roots = filesystem_roots()
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    Json(HomeResponse { home, roots })
}

#[derive(Debug, Deserialize)]
pub struct BrowseQuery {
    pub path: String,
    /// When true, include entries starting with `.`. Defaults to false.
    #[serde(default)]
    pub show_hidden: bool,
}

#[derive(Debug, Serialize)]
pub struct DirEntryDto {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// Whether the user can `read_dir` it. For non-dirs always false.
    pub readable: bool,
}

#[derive(Debug, Serialize)]
pub struct BrowseResponse {
    /// Absolute, normalised path of the directory we listed.
    pub path: String,
    /// Display name (basename), or the path itself for roots.
    pub name: String,
    /// Parent path, when not at a filesystem root.
    pub parent: Option<String>,
    /// Direct children (sorted: directories first, alphabetic).
    pub entries: Vec<DirEntryDto>,
}

pub async fn browse(
    Query(q): Query<BrowseQuery>,
) -> Result<Json<BrowseResponse>, (StatusCode, String)> {
    let path = PathBuf::from(&q.path);
    if !path.is_absolute() {
        return Err((StatusCode::BAD_REQUEST, "path must be absolute".into()));
    }
    let md = fs::metadata(&path)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, format!("{}: {e}", path.display())))?;
    if !md.is_dir() {
        return Err((StatusCode::BAD_REQUEST, "path is not a directory".into()));
    }

    let mut entries = Vec::<DirEntryDto>::new();
    let mut rd = fs::read_dir(&path)
        .await
        .map_err(|e| (StatusCode::FORBIDDEN, e.to_string()))?;
    while let Ok(Some(e)) = rd.next_entry().await {
        let name = e.file_name().to_string_lossy().into_owned();
        if !q.show_hidden && name.starts_with('.') {
            continue;
        }
        let is_dir = match e.file_type().await {
            Ok(ft) => ft.is_dir(),
            Err(_) => continue,
        };
        if !is_dir {
            // The picker only needs directories.
            continue;
        }
        let abs = e.path().to_string_lossy().into_owned();
        // A directory is "readable" if we can open it. Cheap probe.
        let readable = fs::read_dir(e.path()).await.is_ok();
        entries.push(DirEntryDto {
            name,
            path: abs,
            is_dir,
            readable,
        });
    }
    entries.sort_by_key(|e| e.name.to_lowercase());

    let parent = path
        .parent()
        .filter(|p| *p != Path::new(""))
        .map(|p| p.to_string_lossy().into_owned());
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());

    Ok(Json(BrowseResponse {
        path: path.to_string_lossy().into_owned(),
        name,
        parent,
        entries,
    }))
}

fn home_dir() -> PathBuf {
    #[cfg(unix)]
    {
        if let Ok(h) = std::env::var("HOME") {
            return PathBuf::from(h);
        }
    }
    #[cfg(windows)]
    {
        if let Ok(h) = std::env::var("USERPROFILE") {
            return PathBuf::from(h);
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"))
}

#[cfg(unix)]
fn filesystem_roots() -> Vec<PathBuf> {
    vec![PathBuf::from("/")]
}

#[cfg(windows)]
fn filesystem_roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for letter in b'A'..=b'Z' {
        let d = format!("{}:\\", letter as char);
        if std::path::Path::new(&d).exists() {
            out.push(PathBuf::from(d));
        }
    }
    if out.is_empty() {
        out.push(PathBuf::from(r"C:\"));
    }
    out
}
