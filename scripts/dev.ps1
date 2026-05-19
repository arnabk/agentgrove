# dev.ps1 — Windows sibling of scripts/dev.sh. BE + FE with hot reload.

$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repo

$logDir = Join-Path $repo ".data\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$beLog = Join-Path $logDir "dev-backend.log"
$feLog = Join-Path $logDir "dev-frontend.log"

if (-not (Get-Command cargo-watch -ErrorAction SilentlyContinue)) {
  Write-Host "[dev] installing cargo-watch..."
  cargo install --locked cargo-watch
}

$bePort = if ($env:AGENTGROVE_PORT) { $env:AGENTGROVE_PORT } else { "4317" }
$env:AGENTGROVE_PORT = $bePort

Write-Host "[dev] launching backend (hot reload) on http://127.0.0.1:$bePort"
$beProc = Start-Process -PassThru -NoNewWindow `
  -FilePath "cargo" `
  -ArgumentList "watch","-q","-c","-w","crates","-s","cargo run -q -p agentgrove-server" `
  -RedirectStandardOutput $beLog -RedirectStandardError $beLog

Write-Host "[dev] launching frontend (Vite HMR)"
$feProc = Start-Process -PassThru -NoNewWindow `
  -FilePath "pnpm" -ArgumentList "-C","apps/web","dev" `
  -RedirectStandardOutput $feLog -RedirectStandardError $feLog

Write-Host "[dev] hot reload active. Edit code; both reload on save."
Write-Host "[dev] Ctrl+C to stop."

try {
  while (-not $beProc.HasExited -and -not $feProc.HasExited) {
    Start-Sleep -Seconds 1
  }
}
finally {
  if (-not $beProc.HasExited) { Stop-Process -Id $beProc.Id -Force -ErrorAction SilentlyContinue }
  if (-not $feProc.HasExited) { Stop-Process -Id $feProc.Id -Force -ErrorAction SilentlyContinue }
}
