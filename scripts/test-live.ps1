# test-live.ps1 — Windows sibling of scripts/test-live.sh.

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$logDir = Join-Path $repoRoot ".data\logs"
$beLog = Join-Path $logDir "live-backend.log"
# Start-Process refuses to redirect stdout and stderr to the same file,
# so the backend's stderr gets its own log.
$beErrLog = Join-Path $logDir "live-backend.err.log"
$feLog = Join-Path $logDir "live-frontend.log"
$pwLog = Join-Path $logDir "live-playwright.log"

Function Get-FreePort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    return $port
}

$bePort = Get-FreePort
$fePort = Get-FreePort

if (Test-Path (Join-Path $repoRoot ".data")) {
    Remove-Item -Recurse -Force (Join-Path $repoRoot ".data")
}
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

Write-Output "[live] building backend..."
cargo build --release -p agentgrove-server
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Output "[live] building frontend..."
pnpm -C apps/web build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Output "[live] starting backend on :$bePort"
$env:AGENTGROVE_STATE_DIR = Join-Path $repoRoot ".data"
$env:AGENTGROVE_BIND = "127.0.0.1"
$env:AGENTGROVE_PORT = $bePort
$env:AGENTGROVE_ENABLE_FAKE = "1"
$env:AGENTGROVE_STATIC_DIR = Join-Path $repoRoot "apps\web\dist"
$beProcess = Start-Process -NoNewWindow -FilePath ".\target\release\agentgrove.exe" -RedirectStandardOutput $beLog -RedirectStandardError $beErrLog -PassThru

$fePort = $bePort

# Wait for both to listen
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $feRes = Invoke-WebRequest -Uri "http://localhost:$fePort" -TimeoutSec 1 -UseBasicParsing -ErrorAction SilentlyContinue
        $beRes = Invoke-WebRequest -Uri "http://127.0.0.1:$bePort/health" -TimeoutSec 1 -UseBasicParsing -ErrorAction SilentlyContinue
        if ($feRes -and $beRes) {
            $ready = $true
            break
        }
    } catch {
        # continue waiting
    }
    Start-Sleep -Milliseconds 500
}

if (-not $ready) {
    Write-Output "ERROR: Servers failed to start."
    Write-Output "--- backend log (stdout) ---"
    Get-Content $beLog -Tail 30 -ErrorAction SilentlyContinue
    Write-Output "--- backend log (stderr) ---"
    Get-Content $beErrLog -Tail 30 -ErrorAction SilentlyContinue
    Write-Output "--- frontend log ---"
    Get-Content $feLog -Tail 30
    Stop-Process -Id $beProcess.Id -Force -ErrorAction SilentlyContinue
    
    exit 1
}

Write-Output "[live] running browser tests..."
$env:BASE_URL = "http://localhost:$fePort"
$env:PW_LIVE = "1"
$env:AGENTGROVE_BE_URL = "http://127.0.0.1:$bePort"
$env:REPO_ROOT = $repoRoot

# Need to capture output
pnpm -C apps/web exec playwright test --reporter=line 2>&1 | Tee-Object -FilePath $pwLog
$pwExit = $LASTEXITCODE

Stop-Process -Id $beProcess.Id -Force -ErrorAction SilentlyContinue


if ($pwExit -eq 0) {
    Write-Output "================ LIVE TESTS PASSED ================"
} else {
    Write-Output "================ LIVE TESTS FAILED ================"
    Write-Output "--- playwright log (tail) ---"
    Get-Content $pwLog -Tail 50 -ErrorAction SilentlyContinue
    exit $pwExit
}
