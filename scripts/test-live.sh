#!/usr/bin/env bash
# test-live.sh — full-stack live run.
#
# Boots the BE and FE on ephemeral ports (no auth), asserts every
# shipped feature via Playwright, and exits non-zero on failure.

set +u  # arrays + bash 3 on macOS are unfriendly to `set -u`

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

# Toolchain PATH.
[ -d "$HOME/.cargo/bin" ] && PATH="$HOME/.cargo/bin:$PATH"
[ -d "/opt/homebrew/opt/rustup/bin" ] && PATH="/opt/homebrew/opt/rustup/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  for v in v24.6.0 v22.11.0 v20.10.0; do
    [ -x "$HOME/.nvm/versions/node/$v/bin/node" ] && PATH="$HOME/.nvm/versions/node/$v/bin:$PATH" && break
  done
fi
export PATH

LOG_DIR="$REPO/.data/logs"

cleanup() {
  trap '' INT TERM EXIT
  [ -n "${BE_PID:-}" ] && kill "$BE_PID" 2>/dev/null || true
  [ -n "${FE_PID:-}" ] && kill "$FE_PID" 2>/dev/null || true
  sleep 1
  [ -n "${BE_PID:-}" ] && kill -9 "$BE_PID" 2>/dev/null || true
  [ -n "${FE_PID:-}" ] && kill -9 "$FE_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
}

BE_PORT="$(free_port)"
FE_PORT="$(free_port)"

rm -rf "$REPO/.data"
mkdir -p "$LOG_DIR"
BE_LOG="$LOG_DIR/live-backend.log"
FE_LOG="$LOG_DIR/live-frontend.log"

echo "[live] building backend..."
cargo build --release -p agentgrove-server
echo "[live] building frontend..."
pnpm -C apps/web build

echo "[live] starting backend on :$BE_PORT"
AGENTGROVE_STATE_DIR="$REPO/.data" \
AGENTGROVE_BIND="127.0.0.1" \
AGENTGROVE_PORT="$BE_PORT" \
AGENTGROVE_ENABLE_FAKE=1 \
AGENTGROVE_STATIC_DIR="$REPO/apps/web/dist" \
  "$REPO/target/release/agentgrove" >"$BE_LOG" 2>&1 &
BE_PID=$!

FE_PORT=$BE_PORT

# Wait for both to listen.
for _ in {1..30}; do
  if curl -fsS --max-time 1 "http://localhost:$FE_PORT" >/dev/null 2>&1 && \
     curl -fsS --max-time 1 "http://127.0.0.1:$BE_PORT/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.5
done

if [ -z "${READY:-}" ]; then
  echo "ERROR: Servers failed to start."
  echo "--- backend log ---"; tail -30 "$BE_LOG"
  echo "--- frontend log ---"; tail -30 "$FE_LOG"
  exit 1
fi

echo "[live] running browser tests..."
BASE_URL="http://localhost:$FE_PORT" PW_LIVE=1 \
  AGENTGROVE_BE_URL="http://127.0.0.1:$BE_PORT" \
  REPO_ROOT="$REPO" \
  pnpm -C apps/web exec playwright test --reporter=line >"$LOG_DIR/live-playwright.log" 2>&1
PW_EXIT=$?

if [ "$PW_EXIT" -eq 0 ]; then
  echo "================ LIVE TESTS PASSED ================"
else
  echo "================ LIVE TESTS FAILED ================"
  echo "--- playwright log (tail) ---"
  tail -50 "$LOG_DIR/live-playwright.log" || true
  exit "$PW_EXIT"
fi
