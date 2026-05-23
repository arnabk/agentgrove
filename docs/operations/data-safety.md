# Data safety: backup, restore, recover

AgentGrove stores everything important in one SQLite file:
`<state_dir>/agentgrove.sqlite`. This page is the survival guide for
the times you (or a bug) corrupt it.

> If you've never read ADR-0007, do that first. It explains *why*
> the rules below exist.

## TL;DR

```
just backups                       # List rollback points.
just restore-db <SNAPSHOT_NAME>    # Restore one of them.
```

The server takes a snapshot on **every startup** AND a separate
snapshot **before every migration run**. You have to actively go
out of your way to lose data.

## How snapshots work

`<state_dir>/backups/` contains directories named
`db-<UTC-ts>[-tag]`. Each directory is a self-contained copy of
`agentgrove.sqlite` plus its WAL companions (`-wal`, `-shm`),
taken atomically while the server was idle. Tags surfaced today:

| Tag             | Created by                                    |
| --------------- | --------------------------------------------- |
| *(none)*        | Startup safety net (every `just dev` boot).   |
| `pre-migrate`   | Just before `sqlx::migrate!` runs new files.  |
| `pre-restore`   | By `just restore-db`, before overwriting.     |

Snapshots are pruned to the 10 newest (`MAX_DB_BACKUPS`).

## When to restore

* "I lost my chats after the last update." → restore the snapshot
  whose timestamp is just before the last update.
* "Migration aborted with a checksum error on boot." → the BE
  refuses to boot AND prints the path of the pre-migrate snapshot
  in stderr. Restore it, then revert the migration file edit (see
  next section).
* "I deleted `agentgrove.sqlite` by mistake." → restore any
  snapshot.

## When to NOT restore

* You ran the server normally and it lost data without an error.
  → File a bug. Restoring blindly will mask the cause.
* You're trying to "downgrade" to an older app version. → Restore
  won't help; older app versions may refuse to read a DB with
  newer migrations applied.

## How to restore

1. **Stop the BE** if it's running (`Ctrl+C` the dev shell, or kill
   the `agentgrove-server` process). `just restore-db` will refuse
   to overwrite a live DB.
2. List your snapshots:
   ```
   just backups
   ```
3. Pick one + restore. The script asks you to type the snapshot
   name exactly so a fat-fingered tab-complete can't wipe your
   current state:
   ```
   just restore-db db-20260522-064556
   ```
4. The current DB is itself snapshotted as `db-<ts>-pre-restore`
   before the swap. If the chosen snapshot turns out wrong, you can
   restore the `pre-restore` snapshot to undo.
5. Start the BE again (`just dev`) and verify your data.

## Why this set of rules

See [ADR-0007](../adr/0007-data-persistence-and-migrations.md). In
short: migrations are forward-only, edits to applied migrations
are blocked by both a git pre-commit hook and a CI workflow, and
the BE takes a snapshot before every migration so even a CI miss
is recoverable.

## Migration discipline (cheat sheet)

* You edited `0008_provider_secrets.sql` after merging it. The
  pre-commit hook should stop you locally; CI definitely will.
  Revert your edit and add `0010_my_change.sql` instead.
* You added `0009_foo.sql` but haven't committed it yet. Edits are
  fine until it's been applied (the hook checks
  `_sqlx_migrations` on your local DB).
* You renamed a column in an applied migration. Don't. Add a new
  migration that does `ALTER TABLE foo RENAME COLUMN ...`.
* You want to delete an old migration entirely. Don't, even if
  no-one applied it. Future devs will pull and re-apply from
  scratch; missing files break their `cargo build`.

## Surfacing snapshots in the UI

A future task adds a Settings → Backups panel that lists snapshots
and exposes a "Restore" button (with the same confirm flow). For
now, `just backups` + `just restore-db` are the supported
operator interface.
