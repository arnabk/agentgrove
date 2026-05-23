# ADR-0007: Data persistence + migration discipline

Status: Accepted (2026-05-22)

## Context

AgentGrove is a **local-first** desktop product. The entire system of
record — chats, queue items, layout, provider secrets, notes, project
configuration — lives in `<state_dir>/agentgrove.sqlite`. Customers
won't tolerate "we lost your data when you updated".

During pre-1.0 development we hit several incidents where editing an
already-applied migration file caused sqlx to refuse to boot. The
common-but-wrong recovery was to delete `agentgrove.sqlite` and start
fresh — taking every chat / queue / layout with it. By the time we'd
written ADR-0007 we'd lost real chat history twice.

This ADR codifies the rules + the mechanical guards that enforce
them so this class of incident becomes impossible.

## Decision

### 1. Migrations are forward-only and immutable after merge.

Once a migration file is merged to `main`, it MUST NOT be edited.
Schema/data fixes go in a new file (`00NN_fix_thing.sql`) that does
the change forward-only.

Rationale: sqlx stores a checksum of every applied migration in
`_sqlx_migrations.checksum`. Editing an applied migration changes
the checksum, causing the next `sqlx::migrate!` call to refuse to
run. The default user response (wiping the DB) is unacceptable.

Enforcement:
  * **Pre-commit hook** (`scripts/git-hooks/pre-commit`, wired by
    `just setup`): refuses local commits that modify a migration
    whose version is already in the developer's
    `_sqlx_migrations` table.
  * **CI workflow** (`.github/workflows/migrations.yml`): refuses
    PRs that change the bytes of any migration file that existed
    on the base branch.

### 2. The DB is snapshotted before every migration run.

`run_migrations_safely(pool, state_dir)`:
  1. Detects whether any embedded migration is pending against the
     live DB.
  2. If pending, copies `agentgrove.sqlite` (+ `-wal` / `-shm`) into
     `<state_dir>/backups/db-<UTC-ts>-pre-migrate/` BEFORE running
     `sqlx::migrate!`.
  3. Runs migrations and translates checksum / missing-version
     errors into actionable messages naming the snapshot the
     operator can restore from.

Snapshots are pruned to `MAX_DB_BACKUPS = 10` newest. A botched
migration always has a clean rollback target one `cp` away.

### 3. Restore is a single command.

```
just backups            # List snapshots, newest first.
just restore-db <name>  # Restore from a snapshot.
```

`scripts/db-restore.sh` (+ `.ps1` mirror):
  * Refuses to run while the BE is listening on `127.0.0.1:4317`.
  * Snapshots the CURRENT DB as `db-<ts>-pre-restore` before
    touching anything, so a wrong restore is itself reversible.
  * Asks the operator to type the snapshot name exactly to confirm.

### 4. Field/table semantics are frozen on first customer release.

Once we ship to a paying customer, any column or table observable
from the FE is **frozen**: no renames, no type changes, no
deletions without a multi-release migration plan (`add new column
→ dual-write → backfill → remove old column`).

This is enforced socially today (code review checklist); a future
ADR may add a linter that detects type changes to columns marked
`#[stable]`.

### 5. New backups for risky operations.

`snapshot_db_to_backups_tagged(state_dir, tag)` lets callers take a
named snapshot before any destructive change. Reserved tags:
  * `pre-migrate` — taken automatically before running migrations.
  * `pre-restore` — taken by `just restore-db` before overwriting.
  * `manual` — for future "create snapshot now" UI button.

## Consequences

* Migration churn is more expensive (every fix is a new file), but
  the data loss class disappears.
* Backups directory grows to ~10 × current DB size. At today's
  scale (~1 MB SQLite) this is trivial.
* Pre-commit hook adds a few hundred ms to local commits. The CI
  guard catches anything bypassed via `--no-verify`.
* Restore CLI is shell + powershell (no Rust binary) so it works
  even when the BE itself won't boot.

## Open questions

* Should we add a "snapshot now" button to the Settings UI? Useful
  but not required for the data-safety guarantee.
* Should we encrypt snapshots? Currently they sit in
  `<state_dir>/backups/` with the same permissions as the live DB.
  Provider API keys are still encrypted at rest (the snapshot just
  carries the ciphertext + the keyring file), so this isn't a leak
  vs the live DB.

## References

* `crates/agentgrove-store/src/db.rs`: implementation.
* `scripts/git-hooks/pre-commit`: local guard.
* `.github/workflows/migrations.yml`: CI guard.
* `scripts/db-backups.sh` + `scripts/db-restore.sh`: operator tools.
