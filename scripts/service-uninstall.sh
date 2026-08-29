#!/usr/bin/env bash
# service-uninstall.sh — stop and remove the AgentGrove auto-start
# service created by scripts/service-install.sh. Your data in .data is
# never touched.
#
#   bash scripts/service-uninstall.sh

set -u

LABEL="com.agentgrove.app"
log() { printf '[service-uninstall] %s\n' "$1"; }

os="$(uname -s)"

if [ "$os" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  if launchctl list "$LABEL" >/dev/null 2>&1 || [ -f "$PLIST" ]; then
    log "unloading launchd agent"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    log "removed $PLIST"
  else
    log "no launchd agent installed"
  fi
  log "done. The app process (if running) is stopped."
  exit 0
fi

if [ "$os" = "Linux" ]; then
  if command -v systemctl >/dev/null 2>&1; then
    log "disabling + stopping systemd --user service"
    systemctl --user disable --now agentgrove.service 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/agentgrove.service"
    systemctl --user daemon-reload 2>/dev/null || true
    log "removed agentgrove.service"
  else
    log "systemctl not found; nothing to remove"
  fi
  log "done."
  exit 0
fi

echo "[service-uninstall] Unsupported OS: $os. On Windows use scripts/service-uninstall.ps1." >&2
exit 1
