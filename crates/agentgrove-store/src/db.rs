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

/// Run migrations defensively from a known state directory.
///
/// This is the user-facing entrypoint server bootstrap should use
/// (rather than [`run_migrations`] directly). It:
///
///   1. Takes a SAFETY snapshot of the DB tagged
///      `db-<ts>-pre-migrate` ONLY when there's pending work to
///      do. This means routine restarts don't bloat the backups
///      directory, but anything that's about to mutate schema gets
///      a guaranteed rollback point.
///   2. Runs migrations and translates the dreaded "applied
///      migration has a different checksum" failure into a
///      human-readable error that names the offending file + the
///      snapshot the user can recover from.
///
/// Returns whether a snapshot was actually taken (so callers can
/// log it).
///
/// # Errors
///
/// Returns a domain-specific [`MigrationError`] with actionable
/// detail. Underlying sqlx errors are wrapped, not swallowed.
pub async fn run_migrations_safely(
    pool: &DbPool,
    state_dir: impl AsRef<Path>,
) -> Result<bool, MigrationError> {
    let state_dir = state_dir.as_ref();
    let need_snapshot = has_pending_migrations(pool).await?;
    let snapshot_taken = if need_snapshot {
        snapshot_db_to_backups_tagged(state_dir, "pre-migrate").is_some()
    } else {
        false
    };

    match sqlx::migrate!("./migrations").run(pool).await {
        Ok(()) => Ok(snapshot_taken),
        Err(e) => Err(classify_migrate_error(e, state_dir)),
    }
}

/// Turn a `sqlx::migrate::MigrateError` into a typed
/// [`MigrationError`] for the operator. We pattern-match the
/// dedicated sqlx variants first (`VersionMismatch`,
/// `VersionMissing`, `Dirty`) and fall back to the substring
/// classifier for anything sqlx doesn't surface structurally —
/// older sqlx releases stringified these and we still want
/// to catch them. Keeping the fallback also future-proofs the
/// classifier against new variants we haven't yet named.
fn classify_migrate_error(e: sqlx::migrate::MigrateError, state_dir: &Path) -> MigrationError {
    use sqlx::migrate::MigrateError as M;
    let snapshot_hint = latest_snapshot_path(state_dir);
    match e {
        M::VersionMismatch(_) | M::Dirty(_) => MigrationError::ChecksumMismatch {
            detail: e.to_string(),
            snapshot_hint,
        },
        M::VersionMissing(_) => MigrationError::MissingMigration {
            detail: e.to_string(),
            snapshot_hint,
        },
        other => {
            let msg = other.to_string().to_lowercase();
            if msg.contains("checksum") || msg.contains("dirty") {
                MigrationError::ChecksumMismatch {
                    detail: other.to_string(),
                    snapshot_hint,
                }
            } else if msg.contains("missing") || msg.contains("version") {
                MigrationError::MissingMigration {
                    detail: other.to_string(),
                    snapshot_hint,
                }
            } else {
                MigrationError::Sqlx(Box::new(other))
            }
        }
    }
}

/// Returns true iff there's at least one migration file the DB
/// hasn't applied yet. Used to skip the pre-migrate snapshot on the
/// common "nothing changed, just restarting" case.
async fn has_pending_migrations(pool: &DbPool) -> Result<bool, MigrationError> {
    let migrator = sqlx::migrate!("./migrations");
    // `_sqlx_migrations` may not exist yet on a brand-new DB; in
    // that case every embedded migration is pending by definition.
    let applied: Vec<i64> = sqlx::query_scalar("SELECT version FROM _sqlx_migrations")
        .fetch_all(pool)
        .await
        .unwrap_or_default();
    let applied: std::collections::HashSet<i64> = applied.into_iter().collect();
    Ok(migrator.iter().any(|m| !applied.contains(&(m.version))))
}

fn latest_snapshot_path(state_dir: &Path) -> Option<std::path::PathBuf> {
    let backups_dir = state_dir.join("backups");
    let mut entries: Vec<_> = std::fs::read_dir(&backups_dir)
        .ok()?
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().starts_with("db-"))
        .collect();
    entries.sort_by_key(|e| e.file_name());
    entries.last().map(|e| e.path())
}

