# cron-runner -- Windows NSSM service installer.
#
# v1.2 FR-024 D5: replaces GH-Actions cron schedules (KI-006 throttling
# regression: GH-Actions cron fires 5/23h instead of 1380/23h on minute
# cadence). The VPS-NSSM cron-runner ticks every 60s and POSTs to
# /api/cron/health for inbound liveness; Vercel-cron `*/30 * * * *`
# /api/cron/runner-watchdog is the backstop.
#
# Mirrors install-channels-service.ps1 exactly (same idempotent pattern,
# AppEnvironmentExtra env-file loading, AppExit Default Restart, NSSM start
# poll loop). Adds a -DryRun switch (R7-b) so the test harness can verify
# the script's commands without invoking nssm.exe.
#
# Constitution section 1 + section 13 + section 15:
#   - subscription-only auth (CRON_SECRET-bearer to Vercel; no Anthropic API)
#   - no API key in env (operator's responsibility)
#   - LOUD failure on env misconfig
#
# AC-005-3-equivalent recovery: NSSM Restart=Always with 5s delay matches
# the systemd Restart=always RestartSec=5s contract.
#
# Usage (run as Administrator on the VPS):
#   .\install-cron-runner-service.ps1 `
#       -BunPath        "C:\Users\Administrator\.bun\bin\bun.exe" `
#       -NssmPath       "C:\windows\system32\nssm.exe" `
#       -RepoRoot       "C:\caishen\caishenye" `
#       -EnvFile        "C:\caishen\cron-runner.env"
#
# Or in dry-run (test harness) mode:
#   .\install-cron-runner-service.ps1 -DryRun -BunPath ... -NssmPath ... -RepoRoot . -EnvFile ./fake.env
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

    [string]$ServiceName = "caishen-cron-runner",

    [string]$LogDir = "C:\caishen\logs",

    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Write-DryRun {
    param([string]$Message)
    Write-Host "[DRY-RUN] $Message"
}

# ----- 0. Pre-flight (LOUD failure per constitution section 15) ---------------
# In dry-run mode we soften pre-flight to allow fake paths so the harness
# can run without bun/nssm/env-file present on the test machine.

if (-not $DryRun) {
    if (-not (Test-Path $BunPath)) {
        throw "Bun binary not found at: $BunPath. Install Bun first: irm https://bun.sh/install.ps1 | iex"
    }
    if (-not (Test-Path $NssmPath)) {
        throw "NSSM not found at: $NssmPath. Install: choco install nssm OR download from https://nssm.cc/download"
    }
}

# Resolve loop script path (Windows path normalisation per Evaluator W3 watch-item).
$loopScript = Join-Path $RepoRoot "packages\cron-runner\scripts\loop.ts"
if (-not $DryRun) {
    if (-not (Test-Path $loopScript)) {
        throw "Cron-runner loop entry-point missing: $loopScript. RepoRoot must point at the cloned repo containing packages\cron-runner\scripts\loop.ts"
    }
    if (-not (Test-Path $EnvFile)) {
        throw "Environment file missing: $EnvFile. Create it with CRON_SECRET, VERCEL_BASE_URL, TELEGRAM_BOT_TOKEN, OPERATOR_CHAT_ID, CAISHEN_RUNNER_ID. NEVER commit this file."
    }
    if (-not (Test-Path $LogDir)) {
        New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    }
}

# ----- 1. Install or reconfigure the service ---------------------------------

if ($DryRun) {
    Write-DryRun "Would check: nssm status $ServiceName"
    Write-DryRun "nssm install $ServiceName `"$BunPath`" run `"$loopScript`""
    Write-DryRun "nssm set $ServiceName Application $BunPath"
    Write-DryRun "nssm set $ServiceName AppParameters `"run `"$loopScript`"`""
    Write-DryRun "nssm set $ServiceName AppDirectory $RepoRoot"
    Write-DryRun "nssm set $ServiceName AppEnvironmentExtra <env-file-contents from $EnvFile>"
    Write-DryRun "nssm set $ServiceName AppStdout $(Join-Path $LogDir "$ServiceName.out.log")"
    Write-DryRun "nssm set $ServiceName AppStderr $(Join-Path $LogDir "$ServiceName.err.log")"
    Write-DryRun "nssm set $ServiceName AppExit Default Restart"
    Write-DryRun "nssm set $ServiceName AppRestartDelay 5000"
    Write-DryRun "nssm set $ServiceName Start SERVICE_AUTO_START"
    Write-DryRun "nssm start $ServiceName"
    Write-DryRun "Would poll for SERVICE_RUNNING up to 15s"
    Write-Host ""
    Write-Host "DRY-RUN complete. No actual service changes made."
    exit 0
}

# ===== Real-mode execution below this point =====

# Wrap in try/catch + temp $ErrorActionPreference='Continue' so we can branch
# cleanly on $LASTEXITCODE (mirror install-channels-service.ps1 lines 87-96).
$serviceExists = $false
try {
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $NssmPath status $ServiceName 2>$null | Out-Null
    $serviceExists = ($LASTEXITCODE -eq 0)
} finally {
    $ErrorActionPreference = $prevEAP
}

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
$envLines = Get-Content $EnvFile | Where-Object { $_ -notmatch '^\s*#' -and $_ -match '=' }
if ($envLines.Count -eq 0) {
    throw "Environment file is empty or all-comments: $EnvFile"
}
$envBlock = ($envLines -join "`r`n")
& $NssmPath set $ServiceName AppEnvironmentExtra $envBlock

# Logging -- stdout + stderr to rotated log files.
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
& $NssmPath set $ServiceName DisplayName "财神爷 cron-runner"
& $NssmPath set $ServiceName Description "VPS-NSSM cron-runner (FR-024). Replaces GH-Actions cron schedules. Ticks every 60s; fires fire-due-executors + close-due-sessions + cron/health on Vercel."

# ----- 2. Start the service ---------------------------------------------------

Write-Host "Starting '$ServiceName'..."
try {
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $NssmPath start $ServiceName 2>$null | Out-Null
} finally {
    $ErrorActionPreference = $prevEAP
}

$status = ''
$pollTimeout = 15
for ($i = 0; $i -lt $pollTimeout; $i++) {
    Start-Sleep -Seconds 1
    try {
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $status = (& $NssmPath status $ServiceName 2>$null) -join ''
    } finally {
        $ErrorActionPreference = $prevEAP
    }
    if ($status -match 'SERVICE_RUNNING') {
        break
    }
    Write-Host "  ...still $status (waited ${i}s)"
}

Write-Host "Service status: $status"

if ($status -notmatch 'SERVICE_RUNNING') {
    throw "Service failed to enter SERVICE_RUNNING state after ${pollTimeout}s. Last status: $status. Check $LogDir\$ServiceName.err.log for details."
}

Write-Host ""
Write-Host "OK -- '$ServiceName' is running. Logs: $LogDir\$ServiceName.out.log and $LogDir\$ServiceName.err.log"
