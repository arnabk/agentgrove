#!/usr/bin/env pwsh
# Restore agentgrove.sqlite (+ WAL companions) from a snapshot dir
# under .data\backups. Snapshots the current DB first as
# `db-<ts>-pre-restore` so the restore can itself be undone.
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Snapshot
)
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $repoRoot ".data"
$backupsDir = Join-Path $stateDir "backups"
$snapshotDir = Join-Path $backupsDir $Snapshot

if (-not (Test-Path $snapshotDir)) {
    Write-Error "Snapshot directory not found: $snapshotDir"
    exit 1
}
if (-not (Test-Path (Join-Path $snapshotDir "agentgrove.sqlite"))) {
    Write-Error "Snapshot $Snapshot is missing agentgrove.sqlite (corrupt?)."
    exit 1
}

# Refuse if BE is running on the default loopback port.
try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:4317/api/health" -TimeoutSec 1 -UseBasicParsing
    if ($resp.StatusCode -eq 200) {
        Write-Error "Refusing to restore: AgentGrove server is running on 127.0.0.1:4317. Stop it first."
        exit 1
    }
} catch {
    # Server not running — proceed.
}

Write-Output ""
Write-Output "About to restore: $Snapshot"
Write-Output "  Source : $snapshotDir"
Write-Output "  Target : $stateDir\agentgrove.sqlite (+ -wal / -shm)"
Write-Output ""
Write-Output "Current DB will be backed up first as db-<ts>-pre-restore."
Write-Output "Type the snapshot name exactly to confirm:"
$confirm = Read-Host
if ($confirm -ne $Snapshot) {
    Write-Error "Confirmation did not match. Aborting."
    exit 1
}

$ts = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
$preRestoreDir = Join-Path $backupsDir "db-${ts}-pre-restore"
New-Item -ItemType Directory -Path $preRestoreDir -Force | Out-Null
foreach ($suffix in @("", "-wal", "-shm")) {
    $src = Join-Path $stateDir "agentgrove.sqlite$suffix"
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $preRestoreDir "agentgrove.sqlite$suffix")
    }
}
Write-Output "Wrote pre-restore snapshot: $preRestoreDir"

foreach ($suffix in @("", "-wal", "-shm")) {
    $target = Join-Path $stateDir "agentgrove.sqlite$suffix"
    if (Test-Path $target) { Remove-Item $target }
}
foreach ($suffix in @("", "-wal", "-shm")) {
    $src = Join-Path $snapshotDir "agentgrove.sqlite$suffix"
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $stateDir "agentgrove.sqlite$suffix")
    }
}
Write-Output "Restored. Start the BE with 'just dev' to verify."
