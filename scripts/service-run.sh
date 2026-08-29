#!/usr/bin/env bash
# service-run.sh — the entry point the OS service manager launches.
#
# It exists so the KeepAlive/Restart supervisor gets a CLEAN start every
# time: if a previous instance's backend or frontend is still holding its
# port (e.g. a fast respawn during a rebuild), that stale listener is
# cleared before we hand off to start.sh. Without this, a respawn can
# collide on :4317 / :5173, the new backend fails to bind, and the
# service thrashes in a restart loop.
#
# Not meant to be run by hand — use scripts/console.sh for an interactive
# run, or scripts/service-install.sh to register it. Kept as a separate
# script (rather than inlined in the plist/unit) so the logic is testable
# and identical across launchd, systemd, and Task Scheduler.

set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

BE_PORT="${AGENTGROVE_PORT:-4317}"
FE_PORT="${AGENTGROVE_FE_PORT:-5173}"

# Free a TCP port owned by a previous, orphaned instance. Only targets
# listeners we can see; never errors if the port is already free.
free_port() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      echo "[service-run] freeing stale listener on :$port (pids: $pids)"
      # shellcheck disable=SC2086
      kill $pids 2>/dev/null || true
      sleep 1
      pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
      # shellcheck disable=SC2086
      [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
    fi
  fi
}

free_port "$BE_PORT"
free_port "$FE_PORT"

# Hand off to the normal runner. exec so signals (SIGTERM from the
# supervisor on stop) reach start.sh directly and it tears down BE+FE.
exec bash "$REPO/scripts/start.sh"
