#!/usr/bin/env bash
# Restore the agentgrove.sqlite (+ WAL companions) from a snapshot
# directory under .data/backups. The current DB is snapshotted to
# `db-<ts>-pre-restore` FIRST so the restore can itself be undone.
#
# Usage:
#   just restore-db db-20260522-064556
#
# Safety:
#   * Refuses to run while the BE server is bound to 127.0.0.1:4317
#     (would either fail because WAL is locked, or corrupt the
#     restored copy as the server keeps writing).
#   * Asks for confirmation; type the exact snapshot name to proceed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${REPO_ROOT}/.data"
BACKUPS_DIR="${STATE_DIR}/backups"

if [[ $# -lt 1 ]]; then
  echo "Usage: just restore-db <SNAPSHOT>" >&2
  echo "       Use 'just backups' to list available snapshots." >&2
  exit 1
fi

SNAPSHOT="${1}"
SNAPSHOT_DIR="${BACKUPS_DIR}/${SNAPSHOT}"

if [[ ! -d "${SNAPSHOT_DIR}" ]]; then
  echo "Snapshot directory not found: ${SNAPSHOT_DIR}" >&2
  echo "Run 'just backups' to see what's available." >&2
  exit 1
fi
if [[ ! -f "${SNAPSHOT_DIR}/agentgrove.sqlite" ]]; then
  echo "Snapshot ${SNAPSHOT} is missing agentgrove.sqlite (corrupt?)." >&2
  exit 1
fi

# Refuse if the BE looks alive on its default loopback port — the
# WAL would be in flight and writing a copy under it would corrupt
# both ends.
if curl -fsS --max-time 1 http://127.0.0.1:4317/api/health > /dev/null 2>&1; then
  echo "Refusing to restore: AgentGrove server is running on 127.0.0.1:4317." >&2
  echo "Stop it first (Ctrl+C the dev shell, or kill the process), then retry." >&2
  exit 1
fi

# Big-letter confirmation. We don't want a fat-fingered tab-complete
# to wipe the current state silently.
echo
echo "About to restore: ${SNAPSHOT}"
echo "  Source : ${SNAPSHOT_DIR}"
echo "  Target : ${STATE_DIR}/agentgrove.sqlite (+ -wal / -shm)"
echo
echo "Current DB will be backed up first as db-<ts>-pre-restore."
echo "Type the snapshot name exactly to confirm:"
read -r CONFIRM
if [[ "${CONFIRM}" != "${SNAPSHOT}" ]]; then
  echo "Confirmation did not match. Aborting." >&2
  exit 1
fi

# Snapshot the current state ourselves so the restore is reversible.
# Mirrors what `snapshot_db_to_backups_tagged` does in BE code but
# we can't easily call it from a shell — duplicate the few lines.
TS=$(date -u +"%Y%m%d-%H%M%S")
PRE_RESTORE_DIR="${BACKUPS_DIR}/db-${TS}-pre-restore"
mkdir -p "${PRE_RESTORE_DIR}"
for suffix in "" "-wal" "-shm"; do
  src="${STATE_DIR}/agentgrove.sqlite${suffix}"
  if [[ -f "${src}" ]]; then
    cp -p "${src}" "${PRE_RESTORE_DIR}/agentgrove.sqlite${suffix}"
  fi
done
echo "Wrote pre-restore snapshot: ${PRE_RESTORE_DIR}"

# Remove existing live DB + companions, then copy the snapshot in.
for suffix in "" "-wal" "-shm"; do
  rm -f "${STATE_DIR}/agentgrove.sqlite${suffix}"
done
for suffix in "" "-wal" "-shm"; do
  src="${SNAPSHOT_DIR}/agentgrove.sqlite${suffix}"
  if [[ -f "${src}" ]]; then
    cp -p "${src}" "${STATE_DIR}/agentgrove.sqlite${suffix}"
  fi
done

echo "Restored. Start the BE with 'just dev' to verify."
