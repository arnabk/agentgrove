#!/usr/bin/env bash
# start.sh — start AgentGrove (backend + frontend) for local development.
#
# Defaults:
#   - Backend bound to 127.0.0.1:${AGENTGROVE_PORT:-4317}
#   - Frontend dev server on http://localhost:5173
#   - State dir: <repo>/.data
#   - No auth (loopback-only by default)
#
# Stop with Ctrl+C — both processes are terminated together.
#
# Logs:
#   - .data/logs/backend.log
#   - .data/logs/frontend.log

set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

# Ensure rustup's toolchain wins over a system/brew Rust on PATH.
# rustup pins the project toolchain via rust-toolchain.toml.
if [ -d "$HOME/.cargo/bin" ]; then
  PATH="$HOME/.cargo/bin:$PATH"
fi
if [ -d "/opt/homebrew/opt/rustup/bin" ]; then
  PATH="/opt/homebrew/opt/rustup/bin:$PATH"
fi
# Node from nvm fallback (macOS dev convenience).
if command -v node >/dev/null 2>&1; then
  :
else
  for v in v24.6.0 v22.11.0 v20.10.0; do
    if [ -x "$HOME/.nvm/versions/node/$v/bin/node" ]; then
      PATH="$HOME/.nvm/versions/node/$v/bin:$PATH"
      break
    fi
  done
fi
export PATH

LOG_DIR="$REPO/.data/logs"
mkdir -p "$LOG_DIR"

BE_PORT="${AGENTGROVE_PORT:-4317}"
BE_LOG="$LOG_DIR/backend.log"
FE_LOG="$LOG_DIR/frontend.log"

cleanup() {
  trap '' INT TERM
  echo
  echo "[start] shutting down..."
  if [ -n "${BE_PID:-}" ]; then kill "$BE_PID" 2>/dev/null || true; fi
  if [ -n "${FE_PID:-}" ]; then kill "$FE_PID" 2>/dev/null || true; fi
  sleep 1
  if [ -n "${BE_PID:-}" ]; then kill -9 "$BE_PID" 2>/dev/null || true; fi
  if [ -n "${FE_PID:-}" ]; then kill -9 "$FE_PID" 2>/dev/null || true; fi
  wait 2>/dev/null || true
  echo "[start] stopped"
}
trap cleanup INT TERM EXIT

echo "[start] building backend..."
if ! cargo build -p agentgrove-server >"$BE_LOG" 2>&1; then
  echo "[start] backend build failed; see $BE_LOG"
  tail -40 "$BE_LOG"
  exit 1
fi

echo "[start] launching backend on http://127.0.0.1:$BE_PORT ..."
AGENTGROVE_PORT="$BE_PORT" ./target/debug/agentgrove >>"$BE_LOG" 2>&1 &
BE_PID=$!

# Wait for backend health.
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$BE_PORT/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$BE_PID" 2>/dev/null; then
    echo "[start] backend exited early; tail of log:"
    tail -40 "$BE_LOG"
    exit 1
  fi
  sleep 1
done

echo "[start] backend ready"
echo "[start]   url: http://127.0.0.1:$BE_PORT"
echo "[start]   log: $BE_LOG"

echo "[start] launching frontend..."
pnpm -C apps/web dev >"$FE_LOG" 2>&1 &
FE_PID=$!

# Wait for frontend.
for i in $(seq 1 30); do
  if curl -fsS "http://localhost:5173" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$FE_PID" 2>/dev/null; then
    echo "[start] frontend exited early; tail of log:"
    tail -40 "$FE_LOG"
    exit 1
  fi
  sleep 1
done

echo "[start] frontend ready"
echo "[start]   url: http://localhost:5173"
echo "[start]   log: $FE_LOG"
echo
echo "[start] AgentGrove is running. Press Ctrl+C to stop."

# Block until either child exits.
while kill -0 "$BE_PID" 2>/dev/null && kill -0 "$FE_PID" 2>/dev/null; do
  sleep 1
done

echo "[start] a process exited; tearing down"
exit 0
