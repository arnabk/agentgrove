#!/usr/bin/env bash
# service-install.sh — register AgentGrove to start automatically on
# login and restart if it crashes. No Docker; runs at the system level
# so the app keeps full access to git, the filesystem, PTYs, and your
# agent CLIs (Claude / opencode / Kimi).
#
#   macOS  → a per-user launchd LaunchAgent (RunAtLoad + KeepAlive)
#   Linux  → a systemd --user service (WantedBy=default.target, Restart=always)
#
# Both run `scripts/start.sh`, which pins the rustup 1.95 toolchain,
# builds, launches BE (:4317) + FE (:5173), and tears down cleanly.
#
# Usage:
#   bash scripts/service-install.sh            # install + start now
#   AGENTGROVE_PORT=4317 bash scripts/service-install.sh
#
# Uninstall with scripts/service-uninstall.sh.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.agentgrove.app"
PORT="${AGENTGROVE_PORT:-4317}"
LOG_DIR="$REPO/.data/logs"
mkdir -p "$LOG_DIR"

# The service manager's OWN stdout/stderr redirect must land somewhere it
# can always open. On macOS, launchd cannot open StandardOutPath /
# StandardErrorPath on a non-boot external volume (e.g. a repo under
# /Volumes/...) — it fails the job with EX_CONFIG (78) before the program
# even runs. So the supervisor log always goes to ~/Library/Logs, while
# the app's own detailed logs (backend.log / frontend.log) still live in
# .data/logs, written by start.sh from inside the running process.
SVC_LOG_DIR="$HOME/Library/Logs"
mkdir -p "$SVC_LOG_DIR"

log() { printf '[service-install] %s\n' "$1"; }

# Build the PATH the service will run with. A service manager starts with
# a minimal PATH that omits where user tools install, so the app can't
# find the agent CLIs (opencode / claude / kimi) it spawns via `which`,
# even though they work in your shell. Resolve them at install time from
# THIS shell (which has your real PATH) and bake the containing dirs in,
# plus the usual toolchain/user bins. Deduplicated, existing dirs only.
build_svc_path() {
  local parts=(
    "$HOME/.cargo/bin"
    "/opt/homebrew/opt/rustup/bin"
    "/opt/homebrew/bin"
    "/usr/local/bin"
    "$HOME/.opencode/bin"
    "$HOME/.local/bin"
    "$HOME/bin"
    "$HOME/.bun/bin"
  )
  # Directories that actually contain the agent CLIs / node right now.
  local tool
  for tool in opencode claude kimi node pnpm; do
    local p; p="$(command -v "$tool" 2>/dev/null || true)"
    [ -n "$p" ] && parts+=("$(cd "$(dirname "$p")" && pwd)")
  done
  parts+=("/usr/bin" "/bin" "/usr/sbin" "/sbin")

  local out="" d
  for d in "${parts[@]}"; do
    [ -d "$d" ] || continue
    case ":$out:" in *":$d:"*) : ;; *) out="${out:+$out:}$d" ;; esac
  done
  printf '%s' "$out"
}
SVC_PATH="$(build_svc_path)"

os="$(uname -s)"
case "$os" in
  Darwin) target="macos" ;;
  Linux)  target="linux" ;;
  *) echo "[service-install] Unsupported OS: $os. On Windows use scripts/service-install.ps1." >&2; exit 1 ;;
esac

# ── macOS: launchd LaunchAgent ────────────────────────────────
if [ "$target" = "macos" ]; then
  AGENTS_DIR="$HOME/Library/LaunchAgents"
  PLIST="$AGENTS_DIR/$LABEL.plist"
  mkdir -p "$AGENTS_DIR"

  # If already loaded, unload first so we can rewrite cleanly. bootout is
  # asynchronous — a subsequent bootstrap can race the teardown and fail
  # ("service already loaded" / silently not reload), leaving nothing
  # running. Wait for the label to actually disappear before continuing.
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    log "existing agent found; unloading before reinstall"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
    for _ in $(seq 1 20); do
      launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
      sleep 0.5
    done
  fi

  log "writing $PLIST"
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>

    <!-- Run service-run.sh: frees stale ports, then execs start.sh
         (which handles toolchain PATH, build, BE+FE launch). -->
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$REPO/scripts/service-run.sh</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$REPO</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>AGENTGROVE_PORT</key>
        <string>$PORT</string>
        <!-- launchd has a bare PATH; give start.sh the tools it needs,
             including the dirs where opencode/claude/kimi/node live
             (resolved at install time). start.sh further hardens PATH. -->
        <key>PATH</key>
        <string>$SVC_PATH</string>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>

    <!-- Start at login and keep it alive: restarts on crash or exit. -->
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>

    <!-- Don't hammer restarts if it fails fast. A full build can take a
         while; a generous interval avoids a thundering-herd of respawns
         colliding on the port before the previous instance is gone. -->
    <key>ThrottleInterval</key>
    <integer>30</integer>

    <key>StandardOutPath</key>
    <string>$SVC_LOG_DIR/agentgrove.service.out.log</string>
    <key>StandardErrorPath</key>
    <string>$SVC_LOG_DIR/agentgrove.service.err.log</string>
</dict>
</plist>
PLIST_EOF

  log "loading agent"
  # bootstrap is the modern verb; fall back to load on older macOS.
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"
  launchctl enable "gui/$(id -u)/$LABEL" 2>/dev/null || true

  # Verify it actually loaded (bootout/bootstrap can race on reinstall).
  if ! launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    log "first load didn't take; retrying"
    sleep 1
    launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST" 2>/dev/null || true
  fi

  log "installed. It will auto-start on login and restart on crash."
  log "  logs:      $SVC_LOG_DIR/agentgrove.service.out.log"
  log "             $LOG_DIR/backend.log  +  $LOG_DIR/frontend.log"
  log "  status:    launchctl print gui/$(id -u)/$LABEL | grep state"
  log "  stop/rm:   bash scripts/service-uninstall.sh"
  exit 0
fi

# ── Linux: systemd --user service ─────────────────────────────
if [ "$target" = "linux" ]; then
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "[service-install] systemctl not found. This installer supports systemd; register start.sh with your init system manually." >&2
    exit 1
  fi
  UNIT_DIR="$HOME/.config/systemd/user"
  UNIT="$UNIT_DIR/agentgrove.service"
  mkdir -p "$UNIT_DIR"

  log "writing $UNIT"
  cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=AgentGrove (backend + frontend)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO
Environment=AGENTGROVE_PORT=$PORT
Environment=PATH=$SVC_PATH
Environment=HOME=$HOME
ExecStart=/bin/bash $REPO/scripts/service-run.sh
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
UNIT_EOF

  log "enabling + starting"
  systemctl --user daemon-reload
  systemctl --user enable --now agentgrove.service

  # So the service runs even when you're not logged in (optional but nice).
  if command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "$(id -un)" 2>/dev/null || \
      log "note: could not enable linger; service runs while you are logged in"
  fi

  log "installed. It will auto-start on login and restart on crash."
  log "  status:  systemctl --user status agentgrove.service"
  log "  logs:    journalctl --user -u agentgrove.service -f"
  log "  stop/rm: bash scripts/service-uninstall.sh"
  exit 0
fi
