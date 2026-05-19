# test-live.ps1 — Windows sibling of scripts/test-live.sh.

$ErrorActionPreference = "Stop"

cargo build --release -p agentgrove-server
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

pnpm -C apps/web build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

cargo test -p agentgrove-api --test e2e
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

pnpm -C apps/web test:e2e
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
