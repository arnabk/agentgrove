//! Layout repository.
//!
//! UI layout state — which chat tab is active, which pane is focused,
//! terminal tabs, queue dock visibility, rail width, etc. — used to
//! live in browser localStorage which was hostile to "switch laptops"
//! workflows and lost everything when site data was cleared. We move
//! it to SQLite so the BE is the single source of truth.
//!
//! Two tables:
//!   * `layout_scope` — per-(project, worktree?) JSON blob.
//!   * `layout_global` — single-row blob for app-wide state.
//!
//! Both store opaque JSON because the FE owns the shape; adding a
//! new field (collapsed sections, sort order, etc.) is a FE-only
//! change with zero migration work.

use crate::db::DbPool;
use chrono::Utc;
use serde_json::Value as JsonValue;
use thiserror::Error;

/// Errors raised by [`LayoutRepo`].
#[derive(Debug, Error)]
pub enum LayoutError {
    /// Underlying sqlx error.
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
    /// JSON parse / serialise failure.
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

/// Repository for per-scope + global UI layout blobs. Cheaply cloneable.
#[derive(Debug, Clone)]
pub struct LayoutRepo {
    pool: DbPool,
}

impl LayoutRepo {
    /// Construct a new repository backed by `pool`.
    #[must_use]
    pub fn new(pool: DbPool) -> Self {
        Self { pool }
    }

    // ----- per-scope ----------------------------------------------------

    /// Read the layout blob for `(project_id, worktree_id?)`.
    /// Returns `None` when no row exists yet.
    pub async fn get_scope(
        &self,
        project_id: &str,
        worktree_id: Option<&str>,
    ) -> Result<Option<JsonValue>, LayoutError> {
        let wt = worktree_id.unwrap_or("");
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT blob_json FROM layout_scope \
             WHERE project_id = ?1 AND worktree_id = ?2",
        )
        .bind(project_id)
        .bind(wt)
        .fetch_optional(&self.pool)
        .await?;
        match row {
            Some((s,)) => Ok(Some(serde_json::from_str(&s)?)),
            None => Ok(None),
        }
    }

    /// Upsert the layout blob for `(project_id, worktree_id?)`.
    pub async fn put_scope(
        &self,
        project_id: &str,
        worktree_id: Option<&str>,
        blob: &JsonValue,
    ) -> Result<(), LayoutError> {
        let wt = worktree_id.unwrap_or("");
        let serialized = serde_json::to_string(blob)?;
        let now_ms = Utc::now().timestamp_millis();
        sqlx::query(
            "INSERT INTO layout_scope (project_id, worktree_id, blob_json, updated_at) \
             VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT (project_id, worktree_id) DO UPDATE \
             SET blob_json = excluded.blob_json, updated_at = excluded.updated_at",
        )
        .bind(project_id)
        .bind(wt)
        .bind(serialized)
        .bind(now_ms)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// List every persisted scope's blob. Used by the FE on boot to
    /// hydrate all scopes at once instead of one round-trip per
    /// scope.
    pub async fn list_scopes(
        &self,
    ) -> Result<Vec<(String, String, JsonValue)>, LayoutError> {
        let rows: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT project_id, worktree_id, blob_json FROM layout_scope \
             ORDER BY project_id ASC, worktree_id ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|(p, w, s)| serde_json::from_str::<JsonValue>(&s).map(|v| (p, w, v)))
            .collect::<Result<Vec<_>, _>>()
            .map_err(LayoutError::Json)
    }

    // ----- global -------------------------------------------------------

    /// Read the global layout blob. Returns `None` if the singleton
    /// row hasn't been written yet.
    pub async fn get_global(&self) -> Result<Option<JsonValue>, LayoutError> {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT blob_json FROM layout_global WHERE id = 'singleton'")
                .fetch_optional(&self.pool)
                .await?;
        match row {
            Some((s,)) => Ok(Some(serde_json::from_str(&s)?)),
            None => Ok(None),
        }
    }

    /// Upsert the global layout blob.
    pub async fn put_global(&self, blob: &JsonValue) -> Result<(), LayoutError> {
        let serialized = serde_json::to_string(blob)?;
        let now_ms = Utc::now().timestamp_millis();
        sqlx::query(
            "INSERT INTO layout_global (id, blob_json, updated_at) \
             VALUES ('singleton', ?1, ?2) \
             ON CONFLICT (id) DO UPDATE \
             SET blob_json = excluded.blob_json, updated_at = excluded.updated_at",
        )
        .bind(serialized)
        .bind(now_ms)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}
