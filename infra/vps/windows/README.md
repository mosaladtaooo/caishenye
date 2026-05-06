# Windows VPS deployment (production target)

The production VPS for 财神爷 v2 is **Windows Server with NSSM** managing the
long-lived processes. The contract draft assumed Linux + systemd; the actual
environment differs. This folder holds the Windows-equivalent installers.

The Linux/systemd files at `infra/vps/systemd/` and the nginx file at
`infra/vps/nginx/mt5-bearer.conf` remain in source control as documentation
for non-Windows deployers and for the migration path when the operator
moves to a Linux VPS.

## What runs on the VPS

| Service                  | Manager | Listens on             | Purpose                                          |
|--------------------------|---------|------------------------|--------------------------------------------------|
| MetaTraderMCP            | NSSM    | localhost:8000 (HTTP)  | Pre-existing — MT5 REST gateway (uvicorn)        |
| ForexFactoryMCP          | NSSM    | localhost:8081 (SSE)   | Pre-existing — ForexFactory MCP server           |
| caishen-mt5-proxy        | NSSM    | localhost:18000 (HTTP) | Bun reverse-proxy; bearer-validates → :8000      |
| caishen-ffcal-proxy      | NSSM    | localhost:18081 (HTTP) | Bun reverse-proxy; bearer-validates → :8081      |
| **caishen-channels**     | NSSM    | n/a (long-poll client) | **Always-on Telegram surface (FR-004)** — this folder installs it |
| **caishen-cron-runner**  | NSSM    | n/a (HTTP client)      | **Cron tick runner (FR-024 v1.2)** — replaces GH-Actions cron |
| n8n (legacy)             | NSSM    | localhost:5678         | Parallel-run during cutover; stop after v2 verified |

## v1.2 cron-runner runbook (FR-024)

The new caishen-cron-runner ticks every 60s, hitting Vercel:
1. `GET /api/cron/fire-due-executors` — fires due Executors per pair
2. `GET /api/cron/close-due-sessions` — closes pending+positions at session end
3. `POST /api/cron/health` — inbound liveness ping (writes to `cron_runner_health`)

Backstop: a Vercel cron at `*/30 * * * *` calls `/api/cron/runner-watchdog`
which checks `MAX(pinged_at)` staleness and emits a direct Telegram alert if
stale > 30 min.

Install once on the VPS (Administrator pwsh):

```powershell
# Use -DryRun first to preview commands without changing anything:
.\install-cron-runner-service.ps1 `
    -BunPath        "C:\Users\Administrator\.bun\bin\bun.exe" `
    -NssmPath       "C:\windows\system32\nssm.exe" `
    -RepoRoot       "C:\caishen\caishenye" `
    -EnvFile        "C:\caishen\cron-runner.env" `
    -DryRun

# Real install (drops -DryRun):
.\install-cron-runner-service.ps1 `
    -BunPath        "C:\Users\Administrator\.bun\bin\bun.exe" `
    -NssmPath       "C:\windows\system32\nssm.exe" `
    -RepoRoot       "C:\caishen\caishenye" `
    -EnvFile        "C:\caishen\cron-runner.env"
```

The env file `C:\caishen\cron-runner.env` MUST contain:
```
CRON_SECRET=<same value as Vercel's CRON_SECRET env>
VERCEL_BASE_URL=https://caishenv2.vercel.app
TELEGRAM_BOT_TOKEN=<bot token; same as channels uses>
OPERATOR_CHAT_ID=<the operator's Telegram chat id>
CAISHEN_RUNNER_ID=vps-windows-1
```

Logs land at `C:\caishen\logs\caishen-cron-runner.{out,err}.log` (rotated daily).

After install, deactivate the GH-Actions schedules (already done in v1.2 — the
.github/workflows/cron-{fire,close}-due-*.yml files now have `schedule:` removed
but keep `workflow_dispatch:` for emergency manual fires).

Tailscale Funnel exposes `localhost:18000` on `https://<host>.<tailnet>.ts.net/`
(port 443) and `localhost:18081` on the same host port 8443. The bearer
validation lives in the Bun proxy script (`C:\caishen\auth-proxy.ts`),
which is the Windows replacement for the nginx config in `infra/vps/nginx/`.

