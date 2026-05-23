//! HTTP handlers for the Cmd+P fuzzy file finder.
//!
//! Routes:
//!   * `GET  /api/projects/:id/files/search?q=&limit=` — fuzzy
//!     match against the per-project file index. Returns
//!     `[{path, abs, score}]`. Triggers a first-time scan when
//!     the index is empty. Empty `q` returns the first N indexed
//!     paths (useful as the palette's idle state).
//!   * `POST /api/projects/:id/files/reindex` — force a re-scan.
//!     Returns `{ indexed: <count> }`.
//!
//! The index module is `crate::file_index`. See its docs for the
//! memory budget + matcher choice.

use crate::state::AppState;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::file_index::SearchHit;

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    /// User-typed query. Empty -> first N entries.
    #[serde(default)]
    pub q: Option<String>,
    /// Max results to return. Bounded server-side to 200 so a
    /// malicious caller can't ask for the whole index.
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct SearchResponse {
    /// Ranked hits, best score first.
    pub hits: Vec<SearchHit>,
    /// Total entries in the index (so the FE can render a footer
    /// like "1234 files indexed").
    pub total_indexed: usize,
}

const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 200;

/// `GET /api/projects/:id/files/search`.
pub async fn search(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(q): Query<SearchQuery>,
) -> Result<Json<SearchResponse>, (StatusCode, String)> {
    let project = state
        .projects
        .get(&project_id)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "project not found".to_string()))?;
    state
        .file_index
        .ensure_indexed(&project_id, &project.root)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("file index: {e}"),
            )
        })?;
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let query = q.q.unwrap_or_default();
    let hits = state.file_index.search(&project_id, &query, limit).await;
    let total = state.file_index.count(&project_id).await;
    Ok(Json(SearchResponse {
        hits,
        total_indexed: total,
    }))
}

#[derive(Debug, Serialize)]
pub struct ReindexResponse {
    pub indexed: usize,
}

/// `POST /api/projects/:id/files/reindex`.
pub async fn reindex(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<ReindexResponse>, (StatusCode, String)> {
    let project = state
        .projects
        .get(&project_id)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "project not found".to_string()))?;
    let n = state
        .file_index
        .reindex(&project_id, &project.root)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("file index: {e}"),
            )
        })?;
    Ok(Json(ReindexResponse { indexed: n }))
}
