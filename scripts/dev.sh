#!/usr/bin/env bash
# dev.sh — start BE + FE with hot reload. Backend rebuilds on Rust changes
# via cargo-watch. Frontend hot-reloads via Vite HMR.

set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

[ -d "$HOME/.cargo/bin" ] && PATH="$HOME/.cargo/bin:$PATH"
[ -d "/opt/homebrew/opt/rustup/bin" ] && PATH="/opt/homebrew/opt/rustup/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  for v in v24.6.0 v22.11.0 v20.10.0; do
    [ -x "$HOME/.nvm/versions/node/$v/bin/node" ] && PATH="$HOME/.nvm/versions/node/$v/bin:$PATH" && break
  done
fi
export PATH

LOG_DIR="$REPO/.data/logs"
mkdir -p "$LOG_DIR"
BE_LOG="$LOG_DIR/dev-backend.log"
FE_LOG="$LOG_DIR/dev-frontend.log"

cleanup() {
  trap '' INT TERM EXIT
  echo
  echo "[dev] shutting down..."
  [ -n "${BE_PID:-}" ] && kill "$BE_PID" 2>/dev/null || true
  [ -n "${FE_PID:-}" ] && kill "$FE_PID" 2>/dev/null || true
  sleep 1
  [ -n "${BE_PID:-}" ] && kill -9 "$BE_PID" 2>/dev/null || true
  [ -n "${FE_PID:-}" ] && kill -9 "$FE_PID" 2>/dev/null || true
  pkill -f "target/debug/agentgrove" 2>/dev/null || true
  wait 2>/dev/null || true
  echo "[dev] stopped"
}
trap cleanup INT TERM EXIT

BE_PORT="${AGENTGROVE_PORT:-4317}"

if ! command -v cargo-watch >/dev/null 2>&1; then
  echo "[dev] installing cargo-watch (one-time)..."
  cargo install --locked cargo-watch
fi

echo "[dev] launching backend on http://127.0.0.1:$BE_PORT with hot reload..."
AGENTGROVE_PORT="$BE_PORT" cargo watch -q -c -w crates \
  -s "cargo run -q -p agentgrove-server" >"$BE_LOG" 2>&1 &
BE_PID=$!

# Wait for backend health.
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$BE_PORT/health" >/dev/null 2>&1; then
    break
  fi
  kill -0 "$BE_PID" 2>/dev/null || { echo "[dev] backend failed; tail of log:"; tail -40 "$BE_LOG"; exit 1; }
  sleep 1
done

echo "[dev] backend ready"
echo "[dev]   url: http://127.0.0.1:$BE_PORT"
echo "[dev]   log: $BE_LOG"

echo "[dev] launching frontend with HMR..."
pnpm -C apps/web dev >"$FE_LOG" 2>&1 &
FE_PID=$!

for i in $(seq 1 30); do
  curl -fsS "http://localhost:5173" >/dev/null 2>&1 && break
  sleep 1
done

echo "[dev] frontend ready"
echo "[dev]   url: http://localhost:5173"
echo "[dev]   log: $FE_LOG"
echo
echo "[dev] hot reload active. Edit code; both BE + FE reload on save."
echo "[dev] Press Ctrl+C to stop."

while kill -0 "$BE_PID" 2>/dev/null && kill -0 "$FE_PID" 2>/dev/null; do
  sleep 1
done