## Install order (one-time, run as Administrator)

1. **Pre-reqs**:
   - Bun installed at `C:\Users\Administrator\.bun\bin\bun.exe`
     (`irm https://bun.sh/install.ps1 | iex`).
   - NSSM installed at `C:\windows\system32\nssm.exe`
     (`choco install nssm` or download from https://nssm.cc/download).
   - PostgreSQL client (`psql.exe`) installed (any 16.x install works;
     used by the restart-on-idle task to write audit rows).
   - The repo cloned somewhere stable, e.g. `C:\caishen\caishenye`.
   - The operator-owned environment file at `C:\caishen\channels.env`
     (NEVER commit this file; gitignored at root).

2. **Run claude login as the same user the service will run as.** NSSM
   defaults to `LocalSystem`; the `claude` CLI's session cache lives in
   that user's profile. Run `claude login` from an Admin PowerShell as
   the SYSTEM user (use `psexec -s -i powershell.exe` from Sysinternals)
   OR change the NSSM service to run as a dedicated user.

3. **Install the channels service**:
   ```powershell
   cd C:\caishen\caishenye\infra\vps\windows
   .\install-channels-service.ps1 `
       -BunPath     "C:\Users\Administrator\.bun\bin\bun.exe" `
       -NssmPath    "C:\windows\system32\nssm.exe" `
       -RepoRoot    "C:\caishen\caishenye" `
       -EnvFile     "C:\caishen\channels.env"
   ```

4. **Install the restart-on-idle task** (ADR-009):
   ```powershell
   .\install-restart-on-idle-task.ps1 `
       -RepoRoot    "C:\caishen\caishenye" `
       -EnvFile     "C:\caishen\channels.env" `
       -PsqlPath    "C:\Program Files\PostgreSQL\16\bin\psql.exe"
   ```

5. **Verify**:
   ```powershell
   Get-Service caishen-channels
   Get-ScheduledTask -TaskName caishen-channels-restart-on-idle
   Get-Content C:\caishen\logs\caishen-channels.out.log -Tail 50 -Wait
   ```
   Then from a phone or a different machine, send a `/status` to your
   Telegram bot — within 3s you should see a reply.

## Updating the service after a code push

```powershell
# Pull new code on the VPS.
cd C:\caishen\caishenye
git pull

# bun install only when packages/channels/package.json changed.
& "$env:USERPROFILE\.bun\bin\bun.exe" install --filter '@caishen/channels'

# Restart so the new loop.ts is loaded.
Restart-Service caishen-channels
Get-Content C:\caishen\logs\caishen-channels.out.log -Tail 50
```

## Mapping to the Linux/systemd files

| Windows asset                                    | Linux/systemd equivalent                                 |
|--------------------------------------------------|----------------------------------------------------------|
| `install-channels-service.ps1`                   | `infra/vps/systemd/caishen-channels.service`             |
| `install-restart-on-idle-task.ps1`               | `infra/vps/systemd/caishen-channels-restart.{service,timer}` |
| `restart-on-idle-runner.ps1` (auto-generated)    | `packages/channels/scripts/restart-on-idle.sh`           |
| `C:\caishen\auth-proxy.ts` (operator-deployed)   | `infra/vps/nginx/mt5-bearer.conf`                        |

## Constitution alignment

- **§1 + §13** — no Anthropic API-key env var name in any of these scripts;
  auth is via `claude login`'s on-disk session (subscription-only).
- **§3 audit-or-abort** — `restart-on-idle-runner.ps1` inserts the
  audit row BEFORE the restart and aborts loud if the insert fails.
- **§10 no secrets in source** — env file lives outside the repo at
  `C:\caishen\channels.env` and is gitignored at every level.
- **§15 pre-flight cleanness** — both installers throw on missing Bun,
  NSSM, env file, repo root, or psql. No silent skips.
