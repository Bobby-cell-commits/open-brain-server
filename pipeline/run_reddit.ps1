# run_reddit.ps1 - Open Brain Reddit pipeline wrapper for Windows Task Scheduler
# Features: lock file (no overlapping runs), timestamped logs, 30-day log rotation

$RepoRoot  = "C:\Users\bogda\Documents\open_brain"
$Python    = "C:\Users\bogda\AppData\Local\Programs\Python\Python313\python.exe"
$LogDir    = "$RepoRoot\pipeline\logs"
$LockFile  = "$LogDir\reddit.lock"
$LogFile   = "$LogDir\reddit_$(Get-Date -Format 'yyyy-MM-dd').log"

function Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Add-Content -Path $LogFile -Value $line
    Write-Output $line
}

# Ensure log dir exists
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

# Lock check - bail if a previous run is still active
if (Test-Path $LockFile) {
    $lockPid = Get-Content $LockFile -ErrorAction SilentlyContinue
    if ($lockPid -and (Get-Process -Id ([int]$lockPid) -ErrorAction SilentlyContinue)) {
        Log "[SKIP] Previous run (PID $lockPid) still active - exiting"
        exit 0
    }
    Log "[WARN] Stale lock file found (PID $lockPid) - removing"
    Remove-Item $LockFile -Force
}

# Acquire lock
$PID | Set-Content $LockFile

$exitCode = 1
try {
    Log "[START] Reddit pipeline"

    Set-Location $RepoRoot
    $env:PYTHONPATH = $RepoRoot

    # Run pipeline and capture output line-by-line with timestamps
    & $Python -u -m pipeline.reddit.run --subreddits 2>&1 | ForEach-Object {
        Log "  $_"
    }
    $exitCode = $LASTEXITCODE

    Log "[DONE] Exit code: $exitCode"
}
catch {
    Log "[ERROR] Unhandled exception: $_"
    $exitCode = 1
}
finally {
    Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
}

# Rotate logs older than 30 days
Get-ChildItem "$LogDir\reddit_*.log" -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
    ForEach-Object { Log "[ROTATE] Deleting old log: $($_.Name)"; Remove-Item $_.FullName -Force }

exit $exitCode
