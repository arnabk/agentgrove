#!/usr/bin/env bash
# dev-be.sh — run only the backend with the project-pinned Rust toolchain,
# regardless of whether a system/brew Rust is earlier on PATH.

set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

if [ -d "$HOME/.cargo/bin" ]; then PATH="$HOME/.cargo/bin:$PATH"; fi
if [ -d "/opt/homebrew/opt/rustup/bin" ]; then PATH="/opt/homebrew/opt/rustup/bin:$PATH"; fi
export PATH

exec cargo run -p agentgrove-server
