# dev-be.ps1 — Windows sibling of scripts/dev-be.sh.
$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repo
cargo run -p agentgrove-server