/// Migration failure surfaced by [`run_migrations_safely`]. Each
/// variant carries enough detail for the operator to recover
/// without re-reading the sqlx docs.
#[derive(Debug, thiserror::Error)]
pub enum MigrationError {
    /// An applied migration file on disk has changed since it was
    /// run. This is the #1 cause of dev-time data loss in this
    /// project: editing `0008_*.sql` after it shipped meant sqlx
    /// refused to boot, the operator wiped the DB to recover, and
    /// every chat / queue / layout blob went with it.
    ///
    /// Recovery path the message points at: restore from the
    /// latest snapshot (which is from BEFORE the bad edit), revert
    /// the offending migration file, and create a NEW migration
    /// (e.g. `0010_fix_thing.sql`) that does the change forward-
    /// only.
    #[error(
        "applied migration's checksum no longer matches disk — \
         you've edited a migration that's already been run.\n\n\
         What to do:\n\
           1. `cp <snapshot>/agentgrove.sqlite* .data/` to restore.\n\
           2. `git checkout -- crates/agentgrove-store/migrations/` to revert your edit.\n\
           3. Add a NEW migration with the change you wanted (e.g. `0010_foo.sql`).\n\n\
         Latest snapshot: {snapshot_hint:?}\n\
         sqlx detail: {detail}"
    )]
    ChecksumMismatch {
        detail: String,
        snapshot_hint: Option<std::path::PathBuf>,
    },
    /// The DB has applied a migration version that doesn't exist on
    /// disk (someone deleted a migration file after applying it).
    #[error(
        "DB has applied a migration version that's missing on disk — \
         you've deleted a migration file that was already run.\n\n\
         Restore from the latest snapshot ({snapshot_hint:?}) or \
         restore the deleted migration file from git.\n\n\
         sqlx detail: {detail}"
    )]
    MissingMigration {
        detail: String,
        snapshot_hint: Option<std::path::PathBuf>,
    },
    /// Pass-through for everything else sqlx could throw at us.
    #[error("sqlx migrate: {0}")]
    Sqlx(Box<sqlx::migrate::MigrateError>),
}

/// Like [`snapshot_db_to_backups`] but lets the caller tag the
/// snapshot with a reason suffix (`pre-migrate`, `manual`,
/// `pre-restore`, ...) so a forensic walk of `backups/` shows what
/// each one was taken for.
pub fn snapshot_db_to_backups_tagged(
    state_dir: impl AsRef<Path>,
    tag: &str,
) -> Option<std::path::PathBuf> {
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
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let safe_tag: String = tag
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let dest_dir = if safe_tag.is_empty() {
        backups_dir.join(format!("db-{stamp}"))
    } else {
        backups_dir.join(format!("db-{stamp}-{safe_tag}"))
    };
    if let Err(e) = std::fs::create_dir_all(&dest_dir) {
        tracing::warn!(error = %e, "could not create snapshot dir");
        return None;
    }
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
        .filter(|e| e.file_name().to_string_lossy().starts_with("db-"))
        .collect();
    entries.sort_by_key(|e| e.file_name());
    while entries.len() > keep {
        let victim = entries.remove(0);
        let _ = std::fs::remove_dir_all(victim.path());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Happy path: running migrations on a fresh DB writes a
    /// pre-migrate snapshot (because every embedded migration is
    /// pending) and returns Ok.
    #[tokio::test]
    async fn safely_writes_pre_migrate_snapshot_on_first_run() {
        let tmp = tempfile::tempdir().unwrap();
        // Touch the DB file so the snapshot helper has something
        // to copy. open_pool would create it on demand but we
        // need a concrete file BEFORE the snapshot call.
        std::fs::write(tmp.path().join("agentgrove.sqlite"), b"").unwrap();
        let pool = open_pool(tmp.path()).await.unwrap();
        let snap_taken = run_migrations_safely(&pool, tmp.path()).await.unwrap();
        assert!(snap_taken, "pre-migrate snapshot should fire on first run");
        let backups = std::fs::read_dir(tmp.path().join("backups"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(
            backups.iter().any(|b| b.contains("-pre-migrate")),
            "expected db-<ts>-pre-migrate in {backups:?}"
        );
    }

    /// Idempotent: running migrations a second time finds nothing
    /// pending and skips the snapshot. This keeps the backups dir
    /// from bloating on routine server restarts.
    #[tokio::test]
    async fn safely_skips_snapshot_when_nothing_pending() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("agentgrove.sqlite"), b"").unwrap();
        let pool = open_pool(tmp.path()).await.unwrap();
        run_migrations_safely(&pool, tmp.path()).await.unwrap();
        // Count snapshots after the first run, then check the
        // count doesn't grow on the second run.
        let before = std::fs::read_dir(tmp.path().join("backups"))
            .unwrap()
            .count();
        let snap_taken = run_migrations_safely(&pool, tmp.path()).await.unwrap();
        assert!(!snap_taken, "no new snapshot expected on no-op run");
        let after = std::fs::read_dir(tmp.path().join("backups"))
            .unwrap()
            .count();
        assert_eq!(before, after, "backups dir unexpectedly grew");
    }

    /// Manual `snapshot_db_to_backups_tagged` reachable from a
    /// pure-Rust caller (the FE Backups panel uses this via the
    /// HTTP API).
    #[test]
    fn snapshot_tagged_creates_directory_with_tag_in_name() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("agentgrove.sqlite"), b"hello").unwrap();
        let path = snapshot_db_to_backups_tagged(tmp.path(), "manual").unwrap();
        assert!(path.is_dir());
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            name.starts_with("db-") && name.ends_with("-manual"),
            "unexpected name: {name}"
        );
        // Sibling main.sqlite copied.
        assert!(path.join("agentgrove.sqlite").is_file());
    }

    /// Tag-illegal characters get scrubbed.
    #[test]
    fn snapshot_tag_strips_unsafe_chars() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("agentgrove.sqlite"), b"x").unwrap();
        let path = snapshot_db_to_backups_tagged(tmp.path(), "evil/../tag").unwrap();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        // No path separator survived.
        assert!(!name.contains('/'));
        assert!(!name.contains(".."));
    }

    /// Latest-snapshot lookup helper rolls forward when the dir
    /// has multiple entries.
    #[test]
    fn latest_snapshot_path_picks_newest_by_name() {
        let tmp = tempfile::tempdir().unwrap();
        let backups = tmp.path().join("backups");
        std::fs::create_dir_all(&backups).unwrap();
        std::fs::create_dir_all(backups.join("db-20260520-000000")).unwrap();
        std::fs::create_dir_all(backups.join("db-20260522-000000")).unwrap();
        std::fs::create_dir_all(backups.join("db-20260521-000000-pre-migrate")).unwrap();
        let latest = latest_snapshot_path(tmp.path()).unwrap();
        let name = latest.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(name, "db-20260522-000000");
    }
}

