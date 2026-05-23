//! Project repository.
//!
//! Persists `Project` aggregates to the `projects` table. The on-disk path
//! must be unique (one project per folder).

use crate::db::DbPool;
use chrono::{DateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use thiserror::Error;
use uuid::Uuid;

/// Input for creating a project.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewProject {
    /// Display name (trimmed before insertion).
    pub name: String,
    /// Absolute path to the project root on disk.
    pub root: PathBuf,
}

/// A persisted project record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectRecord {
    /// UUID v7 string.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Absolute path on disk.
    pub root: PathBuf,
    /// Shell command (or multi-line script) to run inside every NEW
    /// worktree of this project, immediately after `git worktree add`
    /// succeeds. `None` = no project-level default; the worktree
    /// dialog may still accept an ad-hoc override at create time.
    ///
    /// Stored as plain text — interpreted by `agentgrove-scripts` at
    /// run time (which picks bash on Unix, pwsh on Windows). We do
    /// NOT pre-parse or validate the body here: scripts that fail at
    /// run time surface as `Failed` worktree status with the stderr
    /// streamed onto the LogBus.
    pub pre_worktree_script: Option<String>,
    /// Creation timestamp.
    pub created_at: DateTime<Utc>,
    /// Last-update timestamp.
    pub updated_at: DateTime<Utc>,
}

/// Errors from the project repository.
#[derive(Debug, Error)]
pub enum ProjectError {
    /// The provided name was empty or whitespace.
    #[error("project name must not be empty")]
    EmptyName,
    /// The provided root path was not absolute.
    #[error("project root must be absolute: {0}")]
    RelativeRoot(PathBuf),
    /// Another project already exists at the same root path.
    #[error("a project already exists at {0}")]
    DuplicateRoot(PathBuf),
    /// Project id does not exist.
    #[error("project not found: {0}")]
    NotFound(String),
    /// Underlying sqlx error.
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
}

/// Repository facade. Cheaply cloneable (holds an `Arc` to the pool).
#[derive(Debug, Clone)]
pub struct ProjectRepo {
    pool: DbPool,
}

impl ProjectRepo {
    /// Construct a new repository backed by `pool`.
    #[must_use]
    pub fn new(pool: DbPool) -> Self {
        Self { pool }
    }

    /// Insert a new project. Returns the persisted record.
    ///
    /// # Errors
    ///
    /// - [`ProjectError::EmptyName`] when the name is blank after trimming.
    /// - [`ProjectError::RelativeRoot`] when the path is not absolute.
    /// - [`ProjectError::DuplicateRoot`] when another project owns the same root.
    pub async fn create(&self, input: NewProject) -> Result<ProjectRecord, ProjectError> {
        let name = input.name.trim().to_owned();
        if name.is_empty() {
            return Err(ProjectError::EmptyName);
        }
        if !input.root.is_absolute() {
            return Err(ProjectError::RelativeRoot(input.root));
        }

        let id = Uuid::now_v7().to_string();
        let now_ms = Utc::now().timestamp_millis();
        let now = Utc
            .timestamp_millis_opt(now_ms)
            .single()
            .unwrap_or_else(Utc::now);
        let root_str = path_to_str(&input.root);

        let res = sqlx::query(
            "INSERT INTO projects (id, name, root, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?4)",
        )
        .bind(&id)
        .bind(&name)
        .bind(&root_str)
        .bind(now_ms)
        .execute(&self.pool)
        .await;

        match res {
            Ok(_) => Ok(ProjectRecord {
                id,
                name,
                root: input.root,
                pre_worktree_script: None,
                created_at: now,
                updated_at: now,
            }),
            Err(sqlx::Error::Database(db_err)) if is_unique_violation(db_err.as_ref()) => {
                Err(ProjectError::DuplicateRoot(input.root))
            }
            Err(e) => Err(ProjectError::Db(e)),
        }
    }

