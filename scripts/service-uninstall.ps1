# service-uninstall.ps1 — stop and remove the AgentGrove scheduled task
# created by scripts/service-install.ps1. Data in .data is never touched.
# Windows sibling of scripts/service-uninstall.sh.
#
#   pwsh scripts/service-uninstall.ps1

$ErrorActionPreference = "Stop"
$taskName = "AgentGrove"

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "[service-uninstall] stopping + removing scheduled task '$taskName'"
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "[service-uninstall] done."
} else {
  Write-Host "[service-uninstall] no scheduled task '$taskName' found."
}
