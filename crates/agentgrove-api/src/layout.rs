//! `/api/layout` endpoints — per-scope + global UI layout blobs.
//!
//! The FE used to keep all of this in `localStorage`, which lost
//! every entry when the user cleared site data and meant nothing
//! followed them across machines. Moving the layout to the BE
//! makes it part of the canonical session state alongside chats.
//!
//! Wire model:
//!
//! ```text
//! GET  /api/layout                            → { global, scopes: [...] }
//! PUT  /api/layout/global                     ← arbitrary JSON blob
//! PUT  /api/layout/scope?project=:p&worktree= ← arbitrary JSON blob
//! ```
//!
//! The blobs are opaque to the BE — the FE owns the shape and can
//! add fields freely without a migration. The single GET delivers
//! everything in one round-trip so the FE doesn't need to fan out
//! a request per scope on boot.

use crate::state::AppState;
use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

/// Wire shape for a single per-scope layout row.
#[derive(Debug, Serialize)]
pub struct ScopeLayout {
    pub project_id: String,
    /// Empty string ⇒ project-root scope. Worktree-scoped layouts
    /// carry the worktree id verbatim.
    pub worktree_id: String,
    pub blob: JsonValue,
}

/// `GET /api/layout` response — singleton global blob + every
/// per-scope blob, in one round-trip.
#[derive(Debug, Serialize)]
pub struct LayoutSnapshot {
    /// Empty object when no global blob has been written yet.
    pub global: JsonValue,
    pub scopes: Vec<ScopeLayout>,
}

/// `GET /api/layout` — hydrate the whole UI layout in one call.
pub async fn get_all(State(state): State<AppState>) -> Json<LayoutSnapshot> {
    let global = state
        .layouts
        .get_global()
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| JsonValue::Object(Default::default()));
    let scopes = state
        .layouts
        .list_scopes()
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|(project_id, worktree_id, blob)| ScopeLayout {
            project_id,
            worktree_id,
            blob,
        })
        .collect();
    Json(LayoutSnapshot { global, scopes })
}

/// `PUT /api/layout/global` body — opaque JSON.
#[derive(Debug, Deserialize)]
pub struct PutBlobBody {
    pub blob: JsonValue,
}

/// `PUT /api/layout/global` — replace the singleton global blob.
pub async fn put_global(
    State(state): State<AppState>,
    Json(body): Json<PutBlobBody>,
) -> StatusCode {
    if let Err(e) = state.layouts.put_global(&body.blob).await {
        tracing::warn!(error = %e, "put_global failed");
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    StatusCode::NO_CONTENT
}

/// `PUT /api/layout/scope` query params.
#[derive(Debug, Deserialize)]
pub struct ScopeQuery {
    pub project: String,
    /// Optional. Empty ⇒ project-root scope.
    #[serde(default)]
    pub worktree: String,
}

/// `PUT /api/layout/scope?project=...&worktree=...` — replace the
/// blob for one scope.
pub async fn put_scope(
    State(state): State<AppState>,
    Query(q): Query<ScopeQuery>,
    Json(body): Json<PutBlobBody>,
) -> StatusCode {
    if q.project.trim().is_empty() {
        return StatusCode::BAD_REQUEST;
    }
    let wt = if q.worktree.is_empty() {
        None
    } else {
        Some(q.worktree.as_str())
    };
    if let Err(e) = state.layouts.put_scope(&q.project, wt, &body.blob).await {
        tracing::warn!(error = %e, "put_scope failed");
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    StatusCode::NO_CONTENT
}
