# 财神爷 v2 — Product Requirements Document

## Executive Summary

财神爷 v2 is a code-defined AI-agent forex trading system that replaces the existing n8n implementation. A daily Planner agent reads news + the economic calendar to decide today's per-pair trade-window schedule; per-pair Executor agents run the SPARTAN/MSCP multi-timeframe analysis protocol verbatim and execute orders against MetaTrader 5. A live web dashboard and a 24/7 Telegram chat surface provide observability and full operator control. v1 is single-user (the operator-trader) with multi-tenant DB shape so a small group can be onboarded without schema migration. The differentiator is a billing model that uses the operator's existing Claude Code Max 20x subscription with zero per-token API charges, eliminating both the n8n hosting cost and the open-ended cost surface of LLM-API billing.

## Vision & Differentiators

**Vision**: An AI-driven trading desk the operator can run from anywhere — phone or browser — with the same trading IP that the n8n system shipped, but in an application that observes itself, recovers itself, lets the operator override anything in real time, and never bills surprise tokens.

**Differentiators vs. the n8n status quo**:
- **Subscription-only LLM billing**: every LLM call (Planner, Executor, Telegram chat) runs against the operator's Claude Code Max 20x. Eliminates n8n hosting (~$25/mo), eliminates per-token API exposure (the [GitHub#37686 $1,800 surprise](https://github.com/anthropics/claude-code/issues/37686) failure mode is structurally impossible).
- **Code-defined schedule + every-minute cron tick replaces calendar polling**: the daily Planner writes its session decisions to Postgres `pair_schedules` rows; an every-minute Vercel-Postgres-backed cron tick at `/api/cron/fire-due-executors` reads due rows and fires per-pair Executors via the `/fire` API. No Google Calendar, no OAuth churn — scheduling is internal-DB-driven and the every-minute tick is a local Postgres SELECT, not an external poller.
- **Full audit trail**: every agent decision, every tool call, every order is persisted with the Claude Code session ID + URL. Every override is logged with operator + before/after state. Yesterday's reasoning is replayable.
- **Interactive Telegram via Channels**: a single always-on Claude Code session on the operator's VPS handles slash commands AND free-text Q&A through the official Telegram channel plugin. Sub-second response, conversational context preserved across messages.
- **Live mission control dashboard**: Next.js + shadcn/ui on Vercel free tier. P&L, positions, schedule with countdown, per-pair report archive, override actions (close-all, edit SL/TP, force-replan).

**Differentiators vs. typical algo-trading platforms**:
- **The strategist is an LLM**: not a fixed indicator-based system. The SPARTAN prompt encodes a senior trader's discipline; Opus 4.7 with 1M context reads full multi-timeframe candle history (1D 250 bars, 4H 180, 1H 240, 15M 288) without truncation.
- **Macro-aware**: the Planner reads RSS news + the ForexFactory MCP economic calendar before deciding session windows. It will quarantine trade time around NFP, CPI, FOMC, central bank press conferences.

## User Personas

### Persona 1: Tao — The Trader-Operator (primary, only persona in v1)
- **Role**: Sole operator and beneficiary. Runs an automated forex desk on his own MT5 account. Trades 7 pairs intraday across EUR/London + New York sessions.
- **Goals**: Run his desk from his phone or laptop. See P&L, positions, and today's schedule at a glance. Override the bot when his judgment disagrees with the agent's. Read the agent's reasoning after the fact (replay yesterday's trades). Never get surprise-billed for LLM tokens.
- **Pain points** (current n8n system):
  - Calendar-polling triggers fire silently or late, miss session windows.
  - Telegram is one-way: he gets reports but cannot ask follow-up questions or run commands.
  - No live dashboard — he has no single screen showing what the system is doing right now.
  - Adding/changing a pair requires clicking through n8n nodes; can't change strategy in code.
  - LLM bill is unpredictable on per-token API.
- **Technical level**: Advanced — comfortable with Linux VPS, systemd, MT5, REST APIs, Claude Code CLI. Prefers code over GUIs for trading logic. Wants the dashboard for monitoring/override only, not for editing strategy.
- **Devices**: Phone (primary control surface, Telegram), laptop (dashboard, code edits, occasional VPS shell).

## Success Metrics

- **SM-001**: System ships and runs ≥ 30 consecutive calendar days without a missed pair-session due to platform failure (a session window the Planner approved but the Executor never fired). Transient failures that auto-recover within 2 minutes do not count as missed.
- **SM-002**: Operator's monthly Claude-related cost is exactly the cost of his existing Max 20x subscription (no Anthropic API billing, no OpenRouter charges). Verified by inspecting Anthropic console + bank statements; the audit trail in the dashboard reports zero `api_billed_tokens`.
- **SM-003**: For 100% of routine fires (Planner + per-pair Executors), the audit trail in Postgres contains the Claude Code session ID, the session URL, the start/end timestamps, the input text, and either the structured output or the failure reason. Replay-fidelity check at end of every week: pick one random trade, navigate from Postgres → session URL → see the full conversation.
- **SM-004**: Telegram chat (slash commands + free-text Q&A) responds in < 3 seconds p95, < 8 seconds p99, when the Channels session is healthy. Measured by appending `received_at` and `replied_at` timestamps to the Telegram interaction audit log.
- **SM-005**: Dashboard live data freshness ≤ 6 seconds p95 (the time between an MT5 position change and the dashboard reflecting it). Measured via timestamp synthesised in the polling layer vs. the position's MT5 modification time.

## User Journeys

### UJ-001: Daily trade cycle (autonomous)
1. **04:00 GMT**: Daily Planner Routine fires (recurring schedule, cap-counted 1/day).
2. Planner fetches the last 24h of macro news from `https://investinglive.com/feed/`, fetches today's economic calendar via the ForexFactory MCP.
3. Planner runs the existing planner-systemprompt verbatim, outputs `sessions[]` array with Euro/London + New York session start/end times in GMT (or empty strings if a session is quarantined).
4. Planner writes the schedule to Postgres `pair_schedules` table for today's date.
5. Planner inserts one `pair_schedules` row per approved pair-session in `status='scheduled'` with `planner_run_id` FK back to the Planner's audit row. The every-minute cron tick at `/api/cron/fire-due-executors` reads due rows (`start_time_gmt <= now() AND status='scheduled'`) and fires the per-pair Executor via the `/fire` API; on fire it writes back `scheduled_one_off_id` and `status='fired'`. Cap usage is counted on every fire (the cap-exempt-`/schedule` path was discovered to not exist).
6. **Throughout the day**: each scheduled one-off fires its Executor Routine at the planned start time. Executor reads the SPARTAN systemprompt verbatim, fetches multi-timeframe candle data + indicators from MT5 REST + TwelveData, fetches news + calendar, reasons through the MSCP protocol, then executes ONE of: place market order / place pending limit-stop order / modify existing order / do nothing.
7. Executor writes a markdown report + the audit trail (session ID, URL, every tool call, the order placed if any) to Postgres + Vercel Blob.
8. Telegram notification ("EUR/USD report — opened LONG @ 1.0820, SL 1.0795, TP 1.0870") via the Channels session.
9. **End of session**: positions auto-close at the session end (existing trading logic — moved into the Executor or a small "session-end closer" routine, see contract).

