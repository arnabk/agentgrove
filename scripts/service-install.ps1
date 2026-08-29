# service-install.ps1 — register AgentGrove to start on login and
# restart on crash, via Windows Task Scheduler. Windows sibling of
# scripts/service-install.sh. No Docker; runs at the system level so the
# app keeps full access to git, the filesystem, PTYs, and agent CLIs.
#
#   pwsh scripts/service-install.ps1
#
# Uninstall with scripts/service-uninstall.ps1.

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$taskName = "AgentGrove"
$port = if ($env:AGENTGROVE_PORT) { $env:AGENTGROVE_PORT } else { "4317" }
$startPs1 = Join-Path $repo "scripts/start.ps1"
$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $pwsh) { $pwsh = (Get-Command powershell).Source }

Write-Host "[service-install] registering scheduled task '$taskName'"

# Run start.ps1 hidden, with the port set, from the repo dir.
$action = New-ScheduledTaskAction -Execute $pwsh `
  -Argument "-NoLogo -NoProfile -WindowStyle Hidden -File `"$startPs1`"" `
  -WorkingDirectory $repo

# Trigger: at user logon.
$trigger = New-ScheduledTaskTrigger -AtLogOn

# Restart on failure (crash), keep it running, no timeout.
$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Seconds 10) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

# Pass the port to start.ps1 via the environment for the task's process.
[System.Environment]::SetEnvironmentVariable("AGENTGROVE_PORT", $port, "User")

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Force | Out-Null

# Start it now so the app comes up without waiting for a re-login.
Start-ScheduledTask -TaskName $taskName

Write-Host "[service-install] installed. Auto-starts on login and restarts on crash."
Write-Host "[service-install]   status:  Get-ScheduledTask -TaskName $taskName"
Write-Host "[service-install]   logs:    $repo\.data\logs\backend.log / frontend.log"
Write-Host "[service-install]   stop/rm: pwsh scripts/service-uninstall.ps1"
