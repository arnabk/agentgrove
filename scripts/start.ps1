# start.ps1 — start AgentGrove (backend + frontend) for local development.
# Windows sibling of scripts/start.sh.

$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repo

$logDir = Join-Path $repo ".data\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$bePort = if ($env:AGENTGROVE_PORT) { $env:AGENTGROVE_PORT } else { "4317" }
$beLog  = Join-Path $logDir "backend.log"
$feLog  = Join-Path $logDir "frontend.log"

$global:beProc = $null
$global:feProc = $null

function Stop-Children {
  Write-Host "`n[start] shutting down..."
  foreach ($p in @($global:feProc, $global:beProc)) {
    if ($p -and -not $p.HasExited) {
      try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
  }
  Write-Host "[start] stopped"
}

try {
  Register-EngineEvent PowerShell.Exiting -Action { Stop-Children } | Out-Null

  Write-Host "[start] building backend..."
  cargo build -p agentgrove-server *> $beLog
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[start] backend build failed; see $beLog"
    Get-Content $beLog -Tail 40
    exit 1
  }

  Write-Host "[start] launching backend on http://127.0.0.1:$bePort ..."
  $env:AGENTGROVE_PORT = $bePort
  $global:beProc = Start-Process -PassThru -NoNewWindow `
    -FilePath ".\target\debug\agentgrove.exe" `
    -RedirectStandardOutput $beLog -RedirectStandardError $beLog

  for ($i = 1; $i -le 30; $i++) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$bePort/health" -UseBasicParsing -TimeoutSec 1
      if ($r.StatusCode -eq 200) { break }
    } catch {}
    if ($global:beProc.HasExited) {
      Write-Host "[start] backend exited early; tail of log:"
      Get-Content $beLog -Tail 40
      exit 1
    }
    Start-Sleep -Seconds 1
  }

  $token = ((Select-String -Path $beLog -Pattern '^token: ').Line | Select-Object -First 1) -replace '^token: ', ''
  Write-Host "[start] backend ready"
  Write-Host "[start]   url:   http://127.0.0.1:$bePort"
  Write-Host "[start]   token: $token"
  Write-Host "[start]   log:   $beLog"

  Write-Host "[start] launching frontend..."
  $global:feProc = Start-Process -PassThru -NoNewWindow `
    -FilePath "pnpm" -ArgumentList "-C","apps/web","dev" `
    -RedirectStandardOutput $feLog -RedirectStandardError $feLog

  for ($i = 1; $i -le 30; $i++) {
    try {
      $r = Invoke-WebRequest -Uri "http://localhost:5173" -UseBasicParsing -TimeoutSec 1
      if ($r.StatusCode -eq 200) { break }
    } catch {}
    if ($global:feProc.HasExited) {
      Write-Host "[start] frontend exited early; tail of log:"
      Get-Content $feLog -Tail 40
      exit 1
    }
    Start-Sleep -Seconds 1
  }

  Write-Host "[start] frontend ready"
  Write-Host "[start]   url: http://localhost:5173"
  Write-Host "[start]   log: $feLog"
  Write-Host ""
  Write-Host "[start] AgentGrove is running. Press Ctrl+C to stop."

  while (-not $global:beProc.HasExited -and -not $global:feProc.HasExited) {
    Start-Sleep -Seconds 1
  }
  Write-Host "[start] a process exited; tearing down"
}
finally {
  Stop-Children
}
