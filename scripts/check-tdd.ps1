# check-tdd.ps1 — Windows sibling of scripts/check-tdd.sh.
# Verifies a PR adds tests when it adds production code.
#
# Usage: pwsh scripts/check-tdd.ps1 [-Base main]

param(
  [string]$Base = "main"
)

$ErrorActionPreference = "Stop"

git rev-parse --verify $Base 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "check-tdd: base branch '$Base' not found; skipping"
  exit 0
}

$mergeBase = (git merge-base HEAD $Base).Trim()

$prodPattern  = '^(crates/[^/]+/src/|apps/web/src/)'
$testPattern  = '^(crates/[^/]+/tests/|crates/[^/]+/src/.*test.*|apps/web/(tests|e2e)/|apps/web/src/.*\.(test|spec)\.)'
$docsPattern  = '^(docs/|README\.md|\.github/|.*\.md$)'

function Get-AddedLines([string]$pathRegex) {
  $diff = git diff --no-color --unified=0 $mergeBase --
  $file = ""
  $count = 0
  foreach ($line in $diff) {
    if ($line -like "+++ *") {
      $file = $line.Substring(6)
      continue
    }
    if ($line -like "--- *" -or $line -like "@@*") { continue }
    if ($line.StartsWith("+")) {
      if ($file -match $pathRegex) {
        $payload = $line.Substring(1).Trim()
        if ([string]::IsNullOrEmpty($payload)) { continue }
        if ($payload -match '^(//|#|/\*|\*)') { continue }
        $count++
      }
    }
  }
  return $count
}

$nonDocs = git diff --name-only $mergeBase -- |
  Where-Object { $_ -notmatch $docsPattern }

if (-not $nonDocs) {
  Write-Host "check-tdd: docs-only change; ok"
  exit 0
}

$prodAdded = Get-AddedLines $prodPattern
$testAdded = Get-AddedLines $testPattern

Write-Host "check-tdd: added production lines = $prodAdded, added test lines = $testAdded"

if ($prodAdded -gt 0 -and $testAdded -eq 0) {
  Write-Error "check-tdd: FAIL — production code added without any test changes."
  exit 1
}

Write-Host "check-tdd: OK"
