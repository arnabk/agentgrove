# console.ps1 — run AgentGrove in the foreground in this terminal.
# Windows sibling of scripts/console.sh.
#
# Builds + launches the backend (:4317) and frontend (:5173) and tears
# both down on Ctrl+C. Nothing is installed; closing the window stops it.
# For auto-start on login + restart on crash, use service-install.ps1.
#
#   pwsh scripts/console.ps1
#   # or, via just:  just start

$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
& pwsh (Join-Path $repo "scripts/start.ps1") @args
