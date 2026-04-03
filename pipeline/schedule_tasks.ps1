# schedule_tasks.ps1 — Register Open Brain Task Scheduler tasks (run once as Administrator)
# Creates: OpenBrain\RedditPipeline — daily at 07:30, with startup catch-up if missed

$TaskFolder  = "OpenBrain"
$TaskName    = "RedditPipeline"
$FullName    = "$TaskFolder\$TaskName"
$ScriptPath  = "C:\Users\bogda\Documents\open_brain\pipeline\run_reddit.ps1"
$RunTime     = "07:30"

Write-Host "Registering task: $FullName"

# Create folder in Task Scheduler if needed
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$root = $scheduler.GetFolder("\")
try { $root.GetFolder($TaskFolder) }
catch { $root.CreateFolder($TaskFolder) | Out-Null }

# Remove existing task if present
Unregister-ScheduledTask -TaskName $TaskName -TaskPath "\$TaskFolder\" -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NonInteractive -NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""

# Daily trigger at $RunTime + "run ASAP if missed" (machine was off at scheduled time)
$trigger = New-ScheduledTaskTrigger -Daily -At $RunTime
$trigger.ExecutionTimeLimit = "PT2H"   # give up after 2 hours if stuck

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
    -RestartCount 0 `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable                # catch-up run if machine was off at scheduled time

# Run as current user (no password prompt, works while logged in)
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Highest

Register-ScheduledTask `
    -TaskName    $TaskName `
    -TaskPath    "\$TaskFolder\" `
    -Action      $action `
    -Trigger     $trigger `
    -Settings    $settings `
    -Principal   $principal `
    -Force | Out-Null

Write-Host "Done. Task registered: $FullName"
Write-Host "Schedule: daily at $RunTime (runs at startup if missed)"
Write-Host ""
Write-Host "To test immediately:"
Write-Host "  Start-ScheduledTask -TaskPath '\$TaskFolder\' -TaskName '$TaskName'"
Write-Host "  # then check: pipeline\logs\reddit_$(Get-Date -Format 'yyyy-MM-dd').log"