#[cfg(test)]
mod migration_failure_tests {
    use super::*;
    use sqlx::Executor;

    /// Simulate the "applied migration's checksum no longer matches
    /// disk" scenario: run migrations once, then poison a row in
    /// _sqlx_migrations so the next run sees a mismatch. The wrapper
    /// must translate the failure into ChecksumMismatch with the
    /// snapshot hint populated (so the operator knows how to recover).
    #[tokio::test]
    async fn checksum_mismatch_returns_structured_error_with_hint() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("agentgrove.sqlite"), b"").unwrap();
        let pool = open_pool(tmp.path()).await.unwrap();
        run_migrations_safely(&pool, tmp.path()).await.unwrap();

        // Poison the first applied migration's checksum. sqlx
        // stores BLOB checksums in `_sqlx_migrations.checksum` —
        // overwriting with zeros guarantees a mismatch on the
        // next migration run.
        pool.execute("UPDATE _sqlx_migrations SET checksum = X'00' WHERE version = 1")
            .await
            .unwrap();

        let err = run_migrations_safely(&pool, tmp.path()).await.unwrap_err();
        match err {
            MigrationError::ChecksumMismatch { snapshot_hint, .. } => {
                assert!(
                    snapshot_hint.is_some(),
                    "ChecksumMismatch must carry a snapshot hint so the operator can roll back",
                );
            }
            other => panic!("expected ChecksumMismatch, got {other:?}"),
        }
    }

    /// Sanity: a snapshot is still written before the wrapper
    /// detects the failure, so the pre-migrate copy of the
    /// pre-corruption state is on disk.
    #[tokio::test]
    async fn pre_migrate_snapshot_exists_after_failed_run() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("agentgrove.sqlite"), b"").unwrap();
        let pool = open_pool(tmp.path()).await.unwrap();
        run_migrations_safely(&pool, tmp.path()).await.unwrap();
        // The successful run already wrote a snapshot; capture
        // the latest BEFORE we corrupt the DB so we can compare.
        let before_corrupt = latest_snapshot_path(tmp.path()).unwrap();
        // Corrupt the checksum + retry; failure should leave the
        // snapshot directory untouched (we don't take a second
        // snapshot when there are no pending migrations).
        pool.execute("UPDATE _sqlx_migrations SET checksum = X'00' WHERE version = 1")
            .await
            .unwrap();
        let _ = run_migrations_safely(&pool, tmp.path()).await;
        // Same latest snapshot — checksum mismatch fires AFTER the
        // pending check, and pending was empty.
        let after = latest_snapshot_path(tmp.path()).unwrap();
        assert_eq!(before_corrupt, after);
    }
}
