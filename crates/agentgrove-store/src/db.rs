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

/// Maximum number of snapshot directories `snapshot_db_to_backups`
/// keeps before pruning the oldest. Picked so a few weeks of daily
/// dev iteration won't fill the disk while still leaving a long
/// enough trail to recover from a bad sequence of edits.
pub const MAX_DB_BACKUPS: usize = 10;

/// Take a defensive copy of `agentgrove.sqlite` (+ WAL companions)
/// into `<state_dir>/backups/db-<YYYYMMDD-HHMMSS>/` before the
/// server opens the live pool.
///
/// We do this on every startup because a botched migration during
/// dev iteration (or a corrupted on-disk DB) used to mean the user
/// had to wipe `agentgrove.sqlite` to get the BE back up — losing
/// every chat, queue item, and layout blob. With these snapshots
/// the operator can roll back by copying the most recent backup
/// over `agentgrove.sqlite`.
///
/// Behaviour:
///   * No-op when `agentgrove.sqlite` doesn't exist (fresh install).
///   * Creates `<state_dir>/backups/` if missing.
///   * Copies the main DB file plus any `-wal` / `-shm` siblings so
///     the snapshot is internally consistent.
///   * Prunes oldest snapshots beyond [`MAX_DB_BACKUPS`].
///   * Errors are logged but non-fatal; the caller continues to boot.
///
/// Returns the path of the new snapshot dir, or `None` if no
/// snapshot was taken (fresh install).
pub fn snapshot_db_to_backups(state_dir: impl AsRef<Path>) -> Option<std::path::PathBuf> {
    let state_dir = state_dir.as_ref();
    let main = state_dir.join("agentgrove.sqlite");
    if !main.exists() {
        return None;
    }
    let backups_dir = state_dir.join("backups");
    if let Err(e) = std::fs::create_dir_all(&backups_dir) {
        tracing::warn!(error = %e, "could not create backups dir; skipping snapshot");
        return None;
    }
    // Timestamped folder name. We use a stable %Y%m%d-%H%M%S
    // pattern (sortable alphabetically) so the prune step can
    // sort + drop oldest without parsing.
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let dest_dir = backups_dir.join(format!("db-{stamp}"));
    if let Err(e) = std::fs::create_dir_all(&dest_dir) {
        tracing::warn!(error = %e, "could not create snapshot dir");
        return None;
    }
    // Copy main file + WAL companions. WAL mode keeps an active
    // `-wal` and `-shm` next to the main DB; copying just the
    // main file would lose any committed-but-not-checkpointed
    // pages.
    for suffix in ["", "-wal", "-shm"] {
        let src = state_dir.join(format!("agentgrove.sqlite{suffix}"));
        if !src.exists() {
            continue;
        }
        let dst = dest_dir.join(format!("agentgrove.sqlite{suffix}"));
        if let Err(e) = std::fs::copy(&src, &dst) {
            tracing::warn!(
                src = %src.display(),
                error = %e,
                "snapshot copy failed; backup may be incomplete",
            );
        }
    }
    if let Err(e) = prune_old_backups(&backups_dir, MAX_DB_BACKUPS) {
        tracing::warn!(error = %e, "could not prune old backups");
    }
    Some(dest_dir)
}

/// Drop snapshot folders so at most `keep` remain. Folders are
/// sorted alphabetically (which matches the timestamp ordering of
/// the `db-YYYYMMDD-HHMMSS` naming used above) — newest at the
/// tail, oldest at the head.
fn prune_old_backups(backups_dir: &Path, keep: usize) -> std::io::Result<()> {
    let mut entries: Vec<_> = std::fs::read_dir(backups_dir)?
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("db-")
        })
        .collect();
    entries.sort_by_key(|e| e.file_name());
    while entries.len() > keep {
        let victim = entries.remove(0);
        let _ = std::fs::remove_dir_all(victim.path());
    }
    Ok(())
}
