# Channels session -- Windows NSSM service installer.
#
# Production VPS pivot (2026-05-04): the Channels session runs on a
# Windows VPS managed by NSSM, not Linux + systemd. This installer
# wraps the Bun process via NSSM in the same shape the Linux unit
# (caishen-channels.service) defines: Restart=always, stdout->log file,
# loaded environment from a file the operator owns.
#
# Linux/systemd alternative lives at infra/vps/systemd/caishen-channels.service
# and is kept in source control as documentation for non-Windows deployers.
# It is NOT used in production today.
#
# Constitution §1 + §13 + §15:
#   - subscription-only auth (claude CLI is logged in via `claude login`)
#   - no API key in env (operator's responsibility)
#   - LOUD failure on any environment misconfiguration
#
# AC-005-3 (recovery): NSSM Restart=Always with 5s delay matches the
# systemd Restart=always RestartSec=5s contract.
#
# ADR-009 (restart-on-idle): the periodic-restart cadence is owned by
# install-restart-on-idle-task.ps1 (a Windows Task Scheduler timer).
#
# Usage (run as Administrator on the VPS):
#   .\install-channels-service.ps1 `
#       -BunPath        "C:\Users\Administrator\.bun\bin\bun.exe" `
#       -NssmPath       "C:\windows\system32\nssm.exe" `
#       -RepoRoot       "C:\caishen\caishenye" `
#       -EnvFile        "C:\caishen\channels.env" `
#       -ServiceName    "caishen-channels" `
#       -LogDir         "C:\caishen\logs"
#
# Idempotent: re-running with the same args reconfigures the existing service
# in place (NSSM `set` is upsert).

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BunPath,

    [Parameter(Mandatory = $true)]
    [string]$NssmPath,

    [Parameter(Mandatory = $true)]
    [string]$RepoRoot,

    [Parameter(Mandatory = $true)]
    [string]$EnvFile,

    [string]$ServiceName = "caishen-channels",

    [string]$LogDir = "C:\caishen\logs"
)

$ErrorActionPreference = "Stop"

# ----- 0. Pre-flight (LOUD failure per constitution §15) ----------------------

if (-not (Test-Path $BunPath)) {
    throw "Bun binary not found at: $BunPath. Install Bun first: irm https://bun.sh/install.ps1 | iex"
}

if (-not (Test-Path $NssmPath)) {
    throw "NSSM not found at: $NssmPath. Install: choco install nssm OR download from https://nssm.cc/download"
}

$loopScript = Join-Path $RepoRoot "packages\channels\scripts\loop.ts"
if (-not (Test-Path $loopScript)) {
    throw "Channels loop entry-point missing: $loopScript. RepoRoot must point at the cloned repo containing packages/channels/scripts/loop.ts"
}

if (-not (Test-Path $EnvFile)) {
    throw "Environment file missing: $EnvFile. Create it with TELEGRAM_BOT_TOKEN, DATABASE_URL, MT5_BASE_URL, MT5_BEARER_TOKEN, FFCAL_BASE_URL, FFCAL_BEARER_TOKEN, ALLOWED_TELEGRAM_USER_IDS, CAISHEN_TENANT_ID. NEVER commit this file."
}

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

# ----- 1. Install or reconfigure the service ---------------------------------

$existing = & $NssmPath status $ServiceName 2>&1
$serviceExists = ($LASTEXITCODE -eq 0)

if ($serviceExists) {
    Write-Host "Service '$ServiceName' already exists; stopping for reconfigure..."
    & $NssmPath stop $ServiceName confirm 2>&1 | Out-Null
} else {
    Write-Host "Installing new service '$ServiceName'..."
    & $NssmPath install $ServiceName $BunPath "run" $loopScript
    if ($LASTEXITCODE -ne 0) {
        throw "nssm install failed with exit code $LASTEXITCODE"
    }
}

# Application path / args (idempotent -- `set` overwrites if service exists).
& $NssmPath set $ServiceName Application $BunPath
& $NssmPath set $ServiceName AppParameters "run `"$loopScript`""
& $NssmPath set $ServiceName AppDirectory $RepoRoot

# Environment loading: NSSM AppEnvironmentExtra reads KEY=VALUE lines.
# We pass the env file via AppEnvironmentExtra by reading it line-by-line.
# This mirrors systemd's EnvironmentFile= directive.
$envLines = Get-Content $EnvFile | Where-Object { $_ -notmatch '^\s*#' -and $_ -match '=' }
if ($envLines.Count -eq 0) {
    throw "Environment file is empty or all-comments: $EnvFile"
}
$envBlock = ($envLines -join "`r`n")
& $NssmPath set $ServiceName AppEnvironmentExtra $envBlock

# Logging -- stdout + stderr to rotated log files, mirrors systemd's StandardOutput=journal.
& $NssmPath set $ServiceName AppStdout (Join-Path $LogDir "$ServiceName.out.log")
& $NssmPath set $ServiceName AppStderr (Join-Path $LogDir "$ServiceName.err.log")
& $NssmPath set $ServiceName AppRotateFiles 1
& $NssmPath set $ServiceName AppRotateOnline 1
& $NssmPath set $ServiceName AppRotateSeconds 86400      # daily rotate
& $NssmPath set $ServiceName AppRotateBytes 10485760     # or 10 MB, whichever first

# Restart policy -- match systemd Restart=always RestartSec=5s contract.
& $NssmPath set $ServiceName AppExit Default Restart
& $NssmPath set $ServiceName AppRestartDelay 5000        # 5 s, in ms
& $NssmPath set $ServiceName AppThrottle 10000           # 10 s minimum between restart attempts

# Start automatically on boot.
& $NssmPath set $ServiceName Start SERVICE_AUTO_START

# Display name + description (visible in services.msc).
& $NssmPath set $ServiceName DisplayName "财神爷 Channels session"
& $NssmPath set $ServiceName Description "Always-on Telegram operator surface (FR-004). Long-polls Bot API, dispatches messages to caishen-telegram subagent. Subscription-only auth via claude CLI."

# ----- 2. Start the service ---------------------------------------------------

Write-Host "Starting '$ServiceName'..."
& $NssmPath start $ServiceName
if ($LASTEXITCODE -ne 0) {
    throw "nssm start failed with exit code $LASTEXITCODE. Check $LogDir\$ServiceName.err.log for details."
}

Start-Sleep -Seconds 2

$status = & $NssmPath status $ServiceName
Write-Host "Service status: $status"

if ($status -notmatch "SERVICE_RUNNING") {
    throw "Service failed to enter SERVICE_RUNNING state. Last status: $status. Check $LogDir\$ServiceName.err.log"
}

Write-Host ""
Write-Host "OK -- '$ServiceName' is running. Logs: $LogDir\$ServiceName.out.log and $LogDir\$ServiceName.err.log"
Write-Host "Next step: install the restart-on-idle scheduled task: .\install-restart-on-idle-task.ps1"
