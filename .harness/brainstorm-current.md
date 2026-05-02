# Brainstorm — 财神爷 v2: AI-Agent Forex Trading System

**Date**: 2026-05-02 (updated after billing pivot to Routines + Channels-session hybrid)
**Original prompt** (verbatim):
> here's the old trading bot i built it in n8n. This two workflow(json file provided in project file) is work as a WHOLE system. NOW i want to upgrade it into AI agent based using claudecode or langgraph or openclaw .....or other framwork as my Agents, reseach and reason it yourself. You need to read these n8n file, complete comprehend before plan and execute. -I dont want to use the google celender as plan and trigger machanism, try ther more stable and flexible since eveyday's trade schedule is stragetic and flexible. -The metatrader tools and mcp tools' parameters are still the same and usaable. i also want a high, complete professional frontend too, also keep the telegram report mechanism, maybe add upgrade it with some better features like interactive or i dontknow?? like query or checking like openclaw.... the dashboard or frontend can use frontendskill by antrophic or claude design.use impeccable for the design harness. use max research reasonning and scocrates method with me to improve until we are allign with highest level vision and BEST plan, and execute after i approved.

## Summary

Migrate the existing n8n two-workflow trading system (a daily Planner agent that decides session windows + a per-pair Executor agent that runs the SPARTAN/MSCP protocol against MetaTrader REST) into a **Path C Hybrid** architecture, billed entirely against the user's Claude Code Max 20x subscription with **zero per-token API charges and zero OpenRouter dependency**:

