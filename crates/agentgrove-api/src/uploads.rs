//! `/api/uploads` — accept files (drag-drop or image paste from the
//! chat input), persist them under `<state_dir>/uploads/<uuid>/`, and
//! return enough metadata for the FE to reference them on the next
//! chat prompt.
//!
//! Files are stored on the local filesystem rather than in the database
//! because the agent CLIs (Claude Code in particular) read them via
//! their native `Read` tool against absolute paths. Keeping them as
//! plain files makes that integration trivial — we just hand the
//! provider the abs path.
//!
//! Hard caps:
//!   - 25 MB per file.
//!   - Filename sanitised: only basename kept; non-portable chars
//!     replaced with `_`.

use crate::state::AppState;
use axum::{
    extract::{DefaultBodyLimit, Multipart, Path, State},
    http::{header, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::Serialize;
use uuid::Uuid;

/// Soft cap on each uploaded file (25 MB). Larger files are rejected
/// with 413.
pub const MAX_UPLOAD_BYTES: usize = 25 * 1024 * 1024;

/// Wire shape for a successfully stored upload.
#[derive(Debug, Clone, Serialize)]
pub struct UploadDto {
    /// Stable id (uuid v7); also the leaf dir under state_dir/uploads.
    pub id: String,
    /// Original filename as the user uploaded it (sanitised).
    pub filename: String,
    /// MIME type the multipart part declared. `application/octet-stream`
    /// when missing.
    pub content_type: String,
    /// File size on disk in bytes.
    pub size: u64,
    /// Absolute path on disk — this is the value the FE includes in
    /// the chat prompt so the agent's Read tool can fetch it.
    pub path: String,
}

/// `POST /api/uploads` — accept any number of multipart parts under
/// the field name `file`. Each part is written to its own uuid dir so
/// concurrent uploads with the same filename don't collide.
pub async fn create(
    State(state): State<AppState>,
    mut form: Multipart,
) -> Result<Json<Vec<UploadDto>>, (StatusCode, String)> {
    let root = state.state_dir.join("uploads");
    if let Err(e) = tokio::fs::create_dir_all(&root).await {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to create uploads dir: {e}"),
        ));
    }

    let mut out = Vec::new();
    while let Ok(Some(field)) = form.next_field().await {
        // The field name we expect; ignore other unexpected fields.
        if field.name() != Some("file") {
            continue;
        }
        let original_name = field
            .file_name()
            .map(|s| s.to_owned())
            .unwrap_or_else(|| "upload".to_string());
        let safe_name = sanitize_filename(&original_name);
        let content_type = field
            .content_type()
            .map(|s| s.to_owned())
            .unwrap_or_else(|| "application/octet-stream".to_string());

        let id = Uuid::now_v7().to_string();
        let dir = root.join(&id);
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to create upload dir: {e}"),
            ));
        }
        let path = dir.join(&safe_name);

        let bytes = field.bytes().await.map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                format!("failed to read upload: {e}"),
            )
        })?;
        if bytes.len() > MAX_UPLOAD_BYTES {
            // Clean up the partial dir before returning.
            let _ = tokio::fs::remove_dir_all(&dir).await;
            return Err((
                StatusCode::PAYLOAD_TOO_LARGE,
                format!(
                    "upload exceeds limit: {} > {} bytes",
                    bytes.len(),
                    MAX_UPLOAD_BYTES
                ),
            ));
        }
        let size = bytes.len() as u64;
        if let Err(e) = tokio::fs::write(&path, &bytes).await {
            let _ = tokio::fs::remove_dir_all(&dir).await;
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to write upload: {e}"),
            ));
        }
        out.push(UploadDto {
            id,
            filename: safe_name,
            content_type,
            size,
            path: path.to_string_lossy().into_owned(),
        });
    }

    if out.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "no `file` parts found in multipart body".into(),
        ));
    }
    Ok(Json(out))
}

/// `GET /api/uploads/:id/raw` — serve the uploaded bytes back for FE
/// preview (image thumbnails in the chat). We look up the id's dir
/// and stream the single file inside.
pub async fn raw(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    if !is_safe_id(&id) {
        return Err((StatusCode::BAD_REQUEST, "invalid id".into()));
    }
    let dir = state.state_dir.join("uploads").join(&id);
    let mut entries = tokio::fs::read_dir(&dir)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "upload not found".into()))?;
    let entry = entries
        .next_entry()
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to read upload dir: {e}"),
            )
        })?
        .ok_or((StatusCode::NOT_FOUND, "upload empty".into()))?;
    let path = entry.path();
    let bytes = tokio::fs::read(&path).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to read upload: {e}"),
        )
    })?;
    let mime = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .to_string();
    Ok(([(header::CONTENT_TYPE, mime)], bytes))
}

/// Strip path separators and force a portable filename. We keep the
/// basename (last segment), collapse runs of replaced chars, and fall
/// back to a generic name if the result is empty.
fn sanitize_filename(raw: &str) -> String {
    let base = std::path::Path::new(raw)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| raw.to_string());
    let mut out = String::with_capacity(base.len());
    let mut prev_underscore = false;
    for c in base.chars() {
        if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') {
            out.push(c);
            prev_underscore = false;
        } else if !prev_underscore {
            out.push('_');
            prev_underscore = true;
        }
    }
    let trimmed = out.trim_matches(|c: char| c == '_' || c == '.');
    if trimmed.is_empty() {
        "upload.bin".to_string()
    } else {
        trimmed.to_string()
    }
}

/// True when `id` looks like a uuid we issued (lowercase hex + dashes,
/// no path separators). Defensive guard against `..` traversal in the
/// `/raw` endpoint.
fn is_safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() < 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Hook called from the router builder to lift the default body limit
/// to [`MAX_UPLOAD_BYTES`].
pub fn body_limit_layer() -> DefaultBodyLimit {
    DefaultBodyLimit::max(MAX_UPLOAD_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_filename_keeps_extension() {
        assert_eq!(sanitize_filename("/etc/passwd"), "passwd");
        assert_eq!(sanitize_filename("hello world.png"), "hello_world.png");
        assert_eq!(sanitize_filename("..weird .file"), "weird_.file");
        assert_eq!(sanitize_filename(""), "upload.bin");
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
    }

    #[test]
    fn is_safe_id_rejects_path_traversal() {
        assert!(is_safe_id("019e4486-556e-7d41-8134-78fb8ce83f66"));
        assert!(!is_safe_id("../etc/passwd"));
        assert!(!is_safe_id(""));
        assert!(!is_safe_id("../"));
    }
}
