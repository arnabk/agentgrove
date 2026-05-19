//! Database pool and migration runner.

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::path::Path;
use std::str::FromStr;

/// Shared SQLite pool used by all repositories.
pub type DbPool = SqlitePool;

/// Open (or create) the database file under `state_dir/agentgrove.sqlite`.
///
/// The file is created with WAL journaling for better concurrent reads.
///
/// # Errors
///
/// Returns any underlying sqlx error.
pub async fn open_pool(state_dir: impl AsRef<Path>) -> Result<DbPool, sqlx::Error> {
    let path = state_dir.as_ref().join("agentgrove.sqlite");
    // Ensure parent dir exists. `create_dir_all` is a no-op if present.
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(sqlx::Error::Io)?;
    }
    let url = format!("sqlite://{}?mode=rwc", path.display());
    let opts = SqliteConnectOptions::from_str(&url)?
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_secs(5));

    SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await
}

/// Run all pending migrations against `pool`.
///
/// Migrations are embedded at build time from `crates/agentgrove-store/migrations/`.
///
/// # Errors
///
/// Returns the underlying sqlx migration error.
pub async fn run_migrations(pool: &DbPool) -> Result<(), sqlx::migrate::MigrateError> {
    sqlx::migrate!("./migrations").run(pool).await
}
