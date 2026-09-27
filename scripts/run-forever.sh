#!/usr/bin/env bash
# run-forever.sh — keep AgentGrove running until manually stopped.
#
# Serves the built FE bundle same-origin from the Rust backend, and
# auto-restarts the process if it ever exits. Stop with:
#   kill "$(cat .data/run-forever.pid)"
# or Ctrl+C if running in the foreground.

set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

eval "$(mise env -s bash 2>/dev/null)" || true
if [ -d "$HOME/.cargo/bin" ]; then
  PATH="$HOME/.cargo/bin:$PATH"
fi
export PATH

BE_PORT="${AGENTGROVE_PORT:-4317}"
STATIC_DIR="$REPO/apps/web/dist"
LOG_DIR="$REPO/.data/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/agentgrove.log"
BIN="$REPO/target/debug/agentgrove"

echo "$$" > "$REPO/.data/run-forever.pid"

cleanup() {
  trap '' INT TERM
  echo "[run-forever] shutting down..."
  if [ -n "${CHILD:-}" ]; then
    kill "$CHILD" 2>/dev/null || true
    sleep 1
    kill -9 "$CHILD" 2>/dev/null || true
  fi
  rm -f "$REPO/.data/run-forever.pid"
  exit 0
}
trap cleanup INT TERM

echo "[run-forever] supervising agentgrove on http://127.0.0.1:$BE_PORT (pid $$)"
while true; do
  AGENTGROVE_PORT="$BE_PORT" AGENTGROVE_STATIC_DIR="$STATIC_DIR" "$BIN" >>"$LOG" 2>&1 &
  CHILD=$!
  echo "[run-forever] started backend pid=$CHILD $(date)" | tee -a "$LOG"
  wait "$CHILD"
  code=$?
  echo "[run-forever] backend exited code=$code; restarting in 2s $(date)" | tee -a "$LOG"
  sleep 2
done
