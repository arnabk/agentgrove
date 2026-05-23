//! Worktree repository.
//!
//! Rows are **soft-deleted**: `delete()` sets the `removed_at` column
//! instead of dropping the row, so a project's worktree history is
//! preserved and visible in the Worktree History view. `restore()` flips
//! the column back to NULL.

use crate::db::DbPool;
use chrono::{DateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use thiserror::Error;
use uuid::Uuid;

/// Lifecycle status of a worktree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeStatus {
    /// Creation has been requested; worktree is being prepared on disk.
    Creating,
    /// Pre-script (if any) is running.
    PreScript,
    /// Ready for use.
    Ready,
    /// Removal in progress.
    Removing,
    /// Creation or pre-script failed.
    Failed,
}

impl WorktreeStatus {
    /// String representation used for DB storage.
    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Creating => "creating",
            Self::PreScript => "pre_script",
            Self::Ready => "ready",
            Self::Removing => "removing",
            Self::Failed => "failed",
        }
    }

    /// Parse from DB string.
    fn parse(s: &str) -> Self {
        match s {
            "creating" => Self::Creating,
            "pre_script" => Self::PreScript,
            "removing" => Self::Removing,
            "failed" => Self::Failed,
            _ => Self::Ready,
        }
    }
}

/// Input to create a worktree.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewWorktree {
    /// Parent project id.
    pub project_id: String,
    /// Branch name to create (or check out).
    pub branch: String,
    /// Base ref to branch from (e.g. `main`, `HEAD`).
    pub base_ref: String,
    /// Absolute path where the worktree will live on disk.
    pub path: PathBuf,
    /// Optional pre-script body (shell-evaluated; OS-specific shell).
    pub pre_script: Option<String>,
    /// Optional post-script body.
    pub post_script: Option<String>,
}

/// A persisted worktree record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeRecord {
    /// UUID v7 string.
    pub id: String,
    /// Parent project id.
    pub project_id: String,
    /// Branch name.
    pub branch: String,
    /// Base ref the branch was created from.
    pub base_ref: String,
    /// Absolute path on disk.
    pub path: PathBuf,
    /// Current lifecycle status.
    pub status: WorktreeStatus,
    /// Optional pre-script body.
    pub pre_script: Option<String>,
    /// Optional post-script body.
    pub post_script: Option<String>,
    /// Creation timestamp.
    pub created_at: DateTime<Utc>,
    /// Last-update timestamp.
    pub updated_at: DateTime<Utc>,
    /// When the user removed this worktree from the AgentGrove view.
    /// `None` for live entries; `Some(...)` for historical entries.
    pub removed_at: Option<DateTime<Utc>>,
}

/// Errors raised by the worktree repository.
#[derive(Debug, Error)]
pub enum WorktreeError {
    /// Branch was empty.
    #[error("worktree branch must not be empty")]
    EmptyBranch,
    /// Base ref was empty.
    #[error("worktree base_ref must not be empty")]
    EmptyBaseRef,
    /// Path was not absolute.
    #[error("worktree path must be absolute: {0}")]
    RelativePath(PathBuf),
    /// Another worktree already exists at this path.
    #[error("a worktree already exists at {0}")]
    DuplicatePath(PathBuf),
    /// Worktree id does not exist.
    #[error("worktree not found: {0}")]
    NotFound(String),
    /// Underlying sqlx error.
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
}

/// Repository facade for worktrees. Cheaply cloneable.
#[derive(Debug, Clone)]
pub struct WorktreeRepo {
    pool: DbPool,
}

impl WorktreeRepo {
    /// Construct a new repository backed by `pool`.
    #[must_use]
    pub fn new(pool: DbPool) -> Self {
        Self { pool }
    }

