#!/usr/bin/env bash
# dev-be.sh — run the backend with hot reload via cargo-watch.
# Re-runs the server on every change under crates/.

set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

if [ -d "$HOME/.cargo/bin" ]; then PATH="$HOME/.cargo/bin:$PATH"; fi
if [ -d "/opt/homebrew/opt/rustup/bin" ]; then PATH="/opt/homebrew/opt/rustup/bin:$PATH"; fi
export PATH

if ! command -v cargo-watch >/dev/null 2>&1; then
  echo "[dev-be] installing cargo-watch (one-time)..."
  cargo install --locked cargo-watch
fi

exec cargo watch -q -c -w crates -s "cargo run -q -p agentgrove-server"
