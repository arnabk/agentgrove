#!/usr/bin/env bash
# console.sh — run AgentGrove in the foreground in this terminal.
#
# This is the interactive way to run the app: it builds + launches the
# backend (:4317) and frontend (:5173), streams status, and tears both
# down when you press Ctrl+C. Nothing is installed; when the terminal
# closes, the app stops.
#
# For an install that auto-starts on login and restarts on crash, use
# scripts/service-install.sh instead.
#
#   bash scripts/console.sh
#   # or, via just:  just start
#
# All the real work (PATH pinning for the rustup 1.95 toolchain, build,
# health waits, teardown) lives in start.sh — this is a thin, clearly
# named entry point so the console vs service distinction is obvious.

set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
exec bash "$REPO/scripts/start.sh" "$@"
