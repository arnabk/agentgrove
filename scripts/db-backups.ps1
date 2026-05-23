#!/usr/bin/env pwsh
# Lists DB snapshot directories under .data\backups, newest first.
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$backupsDir = Join-Path $repoRoot ".data\backups"

if (-not (Test-Path $backupsDir)) {
    Write-Output "No backups directory at $backupsDir."
    Write-Output "The server creates snapshots on every startup; run it at least once."
    exit 0
}

"{0,-40}  {1,10}  {2}" -f "SNAPSHOT", "SIZE", "AGE"
"{0,-40}  {1,10}  {2}" -f "--------", "----", "---"

$entries = Get-ChildItem $backupsDir -Directory | Sort-Object LastWriteTime -Descending
foreach ($e in $entries) {
    $size = (Get-ChildItem $e.FullName -Recurse | Measure-Object Length -Sum).Sum
    if ($size -ge 1GB) { $sizeStr = "{0:N1}G" -f ($size / 1GB) }
    elseif ($size -ge 1MB) { $sizeStr = "{0:N1}M" -f ($size / 1MB) }
    elseif ($size -ge 1KB) { $sizeStr = "{0:N0}K" -f ($size / 1KB) }
    else { $sizeStr = "${size}B" }
    $ageSpan = (Get-Date) - $e.LastWriteTime
    if ($ageSpan.TotalSeconds -lt 60) { $age = "{0:N0}s ago" -f $ageSpan.TotalSeconds }
    elseif ($ageSpan.TotalMinutes -lt 60) { $age = "{0:N0}m ago" -f $ageSpan.TotalMinutes }
    elseif ($ageSpan.TotalHours -lt 24) { $age = "{0:N0}h ago" -f $ageSpan.TotalHours }
    else { $age = "{0:N0}d ago" -f $ageSpan.TotalDays }
    "{0,-40}  {1,10}  {2}" -f $e.Name, $sizeStr, $age
}

Write-Output ""
Write-Output "Restore with: just restore-db <SNAPSHOT>"