- **Trading core (heavy work)**: Claude Code Routines on Anthropic-managed cloud — 1 daily Planner Routine + per-pair Executor Routines. Better fault isolation than a monolithic session: each Executor run is a clean, observable, retryable Claude Code session.
- **Telegram interactivity**: An always-on `claude --channels plugin:telegram` session running on the user's VPS as a systemd service. Telegram messages → Channels MCP → into the running session → Claude replies (chat-grade latency, sub-second). Same session handles slash commands and free-text Q&A. All subscription-billed.
- **Dashboard (live mission control)**: Next.js + shadcn/ui on Vercel free tier — live positions, P&L, schedule, reports archive, override actions. Reads from shared Postgres + live MT5 REST.
- **Design pipeline**: Three-stage. **(1)** User sketches the dashboard manually in [Claude Design](https://claude.ai/design) (web app, included in Max), exports Claude Code bundle. **(2)** Harness Generator uses **`frontend-design`** skill to convert design into production Next.js + shadcn/ui code. **(3)** Harness Generator + Evaluator use **`impeccable`** skill for design audit/polish before merge.

Replace the Google-Calendar-as-trigger layer: the Planner Routine writes today's per-pair schedule to a shared DB, then schedules per-pair one-off Executor Routine runs at the planned times (one-off scheduled runs are exempt from the daily routine cap). Slash commands could route through the Channels session OR through cheap Vercel functions; chosen path is **Channels session for everything** (simpler, single Telegram code path, subscription tokens are plentiful under Max 20x). Pair list reduced to **7 pairs** (dropped GBP/JPY) to fit the 15/day routine cap. Preserve the SPARTAN system prompt and MSCP protocol verbatim. Switch executor LLM to Claude Opus 4.7 (1M context); planner LLM to Claude Sonnet 4.6.

**Total ongoing cost: ~$200/mo Max 20x subscription. No API charges. No OpenRouter charges. Vercel free tier for dashboard.**

## Personas (draft)

- **Tao (the trader-operator)** — runs an automated forex desk on his own MT5 account from a VPS where MT5 + ForexFactory MCP + (was) n8n live together. Wants programmatic flexibility, observability, a dashboard he can run his desk from, and **a billing model that uses his existing Claude Code Max 20x subscription rather than incurring per-token API charges**. Trades 7 pairs (down from 8) across EUR/London + New York intraday sessions. Lives on his phone (Telegram is the primary control channel). Designs the system for himself in v1 with multi-tenant DB shape so he can open it to a small group later.

## Problem statement (draft)

The current n8n system works but is operationally brittle, feature-thin, and requires a separate paid tool. Its core failure mode is the Google-Calendar-as-trigger layer: the daily Planner agent writes session start/end events to two Google Calendars; seven separate calendar-polling triggers (every-minute, OAuth-dependent, quota-limited) listen and dispatch the per-pair Executor by re-invoking a sub-workflow with hard-coded per-pair branches. This produces all four observed pain points simultaneously: **reliability** (silent or late triggers, OAuth churn, calendar quota), **inflexibility** (adding a pair or changing a rule means clicking through nodes), **observability** (no audit trail across days, agent reasoning buried in run history), and **feature gap** (Telegram is one-way; no live dashboard; no interactive control). The trading IP is sound — the SPARTAN/MSCP protocol, the MetaTrader REST tool surface (≈27 endpoints), the ForexFactory MCP integration, the news-aware planner — but it lives inside an automation tool, not an application. Migrating to **Routines for trading + a Channels-enabled Claude Code session for Telegram + a Next.js dashboard on Vercel** moves the system from "automation that works most of the time and bills me twice (n8n hosting + LLM API)" to "trading desk I can operate from anywhere, billed entirely under my existing Claude Code Max 20x subscription."

## Scope signals

- **Smallest useful version**: Full system in one big v1 (user's explicit choice). Backend agents (Routines) + Channels session on VPS + dashboard + full-control Telegram, all shipped together. **Caveat**: this is ambitious; the Planner should partition v1 into internal milestones (M1: routines backend + DB + auth, M2: Channels session deployed on VPS as systemd, M3: dashboard read-only, M4: dashboard overrides + telegram interactivity polished, M5: hardening + audit + observability) so we can verify integrity at each step even if we ship as one release.
- **Out of v1** (hard NO list):
  - **No TradingView chart integration** — frontend shows numbers, schedules, reports, position tables; embed TradingView in v2 if needed.
  - **No backtesting or strategy editor UI** — the SPARTAN prompt + MSCP protocol are migrated verbatim and edited in code/version control, not in the dashboard.
  - **No multiple MT5 accounts / brokers** — single account, single REST gateway URL. Multi-account is v2.
  - **GBP/JPY dropped** for v1 to fit within the Max routine cap. Re-add as a v2 task after the architecture proves out and Anthropic publishes higher caps OR if we restructure to a "single 24/7 session does everything" Path B in a future iteration.
  - (Other pair changes deliberately not capped — architecture must allow swapping pairs by editing one config file.)
- **Hardest part (user's intuition)**:
  1. The Channels session reliability — it's a 24/7 process that MUST stay alive for Telegram to work. Mitigation: systemd service with `Restart=always`, external health-check from a Vercel cron route (e.g., dashboard pings the session every 5 min via a small healthcheck endpoint or `tmux` introspection; alerts via Telegram if down).
  2. The durable scheduler — the Planner Routine programming today's per-pair Executor runs as **one-off scheduled routines** (which are exempt from the 15/day cap). This depends on programmatic one-off creation working from inside a routine, which is **undocumented in official Anthropic docs** as of May 2026. The Planner subagent's first job in PLAN mode is to verify this works (likely via the cloud session running `claude /schedule "today at 09:15 GMT, run executor for EUR/USD"` as a Bash command) — and if it does NOT work, the architecture falls back to pre-creating 7 routines (one per pair, fired multiple times/day via `/fire` API) — but this counts against the cap.
  3. Exposing MT5 REST + ForexFactory MCP from the user's VPS to the Routine cloud sessions on Anthropic's infra — Routines do NOT run on the same VPS as MT5, so they need to reach it. Cloudflare Tunnel + bearer token, or Tailscale + ACLs. (The Channels session is local to the VPS; only Routines need the tunnel.)

## Constraints

- **Trading logic preserved verbatim**: SPARTAN system prompt + MSCP protocol (1D→4H→1H→15M + fundamentals + ATR-based SL + 5% max capital loss + 1:2/1:3/1:4 RR + XAUUSD symbol cleaning). Editable later, not in v1.
- **Tools unchanged**: All 27 MetaTrader REST endpoints stay at their current paths and parameters. ForexFactory MCP stays at its current `ffcal_get_calendar_events` interface. TwelveData indicators API stays.
- **Architecture (Path C Hybrid — Routines for trading + Channels session for Telegram)**:
  - **Trading core** (Planner + Executor agents): Claude Code Routines, billed against Max 20x subscription. Cron-scheduled Planner once daily; per-pair Executors fired as one-off scheduled routines (cap-exempt) OR via `/fire` API to pre-created routines (cap-counted, 14/15 with 1 buffer if fallback is needed).
  - **Telegram bot** (slash commands + free-text Q&A): An always-on Claude Code session running on the user's VPS via systemd, started with `claude --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions`. Telegram messages route through Channels MCP into the live session; Claude replies through the same channel. Sub-second response latency. All slash commands AND free-text Q&A handled by this single session — simpler than splitting into Vercel functions + LLM. Subscription-billed.
  - **Dashboard** (live mission control): Next.js + shadcn/ui on Vercel free tier. Reads from shared DB + live MT5 REST (via tunnel). Override actions either invoke MT5 REST directly (close, edit SL/TP) OR fire the Planner Routine via `/fire` API (re-plan today). Live refresh ~5s via SWR polling.
  - **Shared state**: Vercel Postgres (Neon) for trade history + audit trail + pair config + schedule + dashboard state. Vercel Blob for HTML report archive. Auth via Vercel-native authjs (single user, simplest).
- **Executor LLM**: Claude Opus 4.7 (1M context) — selected in the routine config. The 1M context lets the executor receive full multi-timeframe candle history without truncation. Subscription pays for it.
- **Planner LLM**: Claude Sonnet 4.6 (cheaper, sufficient for news synthesis + schedule decision). Subscription pays for it.
- **Channels session LLM**: Claude Sonnet 4.6 (default) for Telegram chat — fast, cheap subscription tokens, plenty for state queries and short Q&A. Upgrade to Opus 4.7 only for complex multi-turn debugging conversations (set per-turn via the session). Subscription pays for it.
- **Pair list (7 pairs for v1)**: EUR/USD, EUR/JPY, EUR/GBP, USD/JPY, GBP/USD, USD/CAD (1300 GMT only), XAU/USD (0730 + 1300 GMT, mandatory `XAUUSD` symbol). Total daily routine fires: 1 Planner + 13 Executors = **14 / 15 cap** with 1 buffer.
- **Dashboard scope**: Live mission control — balance/equity/positions/P&L (refresh ~5s via DB + MT5 REST polling), today's schedule with countdown, per-pair report archive (markdown rendered), trade history with filters, override actions (pause agent, close pair/all, edit SL/TP on positions, force re-plan today's schedule).
- **Telegram bot scope**: Full control via Channels session — slash commands (/status, /positions, /report <pair>, /balance, /history, /pause, /resume, /closeall, /closepair <pair>, /replan, edit-SL-TP) + free-text AI Q&A ("how is XAU/USD doing?"). All routed through the always-on session.
- **Design pipeline (3 stages)**:
  - **Stage 1 (manual)**: User opens [Claude Design](https://claude.ai/design) (web app, Max-included), prompts the dashboard layout, iterates visually, exports Claude Code bundle. **Done by the user before /harness:sprint**, bundle is added to the project as `design/dashboard-bundle/` for the Planner to read.
  - **Stage 2 (programmatic)**: Harness Generator (BUILD mode) invokes the **`frontend-design`** skill to translate the bundle + spec into production Next.js + shadcn/ui components.
  - **Stage 3 (programmatic)**: Harness Generator (BUILD mode) invokes the **`impeccable`** skill at the end of UI work for design audit + polish (visual hierarchy, accessibility, responsive behavior, motion, theming). Evaluator (EVALUATE mode) verifies design quality as part of the gate.
- **Audit trail mandatory**: Every Routine run's session ID + URL + tool calls + outputs persisted to Postgres at run start AND run end. Every Channels session interaction (Telegram message + Claude response + any tool calls) logged. Every dashboard override action logged with user + timestamp + before/after state. If we can't replay yesterday's decisions tool-call-by-tool-call, v1 is incomplete (user's explicit hard line).
- **Single-user v1, multi-tenant designed**: Auth gates the dashboard from day one. DB schema includes `tenant_id` even though only one tenant exists in v1. Channels session's allowlist locked to user's Telegram user ID only.
- **Secrets management**: No hardcoded keys in code or in env files committed to git. Vercel env vars / Vercel secrets for: TwelveData API key, MT5 creds, Telegram bot token, Cloudflare Tunnel token, Postgres connection string, routine bearer tokens. Channels session env on VPS uses systemd `EnvironmentFile=` pointing to a non-git-tracked file. The current n8n workflow has a hardcoded TwelveData API key — must NOT be carried over.
- **Subscription auth isolation**: Hard rule — no `ANTHROPIC_API_KEY` anywhere in the codebase. Routines authenticate via per-routine bearer tokens (auto-issued). Channels session authenticates via the user's claude.ai login (`claude login` on VPS). Dashboard's call to `/fire` Planner uses the Planner routine's bearer token. Prevents the [GitHub#37686 $1,800 surprise](https://github.com/anthropics/claude-code/issues/37686).

## Rejected directions

- **Translating the n8n graph node-by-node into TS** — preserves all the awkwardness (8 hardcoded pair branches, 7 calendar pollers, the calendar-as-trigger pattern). Build the new system from the trading INTENT in the SPARTAN/MSCP design, not from the n8n shape.
- **Using Google Calendar at all** — even as backup or audit log. The whole point of the migration is removing this layer; reintroducing it via the back door defeats the goal.
- **Shipping without an audit trail of every agent decision** — non-negotiable. If we can't replay yesterday's decisions tool-call-by-tool-call, v1 is incomplete.
- **OpenHands as the agent framework** — OpenHands is built for software-engineering agents (writing code, running shells), not trading-bot tool loops. Path C (Routines + Channels) is the right shape.
- **Path 1 (Vercel Workflow DevKit + Anthropic API + Sonnet 4.6)** — initially recommended; rejected by user in favor of subscription-only billing. Architecturally cleaner (durable scheduler is first-class) and predictable cost (~$120-150/mo) but requires per-token API billing the user wants to avoid.
- **Path 4-A pure Routines + OpenRouter free Q&A** — drafted as an interim solution; rejected after user surfaced Channels as the better Telegram path. OpenRouter free tier is no longer needed.
- **Path B single 24/7 Claude Code session for everything** — would let us keep all 8 pairs (no routine cap) but creates a single point of failure for the entire trading system. User chose Path C's per-pair fault isolation over keeping GBP/JPY.
- **Anthropic API billing for any production path** — explicitly avoided in v1 by user choice. All LLM work uses subscription (Routines + Channels session).

## Open questions for the Planner

These are things the interview deliberately did not lock down — the Planner should pick these up via Pass-1 `AskUserQuestions` or `/harness:clarify`:

- **🚨 LOAD-BEARING: Programmatic one-off routine creation from inside a routine.** Official Anthropic docs do not document this. The Planner subagent's FIRST verification task in PLAN mode: confirm whether a running routine can spawn one-off scheduled routines (e.g., by running `claude /schedule "today at 09:15 GMT, fire executor with text=EUR/USD"` via Bash inside the routine session). If YES → architecture works as designed (one-off runs are cap-exempt, 14 daily fires don't count, only the 1 Planner counts → 1/15 used). If NO → fallback: pre-create 13 routines (one per pair-session combo) and Planner uses `/fire` API on each at the right time, but each fire counts against 15/day cap → 14 fires/day = 1 buffer remaining, no room for retry.
- **🚨 Routine execution duration limit (undocumented).** Each per-pair Executor run takes ~5-15 min based on the n8n analysis (multi-timeframe data fetch + LLM reasoning + order placement). Planner verifies via a test routine in early PLAN whether this fits within Anthropic's undocumented timeout.
- **🚨 `/fire` API stability** — currently behind `experimental-cc-routine-2026-04-01` beta header; could break with a beta version bump. Planner documents the version pinning strategy and a fallback (CLI-based one-off scheduling).
- **🚨 Channels session lifecycle on VPS** — Planner specifies the systemd unit (Restart=always, restart-on-failure delay, log rotation), the health-check approach (dashboard pings via a small healthcheck route the session exposes? or external `pgrep`-style check from a Vercel cron?), the crash-recovery protocol (when restarted, session reads recent state from DB and informs user via Telegram "I'm back online, last seen state at HH:MM").
- **🚨 Channels session token quota under Max 20x** — a 24/7 session that handles Telegram chat all day burns subscription tokens. Plus the Routines burn the same quota. Planner verifies (via Anthropic docs or test) that Max 20x's token budget supports both: ~1.5-2M tokens/day across Routines + ~50-200k tokens/day for Channels chat. Likely fine on Max 20x; should be confirmed.
- **VPS-to-cloud transport for Routines** — Cloudflare Tunnel + bearer token? Tailscale Funnel + ACLs? mTLS proxy in front of MT5 REST? The VPS environment (Linux or Windows? what's already installed?) shapes this. **Only Routines need the tunnel** — the Channels session is local to the VPS. Dashboard also needs to reach MT5 REST so the tunnel must be multi-source.
- **Storage architecture confirmation** — Vercel Postgres (Neon) for trade history + audit + pair config? Vercel Blob for the HTML report archive? Edge Config for hot-path config (pair list, kill switch)? Planner finalises split.
- **Auth provider for dashboard** — Vercel-native authjs is the simplest single-user choice. Confirm.
- **Telegram channel plugin permissions** — `--dangerously-skip-permissions` is the right call for a 24/7 unattended trading bot session, but Planner reviews exactly which tools it gates. The session should be allowed: MT5 REST tools, DB read+write, ForexFactory MCP. Should NOT be allowed: shell commands beyond a strict allowlist (no `rm -rf`, no arbitrary file writes outside a defined working dir).
- **Dashboard tech inside Next.js** — shadcn/ui (impeccable's preferred path) confirmed for component layer. Charting library for P&L curves (Recharts? Tremor?). Real-time refresh (SWR polling vs Server-Sent Events from a Vercel function).
- **Routine prompt design** — the SPARTAN prompt currently lives in the n8n AI Agent5 node; it'll need to be the Routine's saved prompt, with per-run input via the `text` parameter (containing pair name + session). Planner specifies the prompt template and how `text` is parsed inside the routine.
- **Connectors required by each routine** — both Planner and Executor need ForexFactory MCP; Executor also needs MT5 REST access. These attach as Routine connectors, scoped per routine.
- **Pair config as DB row vs TS file** — the user did not cap the pair list, so adding a pair must be a one-line change. DB-driven (with a UI in the dashboard) is more flexible; TS-file-driven is simpler. Planner recommends.
- **Re-plan trigger** — user wants both dashboard "force re-plan" button AND Telegram `/replan` command. Both fire the Planner routine via `/fire` API. Planner confirms.
- **Code interpreter substitute** — the original GPT-5.4 setup uses code interpreter for math. Claude Opus 4.7 inside Routines doesn't have built-in code interpreter; if the executor relies on it, Planner adds a `compute_python` MCP tool wrapping a sandboxed runner (or accepts that Opus's native math is sufficient).
- **Error path for trade execution failures** — current n8n sends an error Telegram message and continues. New system needs explicit retry policy (re-fire the executor routine? mark failed in DB? alert via Telegram via Channels session?) + escalation rules.
- **Daily cap monitoring** — dashboard shows current routine-cap usage from Anthropic's `/settings/usage` endpoint? Sound an alarm at 12/15? Telegram heads-up via Channels session at 13/15? Planner specifies.
- **Claude Design bundle handoff format** — what does the bundle look like when exported? Where does it live in the repo (`design/dashboard-bundle/`)? How does the Planner read it (raw HTML? component tree?)? Generator's frontend-design skill consumption format?

## Suggested next step

Run:

```
/harness:sprint "Build 财神爷 v2: a code-defined replacement for the existing n8n forex trading
system. ARCHITECTURE (Path C Hybrid, decided): all LLM work runs against the user's Claude Code
Max 20x subscription — NO Anthropic API billing, NO OpenRouter dependency.

TRADING CORE = Claude Code Routines on Anthropic cloud:
- 1 daily Planner Routine (cron 04:00 GMT, Sonnet 4.6) reads news + ForexFactory MCP, decides
  today's per-pair session windows, schedules per-pair Executor runs as one-off scheduled
  routines (cap-exempt — Planner MUST verify this works in early PLAN; fallback is /fire API
  with cap-counting at 14/15).
- Per-pair Executor Routines (Opus 4.7 1M context) run the SPARTAN/MSCP protocol verbatim,
  exec MT5 REST tools, output a report + audit trail to shared Postgres.
- 7 pairs (GBP/JPY dropped for cap fit): EUR/USD, EUR/JPY, EUR/GBP, USD/JPY, GBP/USD,
  USD/CAD (1300 GMT only), XAU/USD (0730 + 1300 GMT, mandatory XAUUSD symbol).
- Daily routine fires: 1 Planner + 13 Executors = 14/15 cap with 1 buffer.

TELEGRAM CONTROL = always-on Claude Code session on user's VPS:
- systemd service running `claude --channels plugin:telegram@claude-plugins-official
  --dangerously-skip-permissions`.
- Same session handles ALL slash commands (/status, /positions, /report <pair>, /balance,
  /history, /pause, /resume, /closeall, /closepair, /replan, edit-SL-TP) AND free-text Q&A.
- Sub-second chat latency (in-session, no cold-start). Subscription-billed.
- Restart=always systemd, external health-check from Vercel cron, crash-recovery protocol.

DASHBOARD = Next.js + shadcn/ui on Vercel free tier:
- Live mission control — balance/equity/positions/P&L (5s refresh), today's schedule with
  countdown, per-pair report archive, trade history with filters.
- Override actions: pause agent, close pair/all, edit SL/TP, force re-plan (fires Planner
  routine via /fire API).
- Reads from Vercel Postgres + live MT5 REST.

DESIGN PIPELINE (3 stages):
- Stage 1 (user, before sprint): sketch dashboard in Claude Design web app, export Claude
  Code bundle to design/dashboard-bundle/.
- Stage 2 (Generator BUILD): invoke frontend-design skill to convert bundle into Next.js +
  shadcn components.
- Stage 3 (Generator BUILD + Evaluator EVALUATE): invoke impeccable skill for audit + polish.

INFRASTRUCTURE:
- MT5 + ForexFactory MCP stay on user's VPS. Routines reach them via authenticated tunnel
  (Cloudflare Tunnel + bearer token, Planner picks). Channels session reaches them locally.
- Vercel Postgres (Neon) for trade history + audit + pair config + schedule.
- Vercel Blob for HTML report archive. Vercel-native authjs for dashboard auth.

PRESERVE VERBATIM: SPARTAN system prompt + MSCP protocol from existing 财神爷 Agent.json.

LOAD-BEARING UNVERIFIED ASSUMPTIONS (Planner MUST verify in early PLAN before locking
architecture):
1. Programmatic one-off routine creation from inside a routine (likely via 'claude /schedule'
   as Bash). If NO: fallback to pre-created routines + /fire API (no buffer).
2. Routine execution duration limit (undocumented). Per-pair runs ~5-15 min must fit.
3. /fire API stability (currently experimental beta header).
4. Channels session token quota under Max 20x (Routines + 24/7 chat session must both fit).

Single-user v1, multi-tenant DB shape designed in. Mandatory full audit trail of every
routine run, every Channels session interaction, every order. Out of v1: TradingView
charting, backtesting/strategy editor UI, multi-account support, GBP/JPY pair. Hard
rejection: do not translate n8n graph node-by-node; do not use Google Calendar anywhere; do
not allow ANTHROPIC_API_KEY anywhere in the codebase (subscription-only auth, prevents the
GitHub#37686 $1,800 surprise).

Total target ongoing cost: $200/mo Max 20x subscription. No per-token API charges. No
OpenRouter charges. Vercel free tier for dashboard.

See .harness/brainstorm-current.md for full context including all open questions for the
Planner."
```
