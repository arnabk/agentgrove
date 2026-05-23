#!/usr/bin/env bash
# Lists DB snapshot directories under .data/backups, newest first, with
# byte size + age. Used as a quick "what can I roll back to?" check.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUPS_DIR="${REPO_ROOT}/.data/backups"

if [[ ! -d "${BACKUPS_DIR}" ]]; then
  echo "No backups directory at ${BACKUPS_DIR}."
  echo "The server creates snapshots on every startup; run it at least once."
  exit 0
fi

printf '%-40s  %10s  %s\n' "SNAPSHOT" "SIZE" "AGE"
printf '%-40s  %10s  %s\n' "--------" "----" "---"

# Sort newest first. We avoid `mapfile` because macOS still ships
# bash 3.2 (no associative arrays or mapfile); a plain while-read
# loop keeps the script portable across the supported OSes.
while IFS= read -r name; do
  [[ -z "${name}" ]] && continue
  path="${BACKUPS_DIR}/${name}"
  [[ -d "${path}" ]] || continue
  size=$(du -sh "${path}" 2>/dev/null | awk '{print $1}')
  # macOS `date -r` accepts an mtime epoch via `stat -f %m`.
  if stat -f '%m' "${path}" > /dev/null 2>&1; then
    mtime=$(stat -f '%m' "${path}")
  else
    mtime=$(stat -c '%Y' "${path}")
  fi
  now=$(date +%s)
  age_s=$((now - mtime))
  if (( age_s < 60 )); then
    age="${age_s}s ago"
  elif (( age_s < 3600 )); then
    age="$((age_s / 60))m ago"
  elif (( age_s < 86400 )); then
    age="$((age_s / 3600))h ago"
  else
    age="$((age_s / 86400))d ago"
  fi
  printf '%-40s  %10s  %s\n' "${name}" "${size}" "${age}"
done < <(ls -1t "${BACKUPS_DIR}" 2>/dev/null || true)

echo
echo "Restore with: just restore-db <SNAPSHOT>"