    /// Fetch a project by id.
    ///
    /// # Errors
    ///
    /// Returns [`ProjectError::NotFound`] when no row matches.
    pub async fn get(&self, id: &str) -> Result<ProjectRecord, ProjectError> {
        let row: Option<ProjectRow> = sqlx::query_as(
            "SELECT id, name, root, pre_worktree_script, created_at, updated_at \
             FROM projects WHERE id = ?1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;

        row.map(row_to_record)
            .ok_or_else(|| ProjectError::NotFound(id.to_owned()))
    }

    /// List all projects ordered by creation time (oldest first).
    ///
    /// # Errors
    ///
    /// Returns the underlying sqlx error.
    pub async fn list(&self) -> Result<Vec<ProjectRecord>, ProjectError> {
        let rows: Vec<ProjectRow> = sqlx::query_as(
            "SELECT id, name, root, pre_worktree_script, created_at, updated_at \
             FROM projects ORDER BY created_at ASC, id ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(row_to_record).collect())
    }

    /// Update the project-level pre-worktree script. Passing `None`
    /// clears the field (the BE will then fall back to whatever the
    /// per-worktree dialog requests, which may itself be empty).
    ///
    /// # Errors
    ///
    /// - [`ProjectError::NotFound`] if no row matches `id`.
    /// - [`ProjectError::Db`] for any underlying sqlx failure.
    pub async fn update_pre_worktree_script(
        &self,
        id: &str,
        script: Option<&str>,
    ) -> Result<ProjectRecord, ProjectError> {
        let now_ms = Utc::now().timestamp_millis();
        // Treat whitespace-only as a clear so the UI's "leave blank to
        // unset" affordance round-trips cleanly through the JSON layer.
        let normalised = script.map(str::trim).filter(|s| !s.is_empty());
        let res = sqlx::query(
            "UPDATE projects \
             SET pre_worktree_script = ?1, updated_at = ?2 \
             WHERE id = ?3",
        )
        .bind(normalised)
        .bind(now_ms)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if res.rows_affected() == 0 {
            return Err(ProjectError::NotFound(id.to_owned()));
        }
        self.get(id).await
    }

    /// Delete a project by id. Returns whether a row was removed.
    ///
    /// # Errors
    ///
    /// Returns the underlying sqlx error.
    pub async fn delete(&self, id: &str) -> Result<bool, ProjectError> {
        let res = sqlx::query("DELETE FROM projects WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected() == 1)
    }
}

/// Row tuple shape returned by every `SELECT` against `projects`.
/// Centralising the type alias keeps the column order in sync between
/// queries and `row_to_record`.
type ProjectRow = (String, String, String, Option<String>, i64, i64);

fn row_to_record(r: ProjectRow) -> ProjectRecord {
    let (id, name, root, pre_worktree_script, created_ms, updated_ms) = r;
    ProjectRecord {
        id,
        name,
        root: PathBuf::from(root),
        pre_worktree_script,
        created_at: Utc
            .timestamp_millis_opt(created_ms)
            .single()
            .unwrap_or_else(Utc::now),
        updated_at: Utc
            .timestamp_millis_opt(updated_ms)
            .single()
            .unwrap_or_else(Utc::now),
    }
}

fn path_to_str(p: &Path) -> String {
    // SQLite stores UTF-8; on Windows non-Unicode paths fall back to lossy
    // representation. Real paths in a dev workspace are UTF-8 in practice.
    p.to_string_lossy().into_owned()
}

fn is_unique_violation(err: &dyn sqlx::error::DatabaseError) -> bool {
    is_unique_violation_pub(err)
}

/// Crate-internal helper: returns true for SQLite UNIQUE constraint
/// violations. Exposed to sibling modules in this crate.
pub(crate) fn is_unique_violation_pub(err: &dyn sqlx::error::DatabaseError) -> bool {
    if let Some(code) = err.code() {
        if code == "2067" || code == "1555" {
            return true;
        }
    }
    err.message().contains("UNIQUE constraint failed")
}