    /// Insert a new worktree row. Initial status is `Creating`.
    pub async fn create(&self, input: NewWorktree) -> Result<WorktreeRecord, WorktreeError> {
        if input.branch.trim().is_empty() {
            return Err(WorktreeError::EmptyBranch);
        }
        if input.base_ref.trim().is_empty() {
            return Err(WorktreeError::EmptyBaseRef);
        }
        if !input.path.is_absolute() {
            return Err(WorktreeError::RelativePath(input.path));
        }

        let id = Uuid::now_v7().to_string();
        let now_ms = Utc::now().timestamp_millis();
        let now = Utc
            .timestamp_millis_opt(now_ms)
            .single()
            .unwrap_or_else(Utc::now);
        let path_str = path_to_str(&input.path);
        let status = WorktreeStatus::Creating;

        let res = sqlx::query(
            "INSERT INTO worktrees \
             (id, project_id, branch, base_ref, path, status, pre_script, post_script, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        )
        .bind(&id)
        .bind(&input.project_id)
        .bind(&input.branch)
        .bind(&input.base_ref)
        .bind(&path_str)
        .bind(status.as_str())
        .bind(input.pre_script.as_deref())
        .bind(input.post_script.as_deref())
        .bind(now_ms)
        .execute(&self.pool)
        .await;

        match res {
            Ok(_) => Ok(WorktreeRecord {
                id,
                project_id: input.project_id,
                branch: input.branch,
                base_ref: input.base_ref,
                path: input.path,
                status,
                pre_script: input.pre_script,
                post_script: input.post_script,
                created_at: now,
                updated_at: now,
                removed_at: None,
            }),
            Err(sqlx::Error::Database(db_err))
                if crate::project::is_unique_violation_pub(db_err.as_ref()) =>
            {
                Err(WorktreeError::DuplicatePath(input.path))
            }
            Err(e) => Err(WorktreeError::Db(e)),
        }
    }

    /// Update lifecycle status.
    pub async fn set_status(&self, id: &str, status: WorktreeStatus) -> Result<(), WorktreeError> {
        let now_ms = Utc::now().timestamp_millis();
        sqlx::query("UPDATE worktrees SET status = ?1, updated_at = ?2 WHERE id = ?3")
            .bind(status.as_str())
            .bind(now_ms)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Fetch one worktree by id (live or removed).
    pub async fn get(&self, id: &str) -> Result<WorktreeRecord, WorktreeError> {
        let row: Option<Row> = sqlx::query_as(
            "SELECT id, project_id, branch, base_ref, path, status, pre_script, post_script, \
             created_at, updated_at, removed_at FROM worktrees WHERE id = ?1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_record)
            .ok_or_else(|| WorktreeError::NotFound(id.to_owned()))
    }

    /// List live (not soft-deleted) worktrees for a project.
    pub async fn list_for_project(
        &self,
        project_id: &str,
    ) -> Result<Vec<WorktreeRecord>, WorktreeError> {
        let rows: Vec<Row> = sqlx::query_as(
            "SELECT id, project_id, branch, base_ref, path, status, pre_script, post_script, \
             created_at, updated_at, removed_at FROM worktrees \
             WHERE project_id = ?1 AND removed_at IS NULL \
             ORDER BY created_at ASC, id ASC",
        )
        .bind(project_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(row_to_record).collect())
    }

    /// List every removed worktree across all projects, newest-removed first.
    pub async fn list_removed_all(&self) -> Result<Vec<WorktreeRecord>, WorktreeError> {
        let rows: Vec<Row> = sqlx::query_as(
            "SELECT id, project_id, branch, base_ref, path, status, pre_script, post_script, \
             created_at, updated_at, removed_at FROM worktrees \
             WHERE removed_at IS NOT NULL \
             ORDER BY removed_at DESC, id ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(row_to_record).collect())
    }

    /// Soft-delete: mark `removed_at = now` so the row drops out of live
    /// views but stays available in history. Returns whether a row was
    /// affected.
    pub async fn delete(&self, id: &str) -> Result<bool, WorktreeError> {
        let now_ms = Utc::now().timestamp_millis();
        let res = sqlx::query(
            "UPDATE worktrees SET removed_at = ?1, updated_at = ?1 \
             WHERE id = ?2 AND removed_at IS NULL",
        )
        .bind(now_ms)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected() == 1)
    }

    /// Restore a soft-deleted row by clearing `removed_at`. Returns
    /// whether a row was affected.
    pub async fn restore(&self, id: &str) -> Result<bool, WorktreeError> {
        let now_ms = Utc::now().timestamp_millis();
        let res = sqlx::query(
            "UPDATE worktrees SET removed_at = NULL, updated_at = ?1 \
             WHERE id = ?2 AND removed_at IS NOT NULL",
        )
        .bind(now_ms)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected() == 1)
    }

    /// Hard-delete: physically remove the row. Used by tests and
    /// potentially a future "purge history" action; not called by the
    /// HTTP delete handler.
    pub async fn purge(&self, id: &str) -> Result<bool, WorktreeError> {
        let res = sqlx::query("DELETE FROM worktrees WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected() == 1)
    }

    /// Rename a worktree's branch label. This is a metadata-only
    /// update: the caller is responsible for invoking
    /// `git branch -m` against the on-disk repo. The worktree's path
    /// is left untouched (we deliberately do not move the directory —
    /// keeping the on-disk layout stable across renames matches the
    /// "rename branch only" policy chosen by the product).
    ///
    /// Returns the updated record on success.
    ///
    /// # Errors
    ///
    /// - [`WorktreeError::EmptyBranch`] if `new_branch` is blank.
    /// - [`WorktreeError::NotFound`] if no row matched `id`.
    /// - [`WorktreeError::Db`] for any underlying sqlx failure.
    /// Reset lifecycle rows that are stuck in a transient state from a
    /// previous run of the server.
    ///
    /// Statuses like `creating` / `pre_script` / `removing` are only
    /// valid mid-task; if the server was killed (or panicked) before
    /// the task finished, those rows stay in the transient state
    /// forever — there's no resumable task on disk to flip them. We
    /// rewrite them as follows:
    ///
    ///   - `creating` / `pre_script` → `failed`  (the create flow
    ///     never reached `ready`; surfacing the failure is more
    ///     honest than silently pretending the worktree is fine.
    ///     The user can delete + retry.)
    ///   - `removing` → `ready`  (the delete flow never finished;
    ///     the row is back to its pre-delete state. The user can
    ///     re-click Remove to retry.)
    ///
    /// Returns the number of rows touched so the caller can log it.
    /// Idempotent: a second call after recovery is a no-op.
    ///
    /// # Errors
    ///
    /// Returns [`WorktreeError::Db`] for any underlying sqlx failure.
    pub async fn recover_stale_lifecycle(&self) -> Result<u64, WorktreeError> {
        let to_failed = sqlx::query(
            "UPDATE worktrees \
             SET status = 'failed', updated_at = ?1 \
             WHERE removed_at IS NULL AND status IN ('creating','pre_script')",
        )
        .bind(Utc::now().timestamp_millis())
        .execute(&self.pool)
        .await?
        .rows_affected();

        let to_ready = sqlx::query(
            "UPDATE worktrees \
             SET status = 'ready', updated_at = ?1 \
             WHERE removed_at IS NULL AND status = 'removing'",
        )
        .bind(Utc::now().timestamp_millis())
        .execute(&self.pool)
        .await?
        .rows_affected();

        Ok(to_failed + to_ready)
    }

    /// Rename a worktree's branch label. Metadata-only — the caller
    /// is responsible for invoking `git branch -m` against the
    /// on-disk repo. The worktree's path is left untouched per the
    /// "rename branch only" policy.
    ///
    /// Returns the updated record on success.
    ///
    /// # Errors
    ///
    /// - [`WorktreeError::EmptyBranch`] if `new_branch` is blank.
    /// - [`WorktreeError::NotFound`] if no row matched `id`.
    /// - [`WorktreeError::Db`] for any underlying sqlx failure.
    pub async fn rename(
        &self,
        id: &str,
        new_branch: &str,
    ) -> Result<WorktreeRecord, WorktreeError> {
        if new_branch.trim().is_empty() {
            return Err(WorktreeError::EmptyBranch);
        }
        let now_ms = Utc::now().timestamp_millis();
        let res = sqlx::query("UPDATE worktrees SET branch = ?1, updated_at = ?2 WHERE id = ?3")
            .bind(new_branch)
            .bind(now_ms)
            .bind(id)
            .execute(&self.pool)
            .await?;
        if res.rows_affected() == 0 {
            return Err(WorktreeError::NotFound(id.to_owned()));
        }
        self.get(id).await
    }
}

#[allow(clippy::type_complexity)]
type Row = (
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    i64,
    i64,
    Option<i64>,
);

fn row_to_record(r: Row) -> WorktreeRecord {
    let (
        id,
        project_id,
        branch,
        base_ref,
        path,
        status,
        pre_script,
        post_script,
        created_ms,
        updated_ms,
        removed_ms,
    ) = r;
    WorktreeRecord {
        id,
        project_id,
        branch,
        base_ref,
        path: PathBuf::from(path),
        status: WorktreeStatus::parse(&status),
        pre_script,
        post_script,
        created_at: Utc
            .timestamp_millis_opt(created_ms)
            .single()
            .unwrap_or_else(Utc::now),
        updated_at: Utc
            .timestamp_millis_opt(updated_ms)
            .single()
            .unwrap_or_else(Utc::now),
        removed_at: removed_ms.and_then(|ms| Utc.timestamp_millis_opt(ms).single()),
    }
}

fn path_to_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}