**Failure modes**: (a) MT5 REST unreachable → Executor records failure in audit, sends Telegram alert via Channels session, no retry within the same fire (one-off can't re-schedule itself reliably); (b) Routine cap exhausted → cron tick skips lowest-priority pair-sessions per Planner-output ranking; the audit row marks the skip and Telegram alerts the operator; (c) Tool call to ForexFactory MCP fails → Executor proceeds with empty calendar context (degraded but valid); (d) The 5-15min Executor exceeds Anthropic's undocumented routine duration limit → Executor's last action persisted, manual investigation triggered via Telegram alert. **Mitigation for (d) is FR-001's load-bearing checkpoint**.

### UJ-002: Operator checks status from phone (Telegram)
1. Operator sends `/status` to the bot. Channels MCP delivers it to the always-on session on the VPS.
2. Session reads from Postgres + live MT5 REST locally, replies inline with: account balance/equity, today's schedule with countdowns, open positions table, today's P&L.
3. Operator follows up with free text: "why did you skip GBP/USD this morning?" Session reads the relevant routine's audit row, replies with the planner's reasoning.

**Failure modes**: (a) Channels session crashed → systemd `Restart=always` brings it back within seconds; the next message after restart is met with "Session restarted at HH:MM, last seen state at HH:MM" recovery line. (b) GitHub Actions cron health-check sees session down for > 10 min (two consecutive 5-min misses, accommodating GitHub Actions' documented up-to-15-min scheduling jitter) → the cron handler at `/api/cron/channels-health` sends an emergency Telegram via the Telegram Bot API directly (out-of-band, not through the dead session) to alert operator.

### UJ-003: Operator overrides from dashboard
1. Operator opens dashboard at the deployed Vercel URL on his laptop. Auth.js gates entry.
2. Dashboard live-polls (5s SWR) the Postgres state + MT5 REST positions endpoint via the tunnel.
3. Operator decides EUR/JPY position is going wrong, clicks "Close pair: EUR/JPY".
4. Dashboard calls a Next.js Route Handler. Route Handler authenticates the operator, calls MT5 REST `delete_order_pending_symbol_{symbol}` and/or closes any open positions for the symbol.
5. Audit row written to `override_actions` with operator ID, action, before/after state.
6. Dashboard refreshes, position is gone. Telegram notification fires via Channels session ("Operator manually closed EUR/JPY at HH:MM").

**Failure modes**: (a) MT5 REST timeout during override → action shows a clear error toast, does NOT silently fail, operator can retry. (b) Operator session expires mid-action → Auth.js bounces them to login, no partial state.

### UJ-004: Force re-plan today (Telegram or dashboard)
1. Operator types `/replan` in Telegram OR clicks "Force re-plan today" in the dashboard.
2. Channels session (or dashboard route handler) fires the Planner Routine via `/fire` API (cap-counted, costs 1 cap slot).
3. New schedule written to Postgres, replacing today's pair_schedules rows. Any pre-scheduled one-off Executors for the rest of today that no longer have a window are cancelled. New one-offs are scheduled.
4. Operator gets a Telegram message with the new schedule.

**Failure modes**: (a) Daily cap exhausted → operator gets a clear "Cannot replan: cap remaining 0/15 today, resets at HH:MM GMT" reply. (b) `/fire` API beta-header version bumped → operator must roll the pinned `ROUTINE_BETA_HEADER` env to the new value and redeploy; there is no `claude /schedule` fallback because no programmatic `/schedule` API exists. The dashboard's "Force re-plan" button surfaces a clear error pointing at the beta-header pinning ADR.

### UJ-005: Daily review (read-only)
1. Operator opens dashboard, navigates to "History" tab.
2. Dashboard shows trade history (filterable by pair, date, outcome) and per-pair report archive (rendered markdown from Vercel Blob, indexed by Postgres).
3. Operator clicks one trade, sees: the order params, the Executor's full report, and a "View Claude session" link to the recorded session URL.

**Failure modes**: Vercel Blob cold-fetch latency > 2s for a report → render skeleton + spinner, do not block.

## Functional Requirements

> Build order is logical: FR-001 spikes verify the routine duration limit, the `/fire` API beta-header pinning, and the Channels-session 24h token soak. (The original fourth spike — cap-exempt `/schedule`-from-inside-a-routine — was DROPPED in v1.1 per ADR-002 revised, since no programmatic `claude /schedule` API exists.) Everything downstream depends on the surviving three spike outcomes.

### FR-001: Architecture-spike verification of LOAD-BEARING ASSUMPTIONS — routine duration limit, `/fire` API, channels token quota
- **Journey**: UJ-001 (every routine in the system depends on this)
- **Priority**: P0
- **User Story**: As Tao, I want the architecture's three undocumented assumptions verified BEFORE we lock the design, so that we don't ship a system that depends on a broken substrate.
- **Acceptance Criteria**:
  - [ ] AC-001-2: A second test routine measures Executor duration. It runs a representative MSCP-shaped workload: a synthetic Bash step that pulls 250+180+240+288 = 958 candle bars from MT5 REST, runs a single Opus 4.7 reasoning turn, and writes a stub report. Wall-clock ≤ 12 minutes for 2 consecutive runs is **PASS**. > 12 min is **PARTIAL** (architecture splits the Executor into two phases: phase-1 = data fetch + reasoning + decision; phase-2 = order placement, run as a chained one-off if needed).
  - [ ] AC-001-3: The `/fire` API is called once with the current beta header `experimental-cc-routine-2026-04-01` against a no-op routine. Response shape matches the documented `{type: "routine_fire", claude_code_session_id, claude_code_session_url}`. The Generator commits the version-pinning strategy to `architecture.md` ADR (refuse to upgrade beta header silently).
  - [ ] AC-001-4: The Channels session is started once on the VPS with `claude --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions`. Session is left running for 24h while the verification spike routines run normally. At the end, `/usage` is checked: combined token consumption (Routines + Channels) is < 80% of the Max 20x weekly allowance, with one full day of synthetic activity. If ≥ 80%: `architecture.md` records the headroom finding and FR-021 (cap monitoring) gets a hard-stop alert at 12/15 daily routine cap.
- **Edge Cases**:
  - EC-001-2: AC-001-2 fails (run > 12min consistently) AND splitting the Executor introduces too much complexity — fallback escalation: switch Executor LLM to Sonnet 4.6 (faster, less context, but enough for MSCP based on n8n's GPT-5.4 baseline). Recorded in ADR-003.
  - EC-001-3: AC-001-3 fails (beta header rejected) — fallback: ALL programmatic routine triggering uses `claude /run <routine-name>` Bash command from inside another routine or from the Channels session. No HTTP `/fire` calls.
  - EC-001-4: AC-001-4 fails (token usage > 80% after one day) — architecture downgrades Channels session model to Sonnet 4.6 (already default), reduces Channels session's free-text capability (e.g., responses capped at 2K output tokens), or moves slash-command-only paths to Vercel Functions (cheap, deterministic, no LLM in the loop).

### FR-002: Daily Planner Routine (recurring, 04:00 GMT, cap-counted)
- **Journey**: UJ-001
- **Priority**: P0
- **User Story**: As Tao, I want a daily routine that decides today's per-pair trade windows based on news and the economic calendar, so that the trading system never trades blindly through Tier-1 data releases.
- **Acceptance Criteria**:
  - [ ] AC-002-1: A Claude Code routine is created in the Anthropic console with: name `财神爷-planner`, schedule `daily at 04:00 GMT`, model Sonnet 4.6, system prompt = the verbatim contents of `.harness/spec/preserve/planner-systemprompt.md`, ForexFactory MCP attached as a connector, and the bearer token saved as a secret environment variable.
  - [ ] AC-002-2: The routine's body Bash step runs a TypeScript module (`packages/routines/src/planner.ts`) that: (a) GETs `https://investinglive.com/feed/` RSS, (b) filters items in last 24h, (c) renders the markdown summary using the same helper as the existing n8n `Code in JavaScript5` node (port verbatim), (d) injects `Time Now`, `News count`, `markdown` into the user message, (e) calls Claude with the user message, (f) parses the structured `sessions[]` output, (g) writes today's schedule to Postgres `pair_schedules`, (h) persists `pair_schedules` rows in `status='scheduled'` with `planner_run_id` FK back to this audit row; the cron tick at `/api/cron/fire-due-executors` fires them via `/fire` when `start_time_gmt` is reached and writes back `scheduled_one_off_id` + `status='fired'`, (i) writes audit row to `routine_runs` with session_id, session_url, start/end timestamps, input, output.
  - [ ] AC-002-3: Empty `start_time`/`end_time` strings in the planner output are honored — no Executor is scheduled for that pair-session.
  - [ ] AC-002-4: If the routine fails (LLM returns unparseable output, tool error, etc.), it writes a failure audit row AND fires an emergency Telegram via the Channels session (or direct Telegram Bot API as fallback if Channels is down).
- **Edge Cases**:
  - EC-002-1: ForexFactory MCP unavailable at 04:00 GMT → routine proceeds with calendar=empty, marks audit row with `degraded: true`, alerts via Telegram.
  - EC-002-2: RSS feed returns 0 news items → routine proceeds; the planner prompt handles `News count: 0` gracefully (existing behavior).
  - EC-002-3: `pair_schedules` already has rows for today (re-plan was triggered earlier) → routine UPDATEs today's `status='scheduled'` rows to `status='cancelled'` for this `tenant_id` first, then writes new `status='scheduled'` rows. The cron tick's WHERE clause excludes `status='cancelled'` rows, so cancelled rows are never fired. Already-fired rows (`status='fired'`) are left untouched (the in-flight Executor's session continues to completion).

### FR-003: Per-pair Executor Routines (one-off, fired by the cron tick at `/api/cron/fire-due-executors` via `/fire` API; cap-counted)
- **Journey**: UJ-001
- **Priority**: P0
- **User Story**: As Tao, I want a per-pair-session Executor routine that runs the SPARTAN/MSCP protocol verbatim and executes the trade decision, so that today's trading IP is preserved and bills under my subscription.
- **Acceptance Criteria**:
  - [ ] AC-003-1: A SINGLE Claude Code routine is created in the Anthropic console with: name `财神爷-executor`, NO recurring schedule (it's fired as a one-off by the cron tick at `/api/cron/fire-due-executors` via the `/fire` API when a `pair_schedules` row's `start_time_gmt` is reached), model Opus 4.7 (1M context), system prompt = the verbatim contents of `.harness/spec/preserve/spartan-systemprompt.md`, ForexFactory MCP + MT5 REST attached as connectors, the MT5 REST URL pointing through the Tailscale Funnel with bearer auth (FR-009).
  - [ ] AC-003-2: The Executor accepts a `text` input shaped exactly as the existing n8n template: `LET'S START\nCurrent Analysis Pair :\n{PAIR}\n\n{XAU_BLOCK_IF_APPLICABLE}\n\nTime Now: {NOW_GMT}`. The cron tick reads the row's `input_text` (rendered by the Planner at write time and persisted on the `pair_schedules` row, joined back via `planner_run_id`) and passes it as the `/fire` request's input; the Executor reads it as the user message.
  - [ ] AC-003-3: For `XAU/USD` runs, the Executor's MT5 tool calls use the exact symbol `XAUUSD` (no `XAUUSDF`). Verified by audit trail: every tool call to MT5 with `symbol_name` field for the XAU run uses `XAUUSD` exactly. Test: a synthetic XAU/USD run that wraps the real Executor body in a smoke harness — assert all symbol values.
  - [ ] AC-003-4: At end of run, Executor writes a markdown report to Vercel Blob (path `reports/{tenant_id}/{date}/{pair}-{session}.md`), inserts a row into Postgres `executor_reports`, inserts the order detail (or "no trade" decision) into `orders`, and writes the audit row to `routine_runs`.
  - [ ] AC-003-5: Telegram notification fires via Channels session: "{PAIR} executor done — {ACTION}, see /report {pair}". Channels session adds the message to its own audit log.
- **Edge Cases**:
  - EC-003-1: MT5 REST returns 5xx during a tool call → Executor retries 2x with 10s backoff (existing n8n retry behavior). On final failure, marks audit `degraded: true`, places no order, sends Telegram error alert.
  - EC-003-2: Order would breach 5% capital loss rule → SPARTAN prompt's safeguard rejects it (already in the system prompt verbatim). Executor records "rejected by risk rule" in the order row.
  - EC-003-3: Executor exceeds runtime budget mid-run → audit row shows partial state. Recovery: operator sees error in dashboard + Telegram and can manually re-fire via `/fire` (cap-counted) if remediation needed.

### FR-004: Always-on Channels session (Telegram surface)
- **Journey**: UJ-002, UJ-004
- **Priority**: P0
- **User Story**: As Tao, I want a single always-on Claude Code session on my VPS that handles every Telegram message — slash commands and free-text — so that I can run the desk from my phone with conversational context.
- **Acceptance Criteria**:
  - [ ] AC-004-1: A systemd unit file is delivered (`infra/vps/systemd/caishen-channels.service`) with: `ExecStart=/usr/local/bin/claude --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions` (path adjusted per `which claude`), `Restart=always`, `RestartSec=10`, `EnvironmentFile=/etc/caishen/channels.env` (non-git-tracked), `User=caishen`, `WorkingDirectory=/opt/caishen-channels`, `StandardOutput=append:/var/log/caishen-channels.log`, `StandardError=append:/var/log/caishen-channels.err`.
  - [ ] AC-004-2: An init.sh-shipped instruction set (NOT executable on dev laptop, the operator runs it on the VPS once) installs Claude Code CLI, runs `claude login`, installs the Telegram channel plugin, copies the systemd unit to `/etc/systemd/system/`, enables + starts it.
  - [ ] AC-004-3: The session has a system prompt + tool allowlist defined as a Claude Code subagent config in `/opt/caishen-channels/.claude/agents/caishen-telegram.md` (ships in repo, deployed to VPS via init.sh). System prompt explains: you handle slash commands AND free-text; you have access to Postgres (read+write to override_actions only, read everywhere else), MT5 REST, ForexFactory MCP. Tool allowlist: `Bash` (constrained to a strict allowlist of script paths), `mcp__mt5_rest_*`, `mcp__ffcal_*`, `mcp__postgres_query`, `Read`, `Write` (only inside `/opt/caishen-channels/`).
  - [ ] AC-004-4: Slash commands implemented as Claude Code subagent tools or scripts: `/status`, `/positions`, `/report <pair>`, `/balance`, `/history`, `/pause`, `/resume`, `/closeall`, `/closepair <pair>`, `/replan`, `/edit <symbol> <ticket> sl=<price> tp=<price>`. Each writes an audit row to `telegram_interactions`.
  - [ ] AC-004-5: Free-text message (no leading slash) is handled as a normal Q&A turn — session uses its tools to answer ("why did you skip GBP/USD this morning?" → reads `routine_runs` table, summarises). Reply latency p95 ≤ 3 sec, p99 ≤ 8 sec (SM-004).
  - [ ] AC-004-6: Allowlist of permitted Telegram user IDs is enforced at the session level — only IDs in the `tenants.allowed_telegram_user_ids` JSON column (per-tenant, JSON array of integer Telegram user IDs) may elicit substantive responses. Operator supplies the actual IDs via VPS env var `ALLOWED_TELEGRAM_USER_IDS` (comma-separated) at setup time; `infra/vps/setup.sh` writes them into the seeded tenant row. Off-allowlist messages get a polite English refusal ("Sorry, this assistant is private — please contact the operator if you believe this is in error.") AND insert a `telegram_interactions` audit row with `from_user_id` populated and `command_parsed='REJECTED_NOT_ALLOWED'`. No tool calls are made for rejected messages.
- **Edge Cases**:
  - EC-004-1: Session crashes mid-conversation → systemd restarts within ~10s, next message gets a "Session restarted at HH:MM, last seen state at HH:MM" recovery line plus the answer to the user's query.
  - EC-004-2: Tao sends a destructive free-text command ("delete all data") → session refuses (Bash allowlist rules out arbitrary `rm`/`drop table`).
  - EC-004-3: Session prompt drift over a long-running session → Claude Code's normal compaction handles this; if memory pressure seen, session can be restarted manually via `systemctl restart caishen-channels`.

### FR-005: Channels-session health check + crash recovery
- **Journey**: UJ-002 (failure path)
- **Priority**: P0 (the brainstorm calls Channels reliability the second-hardest part)
- **User Story**: As Tao, I want a GitHub Actions cron workflow pinging the Channels session every 5 min (best-effort — GitHub Actions cron has documented up-to-15-min jitter; the 10-min unhealthy threshold absorbs it) and alerting me directly via Telegram Bot API (out-of-band) if it's down for >10 min, so that I learn about Telegram outages within ~25 min max worst-case (15-min jitter + 10-min unhealthy window). Trigger source = GitHub Actions to keep the entire monitoring stack on Vercel Hobby (free tier) per the project's subscription-only cost discipline.
- **Acceptance Criteria**:
  - [ ] AC-005-1: A small healthcheck endpoint runs on the VPS (FastAPI/Express stub on a local port, exposed via the same Tailscale Funnel as MT5 REST at a path like `/_health` or as a separate `health.{TAILSCALE_FUNNEL_HOSTNAME}` if Funnel multi-host is needed). The endpoint requires the same `Authorization: Bearer ${HEALTH_BEARER_TOKEN}` (separate token from MT5's, so a leaked MT5 token can't probe health internals). It returns `{healthy: true, uptime_sec, last_message_handled_at}` IF: systemd shows the channels unit `active (running)` AND the session has handled a message OR a synthetic ping in the last ~45 min (the 30-min target cadence of the synthetic-ping GitHub Actions cron plus the documented up-to-15-min GH Actions cron jitter — the loose cadence absorbs jitter without false-alerting on quiet markets).
  - [ ] AC-005-2: A GitHub Actions cron workflow (`.github/workflows/cron-channels-health.yml`, schedule `*/5 * * * *` — best-effort given GH Actions' documented up-to-15-min scheduling jitter) curls a Next.js Route Handler at `/api/cron/channels-health` with `Authorization: Bearer ${{ secrets.CRON_SECRET }}`. The handler hits the VPS healthcheck endpoint via the Tailscale Funnel. If healthy: insert audit row `channels_health` with `healthy=true`. If unhealthy or unreachable: insert row with `healthy=false`, AND if the previous N=2 checks were also unhealthy (≥10 min of consecutive unhealthy state in the audit table — note "≥10" rather than "exactly 10" to absorb jitter), send an alert via direct Telegram Bot API (not through the dead Channels session — use the bot token + the operator's chat ID directly). The CRON_SECRET MUST be set in GitHub repo Secrets (Settings → Secrets and variables → Actions → New repository secret) AS WELL AS Vercel project env (so the handler can verify it). Vercel Hobby plan stays in scope; sub-daily crons cannot live on Vercel Hobby.
  - [ ] AC-005-3: When the Channels session restarts and handles its first message, it reads the recent `channels_health` rows; if it sees an unhealthy streak in the past hour, it self-announces ("I'm back online; was down between HH:MM and HH:MM").
- **Edge Cases**:
  - EC-005-1: Tunnel is down (not the session itself) → cron sees timeout; cannot distinguish "session dead" from "tunnel dead". Alert text says "Cannot reach VPS healthcheck — session OR tunnel". Operator investigates via SSH.
  - EC-005-2: Multiple rapid restarts ("flapping") → cron's audit table makes it visible. Max alert frequency: 1 alert per hour per failure (no spam).

### FR-006: Mission-control dashboard (Next.js + shadcn/ui, Vercel)
- **Journey**: UJ-003, UJ-005
- **Priority**: P0
- **User Story**: As Tao, I want a live web dashboard that shows me everything the trading system is doing right now AND lets me override any of it, so that I can run the desk from a browser.
- **Acceptance Criteria**:
  - [ ] AC-006-1: Dashboard is built as a Next.js 16 App Router project with shadcn/ui components, deployed to Vercel free tier. Auth.js v5 gates every route via the WebAuthn/passkey provider; login is single-user (Tao registers a passkey on his phone AND a passkey on his laptop during first-run setup; both are bound to the operator email `tao@belcort.com` at registration). Subsequent logins use platform authenticators (Touch ID / Windows Hello / phone biometric). All routes except `/login`, `/auth/passkey-register` (one-time, gated by `INITIAL_REGISTRATION_TOKEN` env var), and `/api/cron/*` (CRON_SECRET-gated) require an authenticated session. No SMTP/magic-link infrastructure is provisioned in v1; if passkeys prove clunky, `/harness:edit` swaps the Auth.js provider in a single config change.
  - [ ] AC-006-2: Five core screens are present: **Overview** (balance/equity, today's P&L, today's schedule with countdowns, open positions table), **Per-pair Detail** (per-pair history, last report, current position), **Schedule** (today's schedule + "force re-plan" button), **History** (filterable trade history, per-pair report archive with rendered markdown, transparent cold-archive fetch per FR-007 EC-007-2), **Override Panel** (close-all, close-pair, edit-SL/TP forms, audit of recent overrides). Design source: if `design/dashboard-bundle/index.html` exists, the Generator's `frontend-design` skill consumes the bundle directly. If the bundle does NOT exist, the Generator invokes `frontend-design` skill on the AC-006-2 wireframe descriptions above (text-based generation from the PRD); the implementation report MUST explicitly flag "design generated from text — Claude Design bundle was not present at build time" so the operator knows to run a Claude Design pass and re-iterate. `init.sh` prints an "operator action required" warning (per FR-020 AC-020-3) when the bundle is missing, with instructions for what to export and where to put it.
  - [ ] AC-006-3: Live data refresh: SWR polling at 5s interval for the Overview screen's balance/equity/positions. Stale data > 30s shows a yellow "stale" banner; > 60s shows red.
  - [ ] AC-006-4: Override actions invoke Next.js Route Handlers that: (a) re-verify Auth.js session, (b) call MT5 REST through the tunnel, (c) write `override_actions` audit row, (d) trigger Channels session to broadcast Telegram notification to operator.
  - [ ] AC-006-5: Force re-plan button calls the Planner `/fire` endpoint with the pinned beta header. Shows toast on success, updates schedule view, audit row in `routine_runs`. If cap exhausted → clear error message with reset time.
- **Edge Cases**:
  - EC-006-1: Tunnel down → MT5-REST-backed views show "Live data unavailable, showing last known state from {timestamp}". DB-only views remain fully functional.
  - EC-006-2: Operator opens dashboard during a Planner run → Schedule screen shows "Re-planning in progress" with a spinner; refreshes to new schedule on completion.

### FR-007: Audit trail across the entire system
- **Journey**: UJ-005, all flows
- **Priority**: P0 (operator's hard line)
- **User Story**: As Tao, I want a complete tool-call-by-tool-call audit of every routine run, every Telegram interaction, and every override, so that I can replay yesterday's reasoning without ambiguity.
- **Acceptance Criteria**:
  - [ ] AC-007-1: Every routine fire (Planner OR Executor) inserts a row in `routine_runs` at run start with `tenant_id`, `routine_name`, `pair`, `session_window`, `started_at`, `claude_code_session_id`, `claude_code_session_url`, `input_text`, `status='running'`. At run end, the row is updated with `ended_at`, `output_json`, `tool_calls_count`, `status='completed'|'failed'|'degraded'`, `failure_reason`. **Failure to write the start row is a fatal error** — the routine refuses to proceed if it can't write its provenance.
  - [ ] AC-007-2: Every Telegram interaction (slash command OR free-text OR rejected) inserts a row in `telegram_interactions`: `tenant_id`, `received_at`, `replied_at`, `from_user_id`, `message_text`, `command_parsed`, `tool_calls_made_json`, `reply_text`, `claude_code_session_id`. The `command_parsed` field is one of: a recognised slash command (e.g., `/status`, `/closepair`), `FREE_TEXT` for free-text Q&A, or `REJECTED_NOT_ALLOWED` for messages from off-allowlist user IDs (per AC-004-6). Rejected rows have empty `tool_calls_made_json` and NULL `claude_code_session_id` (no LLM turn was spent).
  - [ ] AC-007-3: Every dashboard override action inserts a row in `override_actions`: `tenant_id`, `at`, `operator_user_id`, `action_type`, `target_pair`, `target_ticket`, `params_json`, `before_state_json`, `after_state_json`, `success`, `error_message`.
  - [ ] AC-007-4: Every order placed/modified/closed (whether by Executor, Channels session, or Override Panel) inserts a row in `orders` with full params and a back-reference to whichever audit row caused it (`source_table`, `source_id`).
  - [ ] AC-007-5: A "Replay" link in the dashboard's History view opens `claude_code_session_url` in a new tab, allowing the operator to read the full Claude session trace for that routine run.
- **Edge Cases**:
  - EC-007-1: Postgres write fails mid-run → Executor must abort and surface the audit-write failure. We never proceed without provenance.
  - EC-007-2: Audit table grows unboundedly → daily Vercel cron at 03:30 GMT archives rows older than `AUDIT_HOT_DAYS` (default **365**) to a separate Vercel Blob "cold archive" prefix at `archive/{tenant_id}/{YYYY-MM}/`. Operator can override by setting `AUDIT_HOT_DAYS` env var (e.g., `=90` to recover Neon space). Dashboard "History" view transparently fetches from cold archive when the user filters to a date older than `AUDIT_HOT_DAYS`: Route Handler mints a signed Blob URL (`expires-in 1h`), page renders skeleton + "loading from archive…" spinner, then displays the rows from the fetched JSON. Resolved per clarify Q6 (2026-05-01); see ADR-006.

### FR-008: Postgres schema with multi-tenant `tenant_id` from day one
- **Journey**: foundation for FR-002 through FR-007
- **Priority**: P0
- **User Story**: As Tao, I want every table to have `tenant_id` from day one so that opening the system to a small group later doesn't require a migration.
- **Acceptance Criteria**:
  - [ ] AC-008-1: A migration tool (Drizzle Kit recommended; final pick is in architecture ADR) creates these tables: `tenants` (id, name, created_at), `pair_configs` (tenant_id, pair_code, mt5_symbol, sessions_json [array of allowed session windows like `["NY","EUR"]`], active_bool), `pair_schedules` (tenant_id, date, pair_code, session_name, start_time_gmt, end_time_gmt, planner_run_id, scheduled_one_off_id, status), `routine_runs` (full schema per AC-007-1), `executor_reports` (tenant_id, routine_run_id, pair, session, report_md_blob_url, summary_md, action_taken, created_at), `orders` (tenant_id, ticket, pair, type, volume, price, sl, tp, opened_at, closed_at, source_table, source_id, status, pnl), `override_actions` (per AC-007-3), `telegram_interactions` (per AC-007-2), `channels_health` (tenant_id, checked_at, healthy_bool, latency_ms, error).
  - [ ] AC-008-2: Every query in app code includes `WHERE tenant_id = $1` (no global queries). A test asserts that the v1 single-tenant row is `tenant_id = 1` and that the queries built by the app correctly filter on it.
  - [ ] AC-008-3: Indexes on `routine_runs(tenant_id, started_at DESC)`, `pair_schedules(tenant_id, date)`, `orders(tenant_id, opened_at DESC)`, `telegram_interactions(tenant_id, received_at DESC)`, `executor_reports(tenant_id, created_at DESC)`.
- **Edge Cases**:
  - EC-008-1: A migration is added later that needs to reshape `tenant_id` rules → captured in changelog + ADR; no v1 fork.

### FR-009: VPS-to-cloud public tunnel for MT5 REST + ForexFactory MCP (Tailscale Funnel + app-layer bearer)
- **Journey**: UJ-001, UJ-003
- **Priority**: P0
- **User Story**: As Tao, I want my VPS-resident MT5 REST endpoint and ForexFactory MCP reachable from Routines (Anthropic cloud) and Vercel functions (the dashboard's MT5 reads), via a free tunnel that doesn't require me to own a domain, so I can ship v1 today and migrate to a custom-domain transport later.
- **Acceptance Criteria**:
  - [ ] AC-009-1: Tailscale is installed on the VPS, the VPS is joined to the operator's tailnet via `tailscale up`, and `tailscale funnel` is configured (as a systemd service `tailscale-serve.service` so it persists across reboots, OR via `tailscale funnel --bg`) to expose the MT5 REST port and the ForexFactory MCP port (if it serves HTTP) on the auto-assigned `*.ts.net` hostname (e.g., `caishen-vps.tailNNN.ts.net`). The hostname is captured into a VPS env var `TAILSCALE_FUNNEL_HOSTNAME` and surfaced to Vercel + Routines as `MT5_BASE_URL=https://{TAILSCALE_FUNNEL_HOSTNAME}` (and `FFCAL_BASE_URL` similarly if FF MCP is HTTP-exposed).
  - [ ] AC-009-2: App-layer auth replaces what Cloudflare Access previously provided: a shared bearer token `MT5_BEARER_TOKEN` (generated at VPS setup, stored in `/etc/caishen/channels.env` and `tunnel-bearer.env`, surfaced to Vercel + Routines as a secret) is required on every request to MT5 REST endpoints in the form `Authorization: Bearer <token>`. The operator's existing MT5 REST gateway is wrapped (or modified) to enforce the bearer at HTTP level — requests without a valid bearer return 401. ForexFactory MCP, if HTTP-exposed, gets the same treatment with `FFCAL_BEARER_TOKEN`.
  - [ ] AC-009-3: Direct unauthenticated requests to the public `*.ts.net` hostname return 401 (verified via curl from the dev laptop, with `Authorization` header omitted). Confirmed by an `init.sh` smoke-test stage. Note: the Funnel surface is intentionally public (Tailscale Funnel exposes services to the open internet); auth lives in the app layer per AC-009-2.
  - [ ] AC-009-4: `init.sh` on the dev laptop verifies that `curl -H "Authorization: Bearer ${MT5_BEARER_TOKEN}" https://${TAILSCALE_FUNNEL_HOSTNAME}/get_account_info5` returns a JSON response with the operator's account info. Failure here is a hard stop — the rest of the system is unbuildable.
- **Edge Cases**:
  - EC-009-1: Tailscale Funnel hiccup or VPS-to-tailnet disconnect → Routines retry per FR-003 EC-003-1 logic; dashboard shows "Live data unavailable" per FR-006 EC-006-1.
  - EC-009-2: Bearer token rotation needed → documented in `init.sh` + `decisions.md`; rotation requires updating Vercel env (`MT5_BEARER_TOKEN`), each routine's secret-environment-variable, the VPS `/etc/caishen/channels.env`, AND the gateway's accepted-tokens list in a single coordinated step. Bearer rotation is a planned-outage operation (≤ 60s).
  - EC-009-3: Operator later acquires a custom domain and wants to switch back to Cloudflare Tunnel + Access Service Token → run `/harness:edit "switch VPS-to-cloud transport from Tailscale Funnel to Cloudflare Tunnel + Access Service Token using domain {domain}"`. The cascade re-introduces ADR-005's previous pattern (CF-Access-Client-Id / CF-Access-Client-Secret headers) and updates Stack/init.sh/env-vars accordingly. v1 does NOT ship this path.

### FR-010: Subscription-only auth — no `ANTHROPIC_API_KEY` anywhere
- **Journey**: foundation for SM-002
- **Priority**: P0 (operator's hard line)
- **User Story**: As Tao, I want a structural guarantee that no `ANTHROPIC_API_KEY` exists anywhere in the codebase, infra, or Vercel env, so that the GitHub#37686 surprise-billing failure mode cannot occur.
- **Acceptance Criteria**:
  - [ ] AC-010-1: A pre-commit hook + CI lint rule scans all source files (including `.env*`, `.json`, `.md`) for the pattern `ANTHROPIC_API_KEY` and rejects any commit that contains it.
  - [ ] AC-010-2: Routines authenticate via per-routine bearer tokens (auto-issued by Anthropic at routine creation time, stored as Vercel/VPS secrets — never in repo).
  - [ ] AC-010-3: The Channels session on the VPS authenticates via `claude login` (interactive OAuth to claude.ai, performed during VPS setup; subsequent restarts use the cached credentials in `~/.claude/`).
  - [ ] AC-010-4: The dashboard's `/fire` calls to the Planner routine use the Planner's bearer token, scoped to that routine only.
  - [ ] AC-010-5: A `make audit-no-api-key` (or equivalent npm script) runs the lint rule + greps Vercel env (`vercel env ls`) for the forbidden key and exits 0 only if all clean.
- **Edge Cases**:
  - EC-010-1: A dependency (e.g., a test fixture) somewhere generates `ANTHROPIC_API_KEY` in its README — pre-commit hook rejects, dependency is patched or excluded from the scan with an explicit allowlist comment.

### FR-011: Pair config (DB-driven)
- **Journey**: UJ-001
- **Priority**: P1
- **User Story**: As Tao, I want pair configuration to live in Postgres so I can add a pair (when v2 lifts the cap) without redeploying.
- **Acceptance Criteria**:
  - [ ] AC-011-1: `pair_configs` table seeded with v1's 7 pairs (default values shown). Each row: `tenant_id, pair_code, mt5_symbol, sessions_json, active_bool, created_at`.
  - [ ] AC-011-2: Planner reads `WHERE tenant_id=$1 AND active_bool=true` and only schedules executors for pairs returned (so a pair can be flipped off without a code change).
  - [ ] AC-011-3: Dashboard shows pair list as read-only in v1 (no editing UI yet — recorded in `out-of-scope`).
- **Edge Cases**:
  - EC-011-1: A row's `mt5_symbol` is changed from `XAUUSD` to `XAUUSDF` accidentally → Executor's hard-coded XAU/USD symbol-cleaning logic in the SPARTAN prompt overrides this. Documented as a known "belt and suspenders" guard in `decisions.md`.

### FR-012: V1 pair list seed
- **Journey**: UJ-001
- **Priority**: P0
- **User Story**: As Tao, I want the system seeded with exactly the 7 pairs and per-pair session rules I specified, so that the agent fires for the right pairs at the right times on day 1.
- **Acceptance Criteria**:
  - [ ] AC-012-1: Seed migration inserts: `EUR/USD` (sessions: EUR, NY), `EUR/JPY` (sessions: EUR, NY), `EUR/GBP` (sessions: EUR, NY), `USD/JPY` (sessions: EUR, NY), `GBP/USD` (sessions: EUR, NY), `USD/CAD` (sessions: NY only), `XAU/USD` (sessions: EUR at 0730 GMT mandatory + NY at 1300 GMT, mt5_symbol = `XAUUSD`).
  - [ ] AC-012-2: GBP/JPY is **NOT** seeded — explicitly excluded in v1 per scope.
  - [ ] AC-012-3: Per-day fire count, derived from this seed: 1 Planner + (6 pairs × 2 sessions = 12) + (USD/CAD × 1 session = 1) + (XAU/USD × 2 sessions, but EUR is mandatory 0730 only and NY 1300 only = 2 already counted as part of normal NY)... math from the brainstorm: 1 + 13 = 14 Executors max if all sessions are approved by the planner + 1 buffer.
- **Edge Cases**:
  - EC-012-1: Planner approves only 1 session for a pair → fewer Executors fire that day; cap usage drops. No issue.
  - EC-012-2: Planner approves a session for USD/CAD's EUR window even though the seed says NY-only → Planner output is constrained at parsing time: schedules that don't match the pair's `sessions_json` are dropped with a warning audit row.

### FR-013: Code interpreter substitute for the Executor (`compute_python` MCP)
- **Journey**: UJ-001
- **Priority**: P1 (conditional — see AC-013-1 below)
- **User Story**: As Tao, I want the Executor to have access to a sandboxed Python execution tool for any heavy math (ATR computation, position-size math) that would be awkward in pure prompt reasoning, so that the n8n GPT-5.4 system's code-interpreter capability isn't lost in the migration.
- **Acceptance Criteria**:
  - [ ] AC-013-1: **Conditional build, gated on FR-001 AC-001-2 math-fidelity outcome**: as part of FR-001 AC-001-2, the spike runs a synthetic ATR computation on a known-answer dataset, comparing Opus 4.7's output to a Python reference implementation (the spike report includes a "Math fidelity check" section). If max relative error is < 1e-3, FR-013 is moved to "out of scope v1, ticket for v2"; `compute_python` MCP is NOT built and FR-013 is marked SKIPPED in `decisions.md` with the spike's evidence. If max relative error is ≥ 1e-3 OR Opus refuses to compute (rare), FR-013 builds per the original spec: a `compute_python` MCP server is attached to the Executor routine as a connector, accepts a Python expression/snippet and returns the result, runs on Vercel Sandbox (or a similar ephemeral execution environment); spec doesn't lock the impl, see ADR. Either decision is recorded in `decisions.md` with the spike report citation.
  - [ ] AC-013-2: IF FR-013 is built (math-fidelity FAILED): the Executor system prompt is NOT modified to mention `compute_python` (preserve verbatim is non-negotiable). Instead, the tool is documented in the routine connector list; Opus 4.7 is left to discover when to call it (it's good at this). IF FR-013 is skipped (math-fidelity PASSED): no Executor changes, `compute_python` MCP is not provisioned, Vercel Sandbox attack surface is not introduced.
- **Edge Cases**:
  - EC-013-1: IF FR-013 is built and `compute_python` adds latency that pushes the Executor past the duration limit → fallback per FR-001 EC-001-2.
  - EC-013-2: IF FR-013 is skipped at build time but operator later observes ATR drift in production → re-open via `/harness:edit "build FR-013 compute_python MCP per original AC-013-1 fallback path"`. The conditional is reversible.

### FR-014: News fetch + markdown rendering (port from n8n `Code in JavaScript5`)
- **Journey**: UJ-001 (Planner step)
- **Priority**: P0
- **User Story**: As Tao, I want the Planner routine to ingest the same RSS news feed and render it in the same markdown shape, so that the planner-systemprompt's downstream reasoning behaves identically to n8n's behavior.
- **Acceptance Criteria**:
  - [ ] AC-014-1: A TypeScript module (`packages/routines/src/news.ts`) ports the `Code in JavaScript5` node verbatim: 24h window, GMT timezone, sort newest-first, strip HTML, render `### N. Title\n**Time:** ... \n**Summary:** ...\n---\n`.
  - [ ] AC-014-2: Unit tests against frozen RSS fixtures (saved in `tests/fixtures/rss/`) verify identical output to a snapshot of the n8n version's output for the same input.
  - [ ] AC-014-3: Output is the EXACT shape `{news_count, time_window_start, markdown}` that the Planner system prompt expects.
- **Edge Cases**:
  - EC-014-1: RSS feed unreachable → return `{news_count: 0, markdown: "No news found in the last 24 hours."}` (matches existing behavior).

### FR-015: Trade history + report archive (Vercel Blob)
- **Journey**: UJ-005
- **Priority**: P0
- **User Story**: As Tao, I want every Executor's report saved as immutable markdown so I can read the full trader-style writeup days later.
- **Acceptance Criteria**:
  - [ ] AC-015-1: Reports written to Vercel Blob path `reports/{tenant_id}/{YYYY-MM-DD}/{pair-slug}-{session}.md`. Public-read disabled; signed URLs minted by Next.js Route Handlers, expires-in 1h.
  - [ ] AC-015-2: `executor_reports` row links to the Blob URL. History page renders the markdown via Next.js `react-markdown` (or shadcn's MD renderer if shipped).
- **Edge Cases**:
  - EC-015-1: Blob upload fails after Executor runs → Executor retries 2x; on final failure, report stays in Postgres as a `summary_md` text column (degraded, but visible in the Blob-less history view).

### FR-016: Override actions — close-pair / close-all / edit-SL/TP
- **Journey**: UJ-003
- **Priority**: P0
- **User Story**: As Tao, I want to override the bot from either the dashboard or Telegram, so that I can act when my judgment disagrees with the agent.
- **Acceptance Criteria**:
  - [ ] AC-016-1: From dashboard: "Close pair" button per pair → calls Route Handler → fetches all open positions for the pair via MT5 REST, closes each via `delete_order_pending_*` or position-close endpoints, writes `override_actions` row, fires Telegram notification.
  - [ ] AC-016-2: From dashboard: "Close all" button → confirms (modal "type CLOSE-ALL to confirm") → loops all pairs, behaves as repeated Close-pair.
  - [ ] AC-016-3: From dashboard: "Edit SL/TP" form per open position → validates, calls MT5 REST `put_order_pending_{id}5` (or position-modify equivalent), writes audit row.
  - [ ] AC-016-4: From Telegram (via Channels session): `/closepair EUR/USD`, `/closeall`, `/edit EUR/USD <ticket> sl=1.0790 tp=1.0850` — same audit row schema, same MT5 REST calls. Channels session is the executor here.
- **Edge Cases**:
  - EC-016-1: Two simultaneous overrides (dashboard + Telegram) for the same target → both writes produce audit rows; the second sees the first's after-state and either becomes a no-op or applies on top, audit captures both attempts.

### FR-017: Pause / resume agent
- **Journey**: UJ-002, UJ-003
- **Priority**: P0
- **User Story**: As Tao, I want a kill switch that stops new Executors from being scheduled (and cancels pending one-offs for today) so I can pause the desk.
- **Acceptance Criteria**:
  - [ ] AC-017-1: `agent_state` table has a singleton row per `tenant_id` with `paused_bool` + `paused_at` + `paused_by`. Default `paused_bool=false`.
  - [ ] AC-017-2: Planner routine reads `agent_state` at start; if `paused`, it logs a "skipped: paused" audit row and exits without writing a schedule.
  - [ ] AC-017-3: `/pause` from Telegram OR dashboard "Pause" button → updates `agent_state.paused_bool=true`, then UPDATEs all today's `pair_schedules` rows in `status='scheduled'` to `status='cancelled'` (a status update, not a routine-API call — the cron tick's WHERE clause excludes `status='cancelled'` so they will never fire). Already-fired rows (`status='fired'`) are left alone; the in-flight Executor's pre-fire stale-check sees `paused=true` and noops.
  - [ ] AC-017-4: Pre-fire check inside Executor: read `agent_state`; if paused, write a "skipped: paused at fire-time" audit row and exit BEFORE making any MT5 calls.
- **Edge Cases**:
  - EC-017-1: Resume mid-day → next Planner run is tomorrow; today's already-cancelled schedule won't be re-issued unless operator triggers `/replan`.

### FR-018: Force re-plan
- **Journey**: UJ-004
- **Priority**: P0
- **User Story**: As Tao, I want a force re-plan button (dashboard) and `/replan` command (Telegram) that re-fires the Planner routine, so that mid-day news shifts can be reflected in the schedule.
- **Acceptance Criteria**:
  - [ ] AC-018-1: Both surfaces hit the Planner routine via `/fire` API (cap-counted). Both check current cap usage before firing; if `<=2` slots remaining, ask for explicit confirmation.
  - [ ] AC-018-2: After re-plan: today's `pair_schedules` rows in `status='scheduled'` for this `tenant_id` are UPDATEd to `status='cancelled'` (best-effort; cron tick's WHERE clause excludes them); new `status='scheduled'` rows written. Already-fired rows (`status='fired'`) are left untouched. Dashboard schedule view live-updates.
  - [ ] AC-018-3: Telegram broadcasts the new schedule.
- **Edge Cases**:
  - EC-018-1: Re-plan fires while an Executor is in-flight → in-flight Executor finishes (it has its own session, status already `fired`); cancelled rows in `status='cancelled'` are noop'd by the cron tick (its WHERE clause excludes them); only `status='scheduled'` rows are replaced.

### FR-019: Telegram report messages (preserve existing behavior)
- **Journey**: UJ-001
- **Priority**: P0
- **User Story**: As Tao, I want every Executor's completion to send me a concise report in Telegram (similar to the existing n8n `Send a text message5` behavior), so that I see results in real time.
- **Acceptance Criteria**:
  - [ ] AC-019-1: Executor's last step uses the Channels session as the conduit (writes a row to a `pending_telegram_messages` queue table; Channels session polls the queue every few seconds and emits the message). Or simpler: Executor uses Telegram Bot API directly (subscription-billed only on the Channels-session side; sending from a routine via the bot HTTP API doesn't burn LLM tokens). Architecture ADR-007 picks one path.
  - [ ] AC-019-2: Message body matches the n8n format roughly: `{PAIR}\n{ACTION}\n{KEY_NUMBERS}\nSee /report {pair} for full reasoning`.
  - [ ] AC-019-3: Errors during the Executor produce a different alert message: `{PAIR} ERROR\n{error_message}\nAudit: routine_run_id={...}`.
- **Edge Cases**:
  - EC-019-1: Telegram Bot API rate-limited → message is queued, retried with backoff (existing n8n's `onError: continueRegularOutput` behavior).

### FR-020: Initial setup script (`init.sh`) — dev laptop + VPS
- **Journey**: bootstrap
- **Priority**: P0
- **User Story**: As Tao, I want a single script that, when run on my dev laptop and then on my VPS, bootstraps the entire system including the Channels session systemd unit, so that "from clone to running" is a documented and reproducible sequence.
- **Acceptance Criteria**:
  - [ ] AC-020-1: `init.sh` on the dev laptop verifies: Node >= 20, **Bun installed (or installs it — Bun is the canonical package manager for this project per clarify Q10, used on local dev + Vercel build + VPS scripts)**, git clean working tree, `bun install`, runs lint + tsc + tests via `bun run`, runs `make audit-no-api-key`, smoke-tests **Tailscale Funnel + bearer-token auth** (FR-009 AC-009-4 — see also patch 3 for the Q2 architecture change). The `package.json` `packageManager` field pins `bun@<version>` and `bun.lock` is committed; Vercel project settings: install command = `bun install`, build command = `bun run build`.
  - [ ] AC-020-2: A separate `init.sh` (or a sub-script) for the VPS — printed by the dev-laptop init.sh as next-step instructions to copy-paste — installs Claude Code CLI + Bun + Tailscale on the VPS, runs `claude login` interactively, joins the tailnet via `tailscale up`, configures `tailscale funnel` for MT5 REST + healthcheck (per FR-009 AC-009-1), installs the Telegram channel plugin, copies the systemd unit, enables + starts the channels service, verifies it runs and `/status` from Telegram returns a real reply.
  - [ ] AC-020-3: init.sh fails LOUDLY on any unfixable warning (per the operator's auto-memory rule about preflight cleanness). Each unfixable is explained with what would need to happen to fix it.
- **Edge Cases**:
  - EC-020-1: VPS is a Windows VPS (the brainstorm did not lock the OS) → init.sh's VPS portion includes Windows variants OR fails with a clear "Linux-only for v1" message and points to a v2 ticket. **Silent default**: assume Linux; surface in `## Silent Defaults` for `/harness:clarify`.

### FR-021: Daily cap monitoring + alerts
- **Journey**: UJ-001 (operational health)
- **Priority**: P0
- **User Story**: As Tao, I want visibility into daily routine cap usage and alerts when it's running low, so that I never wake up to find the system silently cap-blocked.
- **Acceptance Criteria**:
  - [ ] AC-021-1: V1 ships local-counter-derived cap data: every cap-burning code path (Planner routine fire, each Executor one-off fire, dashboard `/fire`-driven re-plan, the cap-status cron itself) inserts a row into `cap_usage_local` (`tenant_id`, `at`, `cap_kind ∈ {planner_recurring, executor_one_off_cap_counted, replan_fire, cap_status_cron}`, `routine_runs_id` FK). A Vercel cron at 12:00 GMT computes today's totals from `cap_usage_local` and inserts a daily `cap_usage` row (`tenant_id`, `date`, `daily_used`, `daily_limit=15`, `weekly_used`, `weekly_limit`, `source='local_counter'`). If FR-001 spike confirms `/v1/usage` is exposed, a follow-on Vercel cron also fetches Anthropic-reported numbers daily and inserts a parallel `cap_usage` row with `source='anthropic_api'`; drift > 1 slot triggers a Telegram alert. Headless-browser scrape is **explicitly out of scope** for v1.
  - [ ] AC-021-2: Dashboard Overview shows current cap usage as a progress bar (X/15 daily, Y% weekly).
  - [ ] AC-021-3: At 12/15 daily: warning Telegram message via Channels session ("Cap warning: 12/15 used today, ~N/total weekly"). At 14/15: hard alert + dashboard banner.
  - [ ] AC-021-4: Cap-usage interpretation: every Executor fire is `/fire`-API-driven and cap-counted (no cap-exempt path exists). Daily cap budget = 1 Planner + N Executors per pair-session approved by the Planner (typically up to 13 on a fully-approved day, leaving ≥1 slot for an operator-driven re-plan). Cap-exhaustion fallback: the cron tick skips lowest-priority pair-sessions per the Planner output's ranking and writes `status='skipped_cap_exhausted'` on the corresponding `pair_schedules` rows; Telegram alerts the operator. Dashboard tooltip on the cap-progress-bar describes this unconditional model.
- **Edge Cases**:
  - EC-021-1: Anthropic cap counters lag → dashboard shows a "data may be stale up to 5 min" note next to the bar.
  - EC-021-2: Cap-counter routine itself fails → emergency Telegram via direct bot API.

### FR-022: Per-pair MT5 toolset parity (verbatim SPARTAN scope)
- **Journey**: UJ-001 (Executor decision + execution loop)
- **Priority**: P0 (added in v1.1 retrospective; original v1 contract shipped market-orders-only and did not satisfy the verbatim SPARTAN prompt's full action surface)
- **User Story**: As Tao, I want the Executor's MT5 surface to mirror the n8n executor's full action set so the verbatim SPARTAN prompt's branches ("PLACE LIMIT/STOP ORDER IF the CMP has moved too far"; "ALL EURO/London Session's trades will be cleared before US Session Start"; "optimize the current pair's existing order's setting") are mechanically expressible — not just the market-buy/sell happy path.
- **Acceptance Criteria**:
  - [ ] AC-022-1: TwelveData technical-indicators proxy at `GET /api/internal/indicators?indicator=&symbol=&timeframe=&time_period=&outputsize=`. INTERNAL_API_TOKEN bearer-gated. 8-indicator allowlist (ema, rsi, macd, adx, bbands, stoch, atr, vwap). Translates MT5 timeframe (M1, H4, D1, …) → TwelveData interval form. `TWELVEDATA_API_KEY` lives in Vercel env only (never reaches Routine Cloud Env). Constitution §15 LOUD-fails on missing key. Graceful degradation on upstream unreachable / non-OK / `status:error` body — returns 200 `{degraded:true, error_message, values:[], meta:{}}`. Helper module `packages/routines/src/indicators.ts` exposed for reuse.
  - [ ] AC-022-2: Position-management routes (3): `DELETE /api/internal/mt5/positions/[id]` (close one), `PATCH /api/internal/mt5/positions/[id]` (modify SL/TP — translates `{sl, tp}` to upstream `{stop_loss, take_profit}` PUT), `DELETE /api/internal/mt5/positions/by-symbol/[symbol]` (close all on a pair, used at session-end flatten per the verbatim "ALL EURO/London … cleared before US Session Start" rule). All bearer-gated; alphanumeric symbol + positive-integer id sanitisation; mt5-server.ts extended with `mt5Put` + `mt5Delete` helpers.
  - [ ] AC-022-3: Pending-order routes (3): `POST /api/internal/mt5/orders/pending` (place LIMIT/STOP — MT5 determines limit-vs-stop from price-vs-CMP), `DELETE /api/internal/mt5/orders/pending/[id]`, `DELETE /api/internal/mt5/orders/pending/by-symbol/[symbol]`. Same auth + sanitisation as AC-022-2.
  - [ ] AC-022-4: Spartan system prompt's `Tools available (proxy pattern)` § 7-step "Position-action step" is expanded to 7a (open market) | 7b (modify SL/TP) | 7c (close one) | 7d (close all on pair) | 7e (place pending) | 7f (cancel one pending) | 7g (cancel all pending on pair) — explicit branches with curl recipes for each. NO_TRADE branch skips 7a-7g entirely, proceeds to step 8. Failure-mode reminders document operator-actionable Telegram alerts for each new operation.
- **Edge Cases**:
  - EC-022-1: TwelveData freemium tier rate-limited → degraded:true response; Executor falls back to inline-computing the indicator from the candle OHLC array (Wilder's ATR, gain/loss-ratio RSI). Note in reasoning trace that the indicator was approximated.
  - EC-022-2: `DELETE /api/v1/positions/{id}` upstream returns "ticket not found" because position closed since last positions-fetch → MT5 server returns success-shape; Executor accepts as no-op.
  - EC-022-3: `PATCH` modify-SL/TP fails (broker-side rejection: SL too close to current price etc.) → Telegram alert "POSITION MODIFY FAILED — ticket=<id> intended sl=<sl> tp=<tp>; broker stops still at original levels"; settle audit `failed`. Position remains open at original SL/TP.

## Non-Functional Requirements

### NFR-001: Trading-loop reliability
- **Category**: Reliability
- **Metric**: ≥ 99.5% of scheduled per-pair-session Executor fires actually execute (or fail with a logged audit row + Telegram alert) within ±2 minutes of their scheduled time, measured over a 30-day rolling window.
- **Verification**: Daily Vercel cron computes (fires_completed_or_failed / fires_scheduled) per day; dashboard Overview shows last 30-day rolling. Evaluator runs a stub end-to-end test: schedule 5 one-offs spaced 1 minute apart, confirm 5 audit rows appear in the right order and within tolerance.

### NFR-002: Telegram chat latency
- **Category**: Performance
- **Metric**: Channels-session reply time p95 ≤ 3s, p99 ≤ 8s, when session is healthy, for messages under 280 chars and not requiring multi-step tool use.
- **Verification**: `telegram_interactions.received_at` and `replied_at` columns + a daily Vercel cron computes p95/p99. Dashboard shows the rolling number.

### NFR-003: Dashboard liveness
- **Category**: Performance
- **Metric**: Live data freshness on Overview ≤ 6s p95 (clock time from MT5-side change to dashboard reflecting it).
- **Verification**: Synthetic test in CI: open dashboard via Playwright, force a small MT5 state change via the test broker (or a mock), measure time-to-see in the DOM.

### NFR-004: Audit completeness
- **Category**: Reliability / Compliance
- **Metric**: 100% of routine fires (every entry in `pair_schedules` whose start time has passed by ≥30 min) MUST have a corresponding `routine_runs` row with `started_at`. Daily orphan-detection report fires a Telegram alert if any orphan is found.
- **Verification**: Daily Vercel cron query: `SELECT * FROM pair_schedules ps WHERE ps.start_time_gmt < now() - interval '30 minutes' AND NOT EXISTS (SELECT 1 FROM routine_runs rr WHERE rr.pair = ps.pair_code AND rr.session_window = ps.session_name AND rr.started_at::date = ps.date)`. Result must be empty.

### NFR-005: No `ANTHROPIC_API_KEY` in any artefact
- **Category**: Security / Cost
- **Metric**: 0 occurrences of `ANTHROPIC_API_KEY` in: source files, `.env*` files, Vercel env list, VPS env files, Cloudflare worker env, ANY committed git history.
- **Verification**: Pre-commit hook + CI lint rule (FR-010 AC-010-1) + `make audit-no-api-key`. Run on every PR.

### NFR-006: Subscription token budget headroom
- **Category**: Reliability / Cost
- **Metric**: Combined Routines + Channels-session token consumption stays ≤ 80% of the Max 20x weekly subscription quota under normal load (1 Planner/day + 13 Executors/day + ~50 Telegram chat turns/day).
- **Verification**: FR-001 AC-001-4 spike establishes baseline. Ongoing: weekly Vercel cron reads Anthropic `/usage` (if API exposes) OR scrapes the operator's `/usage` view via a small headless-browser job (**fallback if API not available — recorded as silent default ADR-008**). Alert at >80%, hard alert at >95%.

### NFR-007: Override action atomicity
- **Category**: Reliability
- **Metric**: An override action's MT5 REST call + its `override_actions` audit row + its Telegram broadcast are all either ALL persisted or rolled back. Partial states are detectable via audit row's `success` field plus any orphan position records.
- **Verification**: Integration test: simulate a failed MT5 REST during override, confirm audit row says `success=false` AND no Telegram notification fires AND dashboard shows error toast. Simulate failed audit-row write, confirm MT5 call is not made.

### NFR-008: TimeZone correctness across the system
- **Category**: Functionality / Reliability
- **Metric**: Every time stored in DB or written to Telegram or shown on dashboard is GMT/UTC and clearly labeled. 0 cases of inferred-wrong-timezone in test suite.
- **Verification**: Test suite includes a "DST transition day" test using a frozen DST date, asserts schedule + audit rows are still GMT.

### NFR-009: Auth on every dashboard route
- **Category**: Security
- **Metric**: 0 dashboard routes (other than `/login` and CRON_SECRET-gated `/api/cron/*`) accessible without a valid Auth.js session. Verified via Playwright suite that hits every route un-authed and expects a 401/redirect.
- **Verification**: Automated route-enumeration test in CI.

### NFR-010: Constitution compliance
- **Category**: Process / Quality
- **Metric**: 100% of constitution principles testable via constraint or test; all tests pass before merge.
- **Verification**: `/harness:analyze` constitutional-coverage check.

## Risks

### RISK-001: One-off routines are NOT cap-exempt at runtime (the assumed `/schedule`-from-inside-a-routine path is non-existent)
- **Likelihood**: Resolved (discovery during v1 build: Anthropic exposes no programmatic `/schedule` API; the cap-exempt claim was an artefact of stale conversational doc reading)
- **Impact**: High in the original sense (architecture would have shipped depending on a non-existent substrate); now structurally addressed
- **Mitigation**: The corrective action IS the v1.1 architecture pivot: Planner persists `pair_schedules` rows in `status='scheduled'`, the every-minute cron tick at `/api/cron/fire-due-executors` reads due rows and fires per-pair Executors via the `/fire` API. Every fire is cap-counted; daily cap budget = 1 Planner + N Executors per pair-session approved by Planner. Cap-exhaustion fallback (per ADR-002 revised) = cron tick skips lowest-priority pair-sessions per the Planner's ranking output. There is no `claude /schedule` fallback because there is no `claude /schedule` API.

### RISK-002: Routine duration limit < the longest Executor run (5-15 min)
- **Likelihood**: Medium (undocumented; brainstorm calls this out explicitly)
- **Impact**: High (mid-run timeouts produce partial state — open orders without their TP/SL set, or no order at all)
- **Mitigation**: FR-001 AC-001-2 measures actual ceiling. If exceeded, split MSCP into two phases (data-fetch + reasoning, then a chained one-off for order placement). If splitting still doesn't fit, fall back to Sonnet 4.6 for the Executor (faster, less verbose, still covers MSCP). Recorded in ADR-003.

### RISK-003: `/fire` beta header version bumped, breaking dashboard re-plan
- **Likelihood**: Medium (the API explicitly says "breaking changes will be introduced with new dated beta header versions")
- **Impact**: Medium (only the dashboard's "Force re-plan" button breaks; daily auto-flow still works through `/schedule` Bash inside the Planner routine)
- **Mitigation**: Version-pinning ADR-004; init.sh + CI run a smoke test against the pinned beta header; alert on failure. Manual rollback path: operator-driven `/api/internal/anthropic/fire` from the dashboard (the same Vercel-proxied `/fire` endpoint the cron tick uses, exposed under operator auth). There is no `claude /run` Bash fallback in v1.1 because the Channels-session-driven `/replan` path is not the rollback path for `/fire` outages — it would still hit the same `/fire` API under the hood.

### RISK-004: Channels session crashes silently, Telegram looks dead to the operator
- **Likelihood**: Medium-High (24/7 process, long-lived LLM session, possible memory pressure)
- **Impact**: High (operator can't reach the bot when it matters most — during a market move)
- **Mitigation**: FR-005 (systemd Restart=always + Vercel-cron healthcheck + out-of-band Telegram Bot API alert at 10 min downtime). Recovery message on restart (FR-005 AC-005-3). **Restart-on-idle cron** (per ADR-009 revised — restarts only when session has been idle ≥ 4h AND current GMT is in `[22:00, 06:00]`, with 90s alarm-mute before restart so the cron healthcheck doesn't false-alarm) replaces the original "daily 03:00" silent default. Subagent system prompt notes that yesterday's Telegram history is queryable from `telegram_interactions` so context loss across restart is recoverable.

### RISK-005: MT5 REST or ForexFactory MCP unreachable for an extended window
- **Likelihood**: Low-Medium (VPS network blips, broker-side outages)
- **Impact**: High (Executors fire blind — no candles, no calendar)
- **Mitigation**: Per-call retry-with-backoff (FR-003 EC-003-1); audit row marks `degraded=true`; SPARTAN prompt's safeguards refuse to trade on insufficient data (existing behavior); Telegram alert. If outage > 30 min, the Planner re-plan path's "no trade" output is the safe default. New v1-specific failure mode: Tailscale Funnel hostname change after VPS reboot/re-auth — Funnel hostnames are stable per-machine but a fresh `tailscale up` with a new node-name produces a new hostname; mitigation = init.sh smoke test (FR-009 AC-009-4) catches the mismatch on next dev-laptop run; operator updates Vercel + Routines secret-env-vars in a single coordinated step.

### RISK-006: Dashboard authentication misconfigured, exposing override actions to the public
- **Likelihood**: Low (Auth.js + middleware is well-documented)
- **Impact**: Critical (anyone could close all positions or force-replan)
- **Mitigation**: NFR-009 automated route-auth test in CI. Auth.js middleware applied at root layout, not per-route opt-in. Override actions also re-verify session inside the route handler (defense in depth).

## Out of Scope (v1)

- TradingView chart integration (numbers + tables only)
- Backtesting / strategy editor UI (SPARTAN edits in code, not in DB)
- Multiple MT5 accounts / multiple brokers (single account; single REST gateway)
- GBP/JPY pair (dropped to fit the routine cap)
- Multi-tenant onboarding flow / billing (DB shape supports it, no UX yet)
- Pair-config editing UI in the dashboard (read-only in v1)
- Replay-of-prior-trade-with-different-params (sim mode)
- Mobile-native app (responsive web only)

## Silent Defaults (the assumptions I made without explicit user input — surface for `/harness:clarify`)

These reflect what I picked when the brainstorm explicitly left a question for the Planner but `AskUserQuestions` wasn't available in this dispatch. Each is recorded so `/harness:clarify` can surface them and the user can override.

- **SD-001 [resolved by clarify Q2, 2026-05-01]**: VPS-to-cloud transport = **Tailscale Funnel + app-layer bearer token** (operator chose Tailscale Funnel over Cloudflare Tunnel because the operator does not own a Cloudflare-managed domain at v1 launch). Funnel exposes the local MT5 REST + healthcheck to the public internet via auto-assigned `*.ts.net` hostname; auth moves into the app layer (the gateway enforces `Authorization: Bearer ${MT5_BEARER_TOKEN}`). Override path: when the operator acquires a custom domain, run `/harness:edit "switch VPS-to-cloud transport to Cloudflare Tunnel + Access Service Token using domain {domain}"` — the Planner cascade re-introduces ADR-005's prior pattern. See ADR-005 (revised) for the full rationale.
- **SD-002**: Storage split = Vercel Postgres (Neon) for relational + audit + queues, Vercel Blob for HTML/markdown report archive, NO Edge Config (added complexity for negligible win at single-tenant scale; revisit when multi-tenant). Recorded in architecture ADR.
- **SD-003**: Auth provider = Auth.js (NextAuth.js v5) with email-magic-link credentials provider. Single user only in v1; provider list expandable later. Picked because Vercel-native and trivial to gate every route.
- **SD-004**: Charting library for P&L curves = Recharts. Tremor was the alternative. Picked Recharts because it has more shadcn-friendly composition (Recharts is the library Tremor wraps; using it directly avoids a layer).
- **SD-005**: Real-time refresh mechanism = SWR polling at 5s. Server-Sent Events alternative considered, rejected because Vercel free tier has function-execution-time limits that make a long-lived SSE connection awkward. SWR is "good enough" at 5s with `revalidateOnFocus: true`.
- **SD-006**: Routine-prompt design = the Planner writes `pair_schedules` rows with the full per-pair-session `input_text` rendered at write time (verbatim n8n-template shape including `LET'S START\nCurrent Analysis Pair :\n{PAIR}\n\n{XAU_BLOCK_IF_APPLICABLE}\n\nTime Now: {NOW_GMT}`). The cron tick reads `input_text` from the row at fire time and passes it as the `/fire` API's input parameter, routed via the Vercel proxy at `/api/internal/anthropic/fire` to keep the Anthropic bearer in Vercel-side env (subscription-only auth path; FR-010). Parsed inside the routine's TS body code (not by Claude). XAU symbol-cleaning hint included in the text per existing template.
- **SD-007**: Pair config = DB rows (not TS file). Future-proof for multi-tenant. v1 dashboard read-only.
- **SD-008**: Code-interpreter substitute for Executor = `compute_python` MCP attached to the Executor routine, implementation = small Vercel Sandbox. Operator may discover Opus's native math is sufficient and detach.
- **SD-009**: Error path for Executor failures = log audit row, send Telegram alert, NO automatic retry-the-Executor (one-offs can't easily reschedule themselves; manual `/fire` is the operator-driven retry).
- **SD-010**: Daily cap monitoring source = Anthropic `/usage` API if available; if not, headless-browser scrape of operator's `/usage` page (Bun-based, runs from Vercel Function). Confirmed at FR-001 spike time.
- **SD-011**: Claude Design bundle handoff format = at `design/dashboard-bundle/`, expected shape `index.html + styles.css + components.json + screens.json` per Anthropic's documented Claude Design export. The Generator's `frontend-design` skill consumes this format directly. **Operator must export the bundle BEFORE the Generator runs BUILD**; until then, the Generator will create scaffold-only screens and the build will fail evaluation on Product Depth.
- **SD-012**: VPS OS = Linux (likely Ubuntu/Debian). systemd unit + bash setup script in init.sh assume this. Windows VPS = v2 (FR-020 EC-020-1).
- **SD-013 [resolved by clarify Q6, 2026-05-01]**: Audit retention = **365 days hot** in Postgres (default `AUDIT_HOT_DAYS=365`, configurable via env var), archive to Vercel Blob "cold" prefix afterwards. Dashboard "History" view transparently fetches from cold archive when filtering >365 days back. See ADR-006 (revised).
- **SD-014**: Telegram report send mechanism = Telegram Bot API directly from the Executor's last step (no LLM, just an HTTPS POST). The Channels session handles inbound (chat from Tao) and the audit log of those interactions. This avoids stuffing extra prompts into the Channels session for outbound notifications. Recorded in ADR-007.

## Elicitation Results

### "Hindsight 20/20" findings (failure modes if v2 fails 6 months post-launch)

- **F1: We launched, the cap-exempt assumption was wrong, and within a week the system was hitting 15/15 by 14:00 GMT and skipping NY-session trades.** → Discovered DURING v1 build (no programmatic `claude /schedule` API exists); addressed by ADR-002 revised (every fire `/fire`-API-driven and cap-counted; cap-exhaustion fallback = cron-tick skips lowest-priority pair-sessions per Planner output) + FR-021 (daily cap monitoring with hard-stop alert at 14/15).
- **F2: We launched, the Channels session crashed silently overnight, Tao woke up to a missed NFP trade.** → Addressed by FR-005 (GitHub-Actions-cron healthcheck + out-of-band direct-Telegram alert; trigger source on GH Actions to stay free on Vercel Hobby) + FR-019 (Executor reports come through direct Telegram Bot API, not Channels session — so notifications still flow even if Channels is dead).
- **F3: A subtle bug in the news-fetch port made the Planner see "0 news" every day, blanket-quarantining all sessions.** → Addressed by FR-014 AC-014-2 (snapshot-fixture tests against the n8n version's output).
- **F4: A merge surreptitiously added an `ANTHROPIC_API_KEY` for some incidental reason and Tao got a $1,800 surprise.** → Addressed by FR-010 / NFR-005 (pre-commit hook + CI lint + `make audit-no-api-key`).
- **F5: We launched, then a routine started misbehaving, and there's no audit trail to show WHY.** → Addressed by FR-007 (start-row-or-abort + tool-call counts + session-URL link in dashboard).
- **F6: A bearer-token rotation killed prod silently because Vercel env wasn't updated.** → Addressed by init.sh smoke (FR-020 AC-020-1) running on every dev-laptop boot + a CI smoke test that verifies bearer-token validity against the Tailscale Funnel hostname (per FR-009 EC-009-2 — bearer rotation is a coordinated planned-outage operation).
- **F7: An XAU/USD trade silently used `XAUUSDF` because someone "improved" the symbol-cleaning logic.** → Addressed by AC-003-3 hard test + the prompt's verbatim preservation rule.
- **F8: SPARTAN/MSCP got "improved" by Claude during code review, drift introduced silently.** → Addressed by `.harness/spec/preserve/` with explicit "preserve verbatim" status header + a CI check that diffs the deployed routine prompt against the file.

### Scope challenges applied

- **Dashboard pair-config editing UI** challenged → demoted to v2. Pair config in DB is enough; editing it is a v1 effort sink.
- **Compute_python connector** challenged → kept as P1 (not P0). Opus's native math may be sufficient; if it is, this connector is decoration. v1 ships it as a safety net but operator may detach.
- **Cap-status routine running at 12:00 GMT** challenged → kept because the fallback (Anthropic `/usage` API or scrape) is worth 1/15 cap slots/day for the operational confidence it gives. If FR-001 spike reveals the API exposure, drop the routine, save the slot.
- **Direct Telegram Bot API for Executor reports** challenged vs. routing through Channels session → kept as ADR-007's choice because direct API has zero LLM tokens and is more reliable; Channels session focuses on bidirectional chat + override commands.
