<!-- BELCORT Harness — Implementation Proposal — Round 3 -->

# Implementation Proposal — Round 3

**Date**: 2026-05-03
**Round**: 3 of max 3 (final negotiation round)
**Feature**: 001-foundation-routines-channels-dashboard
**Generator**: claude-opus-4-7[1m]

> Round 3 changes vs Round 2: surgical fixes to three items the Evaluator surfaced in `review.md`. (1) **R6 cryptographic primitive correction** — Round 2's `validateCsrf` used `createHash('sha256').update(token + AUTH_SECRET)` which does not match Auth.js v5's signature shape; Round 3 replaces it with a self-contained HMAC double-submit-cookie that we control end-to-end, plus `timingSafeEqual` constant-time comparison, plus `__Host-` cookie prefix on production. Context7 confirmed Auth.js v5's CSRF cookie is now `authjs.csrf-token` (rebranded from `next-auth.csrf-token` per the v5 migration doc) and the token is stored in an encrypted JWE cookie — verifying Auth.js's internal JWE from outside the library is brittle, so we issue our own HMAC-signed CSRF cookie and stop relying on Auth.js internals for CSRF. New `csrf.test.ts` pins the HMAC algorithm against a known-good fixture so the BUILD cannot silently drift to a different primitive. (2) **R3-followup split-transaction** — Round 2's `handleReplan` held a Postgres transaction open across the external `/fire` POST, which would hold row locks for the duration of the remote call; Round 3 splits into Transaction A (cancel + insert in-flight audit row) → external `/fire` POST → Transaction B (settle the audit row), bridged by the `success=null` in-flight marker the orphan-detect cron already watches. (3) **R5-followup synthetic-ping clarification** — one-paragraph walkthrough of why synthetic-ping rows do NOT artificially inflate `MAX(replied_at)` (because the wrapper sets `replied_at` only after the Channels session actually handled the message; a dead session leaves the synthetic ping unhandled exactly like any other message, so the cron does not produce false-healthy). No code change for R5 — Round 2 was correct in spirit; the doc loop just had to close. The 5 proposed-by-Evaluator ACs (AC-002-1-b, AC-003-1-b, AC-007-3-b, AC-016-1-b/-2-b/-3-b, AC-018-2-b) carry through unchanged for FINALIZE-CONTRACT.

> Scope reminder: this proposal is the HOW for all 21 FRs (M0–M5) of the single-folder build. Architectural choices already locked by ADR-001…ADR-010 are NOT re-litigated here (Tailscale Funnel, Drizzle, Bun, Auth.js v5 + Passkeys, 365-day audit, local-counter cap, restart-on-idle). What follows is the workspace shape, file paths, data-model field shapes, API URLs, internal lib choices, subagent-yaml shape, queue-table shape, FR-013 Vercel Sandbox approach, and per-AC test approach the Evaluator will grade against.

---

## Workspace / Monorepo Layout

**Decision: Bun workspaces monorepo, single `bun.lock` at repo root, four packages.**

Why a workspace and not a single Next.js project:
- The trading-core code (Planner + Executor + news-fetch port) ships to Anthropic Routines as Bash steps reading TS modules — it has zero Next.js dependency and pulling Next into its bundle would hurt cold-start.
- The Channels-session subagent ships to the VPS as Markdown frontmatter + a small TS library — also zero Next.
- The dashboard is the only Next.js surface.
- A `db/` package shared by all three surfaces enforces the single source of truth for the Drizzle schema (constitution §4 multi-tenant compliance has to be testable from any of these three call sites).
- Fourth package `infra/` holds the systemd unit, VPS setup script, Docker for local Postgres, init.sh helpers, and gitleaks/eslint shared config.

```
财神爷/
├── package.json                    # root: workspaces, scripts, packageManager: bun@<pinned>
├── bun.lock                        # committed
├── biome.json                      # lint + format (Bun-friendly, faster than eslint+prettier)
├── tsconfig.base.json              # strict, no-any enforced, paths aliased
├── .gitleaks.toml                  # constitution §10 — extra rules for bot tokens, MT5 password, bearer
├── .lefthook.yml                   # pre-commit hooks (lefthook is faster than husky on Windows; both work)
├── Makefile                        # `make audit-no-api-key`, `make spike`, `make seed`
├── design/dashboard-bundle/        # Operator-exported Claude Design output (gitignored if large)
├── docs/
│   ├── spike-report-fr-001.md      # FR-001 D1 artefact
│   └── adr/                        # Future ADRs (current ones live in .harness/spec/)
├── infra/
│   ├── vps/
│   │   ├── setup.sh                # AC-020-2; idempotent; installs Bun, Tailscale, Claude Code CLI
│   │   ├── systemd/
│   │   │   ├── caishen-channels.service        # AC-004-1
│   │   │   ├── caishen-channels-restart.service # ADR-009 restart-on-idle (oneshot)
│   │   │   ├── caishen-channels-restart.timer  # 30-min cadence
│   │   │   ├── caishen-mt5-bearer-proxy.service # AC-009-2 bearer-enforcing reverse proxy
│   │   │   └── tailscale-funnel.service        # persistent funnel across reboots
│   │   └── nginx/
│   │       └── mt5-bearer.conf     # tiny reverse-proxy enforcing Authorization: Bearer
│   ├── ci/
│   │   └── github-workflows/       # CI YAML: bun install → lint → tsc → vitest → no-api-key audit → gitleaks
│   └── local/
│       ├── docker-compose.yml      # local Postgres 16 for tests
│       └── seed-local.ts           # FR-012 seed for local dev
├── packages/
│   ├── db/                         # SHARED — schema, migrations, query helpers
│   │   ├── package.json            # name: "@caishen/db"
│   │   ├── drizzle.config.ts       # Drizzle Kit config
│   │   ├── src/
│   │   │   ├── client.ts           # tenant-scoped client factory (THE only export apps use)
│   │   │   ├── schema/             # one file per table — see Data Model below
│   │   │   ├── queries/            # tenant-scoped query helpers (e.g., getActivePairs)
│   │   │   ├── audit.ts            # audit-or-abort module (constitution §3) — used by EVERY agent
│   │   │   ├── migrate.ts          # programmatic migrate runner (CI + init.sh use this)
│   │   │   └── lint/               # static-analysis script (constitution §4 enforcement)
│   │   │       └── tenant-id-lint.ts
│   │   └── migrations/             # Drizzle Kit output, hand-edited where needed
│   │       ├── 0001_init.sql
│   │       ├── 0002_seed_pairs.sql # FR-012 seed
│   │       └── meta/
│   ├── routines/                   # Trading core — Planner + Executor + spike + news port
│   │   ├── package.json            # name: "@caishen/routines"; depends on @caishen/db
│   │   ├── src/
│   │   │   ├── planner.ts          # FR-002 — daily Planner Bash entry
│   │   │   ├── executor.ts         # FR-003 — per-pair Executor Bash entry
│   │   │   ├── spike/
│   │   │   │   ├── ac-001-1-cap-exempt.ts        # FR-001 spike #1
│   │   │   │   ├── ac-001-2-duration-and-math.ts # FR-001 spike #2 (combines duration + math fidelity per Q8)
│   │   │   │   ├── ac-001-3-fire-api.ts          # FR-001 spike #3 — also probes "GET deployed system prompt" endpoint (R1)
│   │   │   │   └── ac-001-4-token-soak.ts        # FR-001 spike #4
│   │   │   ├── news.ts             # FR-014 — RSS fetch + markdown render (port from n8n)
│   │   │   ├── ffcal.ts            # ForexFactory MCP client wrapper
│   │   │   ├── mt5.ts              # MT5 REST client (typed)
│   │   │   ├── telegram-bot.ts     # FR-019 — direct Bot API (no LLM)
│   │   │   ├── prompt-loader.ts    # reads .harness/spec/preserve/*.md verbatim, byte-identity check
│   │   │   ├── time.ts             # GMT/UTC helpers (constitution §5 — all callers use this)
│   │   │   ├── cap-counter.ts      # cap_usage_local instrumentation (FR-021 AC-021-1)
│   │   │   ├── routine-runs.ts     # audit-or-abort wrapper for routine fires (constitution §3)
│   │   │   └── schedule-fire.ts    # `claude /schedule` Bash + `/fire` API path selector (post-spike)
│   │   └── tests/
│   │       ├── fixtures/rss/       # frozen golden RSS feeds + n8n golden output
│   │       ├── news.test.ts        # AC-014-2 snapshot
│   │       ├── prompt-preserve.test.ts # constitution §2 byte-identity (Tier 1 file-side, Tier 2 deployed-side conditional — see R1)
│   │       ├── prompt-preserve-deployed.test.ts # constitution §2 Tier 2 (skipped if Spike 3 found no endpoint)
│   │       ├── xau-symbol.test.ts  # AC-003-3 hard test
│   │       ├── time-dst.test.ts    # NFR-008 DST transition
│   │       ├── audit-or-abort.test.ts # AC-007-1 + EC-007-1
│   │       ├── replan-cleanup.test.ts # AC-018-2 + AC-018-2-b cleanup ordering + race window (NEW per R3)
│   │       └── tenant-scope.test.ts   # AC-008-2 lint executes here
│   ├── channels/                   # Channels-session subagent + slash-command scripts
│   │   ├── package.json            # name: "@caishen/channels"; depends on @caishen/db
│   │   ├── agents/
│   │   │   └── caishen-telegram.md # AC-004-3 subagent yaml — see "Channels Subagent" below
│   │   ├── src/
│   │   │   ├── allowlist.ts        # AC-004-6 enforcement (reads tenants.allowed_telegram_user_ids)
│   │   │   ├── tg-interactions.ts  # AC-007-2 audit row writer
│   │   │   ├── recovery.ts         # AC-005-3 self-announce on restart
│   │   │   └── commands/
│   │   │       ├── status.ts       # /status
│   │   │       ├── positions.ts    # /positions
│   │   │       ├── report.ts       # /report <pair>
│   │   │       ├── balance.ts      # /balance
│   │   │       ├── history.ts      # /history
│   │   │       ├── pause.ts        # /pause + /resume
│   │   │       ├── closeall.ts     # /closeall
│   │   │       ├── closepair.ts    # /closepair <pair>
│   │   │       ├── replan.ts       # /replan (uses claude /run fallback per ADR-004)
│   │   │       └── edit.ts         # /edit <symbol> <ticket> sl=… tp=…
│   │   ├── scripts/                # NOT writable by the subagent (per R2) — operator/CI deploys these
│   │   │   ├── restart-on-idle.sh  # ADR-009 — runs from systemd timer
│   │   │   └── healthcheck-handler.ts # AC-005-1 endpoint behind nginx bearer proxy
│   │   └── tests/
│   │       ├── allowlist.test.ts   # AC-004-6
│   │       ├── recovery.test.ts    # AC-005-3
│   │       ├── healthcheck-signal.test.ts # AC-005-1 last_message_handled_at = MAX(received_at) (NEW per R5)
│   │       └── commands/*.test.ts  # one per command
│   └── dashboard/                  # Next.js 16.2 App Router + shadcn/ui + SWR
│       ├── package.json            # name: "@caishen/dashboard"; depends on @caishen/db
│       ├── next.config.ts
│       ├── vercel.json             # crons[] entries — see Cron Schedule below
│       ├── middleware.ts           # NFR-009 — Auth.js gate at root layout
│       ├── app/
│       │   ├── layout.tsx
│       │   ├── (auth)/
│       │   │   ├── login/page.tsx
│       │   │   └── auth/passkey-register/page.tsx  # one-time, INITIAL_REGISTRATION_TOKEN gated
│       │   ├── (dashboard)/
│       │   │   ├── layout.tsx       # Auth.js auth() wrapper + nav
│       │   │   ├── page.tsx         # Overview (AC-006-2 #1)
│       │   │   ├── pair/[pair]/page.tsx  # Per-pair Detail (AC-006-2 #2)
│       │   │   ├── schedule/page.tsx     # Schedule + force re-plan (AC-006-2 #3)
│       │   │   ├── history/page.tsx      # History (AC-006-2 #4 + cold archive recall)
│       │   │   └── overrides/page.tsx    # Override Panel (AC-006-2 #5)
│       │   └── api/
│       │       ├── auth/[...nextauth]/route.ts
│       │       ├── overview/route.ts          # SWR poll target — balance + equity + positions
│       │       ├── schedule/route.ts          # SWR poll target — today's schedule
│       │       ├── pairs/route.ts             # read-only pair list
│       │       ├── overrides/                 # ALL POSTs require CSRF token (NEW per R6)
│       │       │   ├── close-pair/route.ts    # AC-016-1, AC-016-1-b CSRF
│       │       │   ├── close-all/route.ts     # AC-016-2, AC-016-2-b CSRF
│       │       │   ├── edit-position/route.ts # AC-016-3, AC-016-3-b CSRF
│       │       │   ├── pause/route.ts         # AC-017-3 + CSRF
│       │       │   ├── resume/route.ts        # AC-017-3 + CSRF
│       │       │   └── replan/route.ts        # AC-018-1 (`/fire` API call) + CSRF
│       │       ├── reports/[id]/route.ts      # AC-015-1 signed-URL minter
│       │       ├── archive-fetch/route.ts     # ADR-006 cold-archive recall
│       │       └── cron/
│       │           ├── channels-health/route.ts  # AC-005-2 — every 5 min
│       │           ├── audit-archive/route.ts    # ADR-006 — daily 03:30 GMT
│       │           ├── orphan-detect/route.ts    # NFR-004 — daily
│       │           ├── cap-rollup/route.ts       # FR-021 AC-021-1 — daily 12:00 GMT
│       │           └── usage-reconcile/route.ts  # FR-021 conditional, gated on FR-001
│       ├── components/             # shadcn primitives + project-specific
│       │   └── csrf-form.tsx       # wraps forms; injects token from Auth.js session (NEW per R6)
│       ├── lib/
│       │   ├── auth.ts             # Auth.js v5 NextAuth({ adapter: DrizzleAdapter, providers: [Passkey] })
│       │   ├── csrf.ts             # double-submit-cookie helper used by every override POST (NEW per R6)
│       │   ├── mt5-server.ts       # server-only MT5 fetch with bearer header
│       │   ├── stale.ts            # 30s yellow / 60s red banner logic
│       │   └── markdown.ts         # react-markdown wrapper for History view
│       └── tests/
│           ├── e2e/
│           │   ├── auth-routes.spec.ts          # NFR-009 route enumeration
│           │   ├── overview.spec.ts             # AC-006-1..3
│           │   ├── overrides-atomicity.spec.ts  # NFR-007 fault injection (4 boundaries — see R4)
│           │   ├── overrides-csrf.spec.ts       # AC-016-{1,2,3}-b — POST without CSRF token returns 403 (NEW per R6)
│           │   ├── replan.spec.ts               # AC-018-1..3 + AC-018-2-b race window
│           │   └── cold-archive-recall.spec.ts  # ADR-006
│           └── unit/
│               ├── stale.test.ts
│               ├── csrf.test.ts                 # double-submit-cookie helper unit (NEW per R6)
│               └── route-handlers/*.test.ts
└── .harness/                       # Pipeline state — unchanged
```

Notes:
- **lefthook over husky** — already-installed Bun tooling, ~2× faster on Windows pre-commit (operator's dev env is Win11 per env). Husky still works if Evaluator prefers; one-line swap.
- **biome over eslint+prettier** — single binary, native, Bun-friendly. Rules: `noExplicitAny: error`, `noConsole: error`, `noUnusedImports: error`. Constitution §17 enforcement.
- **Reusing existing `.harness/init.sh`** as the dev-laptop preflight — but we will REWRITE it during BUILD to match the new ADRs (Bun instead of pnpm, Tailscale Funnel instead of cloudflared, app-layer bearer instead of CF Access Service Token). The current file still references the pre-clarify silent defaults.

---

## Channels Subagent (AC-004-3) — exact yaml shape (REVISED per R2)

File: `packages/channels/agents/caishen-telegram.md` (deployed to `/opt/caishen-channels/.claude/agents/caishen-telegram.md` via `infra/vps/setup.sh`).

**Layout convention** (R2 driver): `/opt/caishen-channels/` is split into operator-managed (immutable to the subagent) and subagent-managed (writable):

| Path | Purpose | Subagent Read? | Subagent Write? |
|---|---|---|---|
| `/opt/caishen-channels/agents/` | the subagent yaml itself | No | **No** |
| `/opt/caishen-channels/scripts/` | wrapper scripts (status.sh, balance.sh, etc.) | No (only invoked via Bash allowlist) | **No** |
| `/opt/caishen-channels/work/` | scratch / cache / drafted replies | Yes | Yes |
| `/opt/caishen-channels/data/<allowed_data_files>` | small immutable JSON (pair list cache) | Yes (per-file allowlist) | No |
| `/etc/caishen/` | env files; secrets | No | No |

Rationale (R2): the prior `Read(/opt/caishen-channels/**)` + `Write(/opt/caishen-channels/**)` gave the subagent the ability to overwrite `scripts/status.sh` (then any future `/status` command would execute the rewritten script — a real privilege-escalation path). The narrowed allowlist below preserves the subagent's Postgres + MT5 surface fully but excludes its own program files.

```markdown
---
name: caishen-telegram
description: Always-on Telegram surface for the 财神爷 trading system. Handles slash commands and free-text Q&A. Strict allowlist on user IDs and tools.
model: claude-sonnet-4-6
tools:
  # Discrete script paths only — no Bash(*) wildcards (constitution §17 + criteria.md Code Quality)
  - Bash(/opt/caishen-channels/scripts/status.sh)
  - Bash(/opt/caishen-channels/scripts/positions.sh)
  - Bash(/opt/caishen-channels/scripts/report.sh:*)
  - Bash(/opt/caishen-channels/scripts/balance.sh)
  - Bash(/opt/caishen-channels/scripts/history.sh)
  - Bash(/opt/caishen-channels/scripts/pause.sh)
  - Bash(/opt/caishen-channels/scripts/resume.sh)
  - Bash(/opt/caishen-channels/scripts/closeall.sh)
  - Bash(/opt/caishen-channels/scripts/closepair.sh:*)
  - Bash(/opt/caishen-channels/scripts/replan.sh)
  - Bash(/opt/caishen-channels/scripts/edit.sh:*)
  - Bash(/opt/caishen-channels/scripts/check-allowlist.sh:*)
  # MCP tools — narrowly scoped
  - mcp__mt5_rest__get_account_info5
  - mcp__mt5_rest__get_orders5
  - mcp__mt5_rest__get_positions5
  - mcp__mt5_rest__delete_order_pending_*
  - mcp__mt5_rest__put_order_pending_*5
  - mcp__mt5_rest__close_position_*
  - mcp__ffcal__get_calendar_events
  - mcp__postgres_query__query_routine_runs
  - mcp__postgres_query__query_telegram_interactions
  - mcp__postgres_query__query_orders
  - mcp__postgres_query__query_executor_reports
  - mcp__postgres_query__query_pair_schedules
  # File access — narrowly scoped: working dir + immutable data only.
  # CRITICAL (R2): does NOT include scripts/ or agents/. Subagent cannot self-modify.
  - Read(/opt/caishen-channels/work/**)
  - Read(/opt/caishen-channels/data/pair-list-cache.json)
  - Write(/opt/caishen-channels/work/**)
---

You are the always-on Telegram assistant for the 财神爷 forex trading system.
You have two jobs:

1. **Slash commands** (messages starting with `/`): execute the matching script.
   The script writes the audit row and returns a Markdown reply you forward to the user.

2. **Free-text questions** (no leading `/`): use the Postgres MCP tools to read
   relevant audit rows (`routine_runs`, `telegram_interactions`, `orders`,
   `executor_reports`), then answer concisely with real numbers and named sources.

Tone: senior trader's assistant. Tight, numerate, situated. No "Sure!" or
"I'd be happy to help" preambles. No vague "looks good" — always cite numbers
and the audit row IDs you read from.

**Recovery hint** (per ADR-009): if the user references "yesterday" or anything
predating the current session, query `telegram_interactions` directly via
`mcp__postgres_query__query_telegram_interactions` — past chat history is
persisted there even when this session has been restarted. Do not say "I have
no memory of that"; instead, read the audit log and reconstruct.

**Allowlist enforcement**: BEFORE any other action, run
`/opt/caishen-channels/scripts/check-allowlist.sh "$TELEGRAM_FROM_USER_ID"`.
If it exits non-zero, reply ONLY with: "Sorry, this assistant is private —
please contact the operator if you believe this is in error." Then stop. Do
NOT make any tool calls. The check script writes the rejected-interaction
audit row.

**Constitution §3 audit-or-abort**: every reply you generate is recorded by
the wrapping handler script in `telegram_interactions`. You do not write that
row yourself — the script does, before invoking you.

**No tokens for templated work**: if a user asks "what's the balance?", run
the `/opt/caishen-channels/scripts/balance.sh` script and forward its output
verbatim. Don't paraphrase numbers. The script reads MT5 directly without
spending LLM tokens on formatting.

**Time**: every timestamp you display MUST include "GMT" suffix. Times in
the database are ISO 8601 GMT. Do not convert to local timezone.

**Self-modification is forbidden** (R2 — Round 2 hardening): you MUST NOT
attempt to write to `/opt/caishen-channels/scripts/` or
`/opt/caishen-channels/agents/`. Those are operator-managed. If a wrapper
script needs to change, ask the operator to update it via the BUILD pipeline.
Your scratch space is `/opt/caishen-channels/work/`.
```

Wrapper-script idea (e.g., `scripts/balance.sh`): a tiny Bun script that calls MT5 REST locally, formats the reply as Markdown, prints to stdout. The session forwards it. No LLM tokens spent on number formatting.

---

## Outbound Telegram queue table (FR-019 AC-019-1) — DECISION

**Choice: NO queue table. Direct synchronous Telegram Bot API call from the Executor's last step.**

Why no queue:
- ADR-007 already locked direct Bot API for outbound (zero LLM tokens).
- A queue would add a polling latency (channels-session checks every N seconds) and a failure mode (channels session dies → queue grows unbounded → operator misses Telegram alerts at the worst possible moment).
- The Executor is short-lived (one-off routine); a synchronous POST to `https://api.telegram.org/bot{TOKEN}/sendMessage` with a 5-second timeout is simpler and the failure mode is clean: if Telegram itself is down, the audit row records `telegram_send: failed: <reason>` and the operator notices via the dashboard's Telegram-health badge (which polls Telegram's getMe API every 60s).
- The Channels healthcheck (FR-005) is the right place to detect outbound failures — it can broadcast an out-of-band Telegram alert via the same direct Bot API path if the most recent Executor's `telegram_send` field is `failed`.

If FR-019 EC-019-1 (rate-limited) bites in production: add retry-with-backoff (3 attempts, exponential, max 30s total) inside `packages/routines/src/telegram-bot.ts`. NO queue table. If retries are exhausted, audit captures the failure and we move on.

---

## Vercel Sandbox vs alternative for compute_python (FR-013) — CONDITIONAL DESIGN

Per Q8 / ADR-010 Q8 outcome: **FR-013 builds ONLY if FR-001 AC-001-2 math fidelity check shows max relative error ≥ 1e-3 OR Opus refuses to compute.** Most likely Opus 4.7 1M handles ATR fine, so this is a contingency design.

**If we have to build it**:

| Option | Pros | Cons | Choice |
|---|---|---|---|
| **(a) Vercel Sandbox via `compute_python` MCP server hosted as Vercel Function** | Vercel-native; Firecracker microVM; ephemeral; free tier; we already have Vercel | Cold start 200-500ms; one more attack surface (Python eval) | **CHOSEN if needed** |
| (b) Pyodide WASM in the routine's Bash step (no MCP) | Zero infra; runs inside Anthropic's routine container | Pyodide cold-load is ~1-2s; pollutes the Bash step's memory; no isolation between calls | rejected — adds duration risk to FR-001 AC-001-2 |
| (c) Self-hosted Python REPL on operator's VPS | Full control; isolated | Adds VPS surface; bearer-token plumbing; another systemd service to monitor | rejected — operational overhead |
| (d) E2B sandboxes | Production-grade isolation | Per-call API cost; another secret to manage | rejected — paid |

**Implementation outline (if needed)**:
- File: `packages/routines/src/compute-python-mcp/server.ts` — Vercel Function exposing an MCP server.
- Tool: `compute_python(snippet: string, timeout_seconds?: number = 30) -> {result: string, stdout: string, stderr: string, success: boolean}`
- Implementation: per-call ephemeral Vercel Sandbox; Python 3.12 + numpy + pandas + ta-lib pre-installed; no network egress allowed; 30s wall-clock cap; output capped at 64KB.
- Attached to Executor routine as connector via the same `MT5_BASE_URL`-style URL pattern: `COMPUTE_PYTHON_MCP_URL=https://caishen-dashboard.vercel.app/api/mcp/compute-python` with a separate bearer.

**Skip path (likely)**: `decisions.md` records "FR-013 SKIPPED — FR-001 AC-001-2 math fidelity max relative error: {actual} < 1e-3"; the executor routine has no `compute_python` tool attached; saved ~½ day of work + zero new attack surface. The conditional stays reversible per EC-013-2 (operator can re-open via `/harness:edit` if drift observed).

Per Evaluator's Q4 answer: a small skip-marker vitest in `packages/routines/tests/fr-013-skip-marker.test.ts` will additionally assert (a) decisions.md contains the FR-013-SKIPPED line, (b) executor routine connector list does NOT contain `compute_python`, (c) spike report's AC-001-2 math-fidelity section shows max relative error < 1e-3. If FR-013 builds, the test inverts.

---

## Spike implementation outlines (FR-001 — the four LOAD-BEARING ASSUMPTIONS)

Each spike is a self-contained TypeScript module under `packages/routines/src/spike/`. They are run sequentially as the M0 deliverable. Each writes to `routine_runs` per constitution §3, plus appends a section to `docs/spike-report-fr-001.md` with PASS/PARTIAL/FAIL + evidence.

### Spike 1: `ac-001-1-cap-exempt.ts` — does `claude /schedule` from inside a routine count against the cap?

```
1. Pre-condition: read current /usage via the spike runner's CLI (manual SCREENSHOT
   committed to docs/spike-report-fr-001.md alongside, since /v1/usage exposure
   is itself unverified — see also Spike 4).
2. Inside the spike routine's Bash step:
     - bun run packages/routines/src/cap-counter.ts --kind=spike_pre  # ground truth
     - claude /schedule "in 10 minutes, run a no-op shell command (echo OK > /tmp/spike1.flag)"
     - capture stdout (one-off ID + scheduled time)
     - exit
3. Wait 12 minutes (or run as two routine fires).
4. Post-condition:
     - verify /tmp/spike1.flag exists on the routine's filesystem (proves one-off ran)
     - read /usage AGAIN, compare to pre-condition
     - PASS = /tmp/spike1.flag exists AND /usage delta = 0
     - PARTIAL = flag exists AND /usage delta = 1 (one-off counted)
     - FAIL = no flag (one-off didn't fire)
5. Write spike_runs row + append PASS/PARTIAL/FAIL + screenshots to docs/spike-report-fr-001.md.
   If PARTIAL or FAIL: update ADR-002 status to "Default path: (b) /fire API; one-offs
   cap-counted, daily ceiling 14/15".
```

### Spike 2: `ac-001-2-duration-and-math.ts` — does Executor fit in routine duration limit, AND does Opus 4.7 1M math match Python reference?

Combined per Q8 (math fidelity check is part of AC-001-2) — one routine fire exercises both questions because we need a real MSCP-shaped workload anyway.

```
1. Setup: prepare a synthetic 250+180+240+288 = 958-bar OHLC dataset for EUR/USD
   (use a frozen JSON fixture — committed to tests/fixtures/spike/ — derived from a
   real recent trading day so the LLM's reasoning is realistic).
2. Inside the spike routine:
     - record T0 = now()
     - run a single Opus 4.7 1M turn with:
         system = .harness/spec/preserve/spartan-systemprompt.md (verbatim)
         user   = LET'S START\nCurrent Analysis Pair :\nEUR/USD\n\nTime Now: {ISO}\n
                  + the 958-bar fixture pre-loaded into the prompt context
     - parse the LLM's output for: ATR(14) on 1H, structure-key SL price,
       position-size-given-5%-risk
     - record T1 = now()
     - call a Python reference (compute the same three numbers using ta-lib's ATR
       formula + the same SL formula from the SPARTAN prompt)
     - compute max_relative_error = max(|llm[i] - py[i]| / |py[i]|) over the three numbers
3. PASS criteria:
     duration_pass = (T1 - T0) ≤ 12 min on 2 consecutive runs
     math_pass     = max_relative_error < 1e-3
4. Outcomes per AC-001-2 + Q8:
     duration_pass AND math_pass     → BOTH OK; FR-013 SKIPPED in v1
     duration_pass AND !math_pass    → FR-013 BUILDS per original spec (Vercel Sandbox)
     !duration_pass AND math_pass    → ADR-003 fallback: Sonnet 4.6 OR split-Executor
     !duration_pass AND !math_pass   → escalate to operator decision (worst case)
5. Write spike_runs row + append numbers + verdict to docs/spike-report-fr-001.md.
```

### Spike 3: `ac-001-3-fire-api.ts` — does `/fire` API work with the pinned beta header? + (R1) does Anthropic expose a "GET deployed system prompt" endpoint?

Spike 3 was already responsible for verifying the `/fire` POST path; Round 2 EXTENDS its scope to also probe the read-side endpoint that the Tier 2 prompt-preservation test depends on. Cost is one extra GET request per spike run; outcome determines whether the deployed-side byte-identity test (AC-002-1-b / AC-003-1-b) runs in CI.

```
1. Pre-create a no-op routine in the Anthropic console named 财神爷-spike-noop
   (its body just prints "OK" and exits). Capture its routine_id + bearer token.
2. From the dev laptop (NOT inside another routine — this tests the dashboard's path):
     curl -X POST https://api.anthropic.com/v1/routines/{routine_id}/fire \
          -H "Authorization: Bearer ${ROUTINE_BEARER}" \
          -H "anthropic-beta: experimental-cc-routine-2026-04-01" \
          -H "Content-Type: application/json" \
          -d '{"text":"spike3 verification"}'
3. Assert response shape matches:
     {type: "routine_fire", claude_code_session_id: string, claude_code_session_url: string}
4. Verify session_url is reachable (HEAD request, expect 200 or 302 to Anthropic login).
5. PASS = response shape matches AND session_url reachable.
6. (R1) ALSO probe the system-prompt READ endpoint candidates in this order
   (first 200 wins; record which one in spike report so the deployed-side test
   knows the URL to call):
     a. GET https://api.anthropic.com/v1/routines/{routine_id}
        — expect body to contain `system_prompt` field
     b. GET https://api.anthropic.com/v1/routines/{routine_id}/system_prompt
        — endpoint may not exist; 404 acceptable
   Authorization: Bearer ${ROUTINE_BEARER}; same anthropic-beta header.
   Outcome:
     200 + system_prompt visible → record endpoint URL in spike report;
                                    Tier 2 deployed-side test (AC-002-1-b / AC-003-1-b)
                                    is ENABLED in CI.
     404 / no field              → record "no read endpoint found" in spike report;
                                    Tier 2 test is SKIPPED in CI; manual
                                    screenshot+diff added to operator's pre-deploy
                                    checklist; implementation-report.md flags this.
7. Pin the beta header in `apps/dashboard/.env.example` and the routines'
   secret-env-vars: `ROUTINE_BETA_HEADER=experimental-cc-routine-2026-04-01`.
8. Add CI smoke test (.github/workflows/beta-header.yml) that runs Spike 3 (POST + GET probe)
   on every commit to main. Failure pages operator via Telegram (ADR-004).
```

### Spike 4: `ac-001-4-token-soak.ts` — does combined Routines + Channels session token use stay ≤ 80% Max 20x weekly?

```
1. Pre-condition: take a screenshot of /usage (manual; this is part of the spike
   report). Note current weekly slot %.
2. Run for 24 hours:
     - Spike 2's Executor-shaped workload, fired 14 times spaced 1 hour apart
       (simulating max daily Executor count from AC-012-3 math)
     - 1 daily Planner fire (Spike 1 has already exercised /schedule path)
     - 50 synthetic Telegram messages spaced through the 24h window
       (mix of slash commands + 3-turn free-text Q&A)
3. Post-condition:
     - take another /usage screenshot
     - compute delta_weekly_pct = (post_pct - pre_pct) (this is one day, so weekly
       projection = delta * 7 — then * 1/0.71 for "real day" oversampling adjustment
       since we packed 24h with peak load)
4. PASS = projected_weekly_pct ≤ 80%
   PARTIAL = 80-95%
   FAIL    = > 95%
5. Outcomes:
     PASS    → no architecture change
     PARTIAL → FR-021 hard-stop alert at 12/15 daily AND record in architecture.md
     FAIL    → degrade Channels session to slash-only (route /status, /positions,
               /balance, /history through Vercel Functions; only /closepair, /closeall,
               /edit, /pause, /resume, /replan stay LLM-mediated AND free-text Q&A
               capped at 1K output tokens)
6. ALSO during this spike: probe whether https://api.anthropic.com/v1/usage exists
   and is callable with the routine's bearer (call once with curl; if 200, great;
   if 404, this confirms ADR-008's "local-counters-only" v1 path; if 200, schedule
   FR-021 follow-on cron).
```

The four spike outputs jointly inform: ADR-002 (cap path), ADR-003 (Executor LLM), ADR-004 (beta header pinning), ADR-008 (cap monitoring source), FR-013 (SKIP vs BUILD), AND the new R1 question of whether deployed-side prompt-preservation runs in CI (Spike 3 § step 6).

---

## Two-tier prompt-preservation test (NEW per R1) — file-side always; deployed-side conditional

**Driver**: Constitution §2 mandates "A CI test MUST diff the deployed routine prompt against the file and fail on any difference." Whether the deployed prompt is fetchable depends on whether Anthropic exposes a "GET routine system_prompt" endpoint — confirmed by Spike 3 step 6 above.

### Tier 1 — file-side (ALWAYS runs in CI; covers AC-002-1 and AC-003-1)

File: `packages/routines/tests/prompt-preserve.test.ts`

```
For each prompt file in {.harness/spec/preserve/spartan-systemprompt.md,
                          .harness/spec/preserve/planner-systemprompt.md}:
  1. Read raw bytes from .harness/spec/preserve/<file>
  2. Read raw bytes from packages/routines/src/preserve-mirror/<file> — the file
     ACTUALLY shipped to Anthropic by the routine creation tooling (this mirror
     exists because the routine creation script reads from it; .harness/spec/
     is the source-of-truth and a pre-build step copies it byte-for-byte to the
     mirror before deployment).
  3. Assert byte-identical:
       expect(Buffer.compare(srcBuf, mirrorBuf)).toBe(0)
     This catches:
       - smart-quote substitution
       - line-ending normalization (CRLF vs LF)
       - trailing-whitespace stripping by an editor
       - BOM injection
  4. ALSO assert no `“` / `”` (curly quotes), no `–` / `—`
     (en/em dash) in mirror (positive guard against Unicode normalization).
```

PASS criterion: byte-identical, no Unicode normalization. This is the always-on guard that the file we ship is correct.

### Tier 2 — deployed-side (CONDITIONAL on Spike 3 outcome; covers AC-002-1-b / AC-003-1-b new ACs)

File: `packages/routines/tests/prompt-preserve-deployed.test.ts`

```
1. Read .harness/data/spike-fr-001-outcomes.json (committed by Spike 3).
2. If outcomes.deployed_prompt_endpoint == null:
     test.skip("Tier 2 deployed-side prompt-preservation: endpoint not available
                — operator's pre-deploy checklist covers this manually.")
     Implementation-report.md MUST flag this so Evaluator knows constitution §2
     verification is at file-side only.
3. Else:
     For each routine_id in {planner_routine_id, executor_routine_id}:
       a. GET ${outcomes.deployed_prompt_endpoint URL pattern} with bearer
       b. Extract system_prompt field
       c. Read .harness/spec/preserve/<corresponding file>
       d. Assert byte-identical (same Buffer.compare check)
4. Run frequency: on every commit to main, plus a weekly cron (in case console
   was edited manually post-deploy).
```

PASS criterion: byte-identical between live routine and source file. The conditional skip is the documented R1 escape hatch — and the implementation-report flag makes the partial coverage visible to the Evaluator.

### Pre-deploy checklist addendum (operator side, for the deployed-side-not-available case)

`docs/operator-pre-deploy-checklist.md` (NEW file in BUILD):

```
Before deploying a routine prompt change:
1. Edit `.harness/spec/preserve/{spartan,planner}-systemprompt.md`.
2. Run `bun run preserve-mirror-sync` (copies file to packages/routines/src/preserve-mirror/).
3. Run `bun vitest packages/routines/tests/prompt-preserve.test.ts` — must pass.
4. IF Tier 2 endpoint is unavailable (per spike-fr-001-outcomes.json):
   a. Open Anthropic console → routine 财神爷-{planner|executor}.
   b. Copy deployed system prompt to a temp file `tmp/deployed.md`.
   c. Run `diff -u .harness/spec/preserve/<file> tmp/deployed.md` — expect zero diff.
   d. Take screenshot, commit to docs/preserve-screenshots/<date>-{routine}.png.
5. Deploy via the routine creation tooling.
```

This converts R1 from "missing test" to "two-tier test with documented operator step for the unsupported case".

---

## Re-plan cleanup flow (NEW per R3) — explicit ordering for FR-002 EC-002-3 + FR-018 AC-018-2

**Driver**: AC-018-2 says "today's stale one-offs are best-effort cancelled" but didn't define ordering or race semantics. Round 2 commits to:

### Cancellation path

Anthropic Routines API v1 (per Spike 3 probe) does not currently expose a `/v1/one-offs/{id}/cancel` endpoint that would let us actively kill a scheduled one-off. Therefore "best-effort cancel" means:

1. **Database-side cancellation**: mark `pair_schedules.status = 'cancelled'` for stale rows. The corresponding `scheduled_one_off_id` may still fire on Anthropic's side.
2. **Pre-fire defense**: the Executor routine, on START, reads its own `(pair, session, today)` row from `pair_schedules`. If `status != 'scheduled'` (i.e., cancelled, or row no longer exists), it immediately writes a `routine_runs` row with `status='completed'`, `output_json={"reason": "stale-plan-noop"}`, and exits BEFORE any MT5 call. This is the same code path as the paused-executor case (FR-017 AC-017-4), wrapped in `withAuditOrAbort`.

### Transactional ordering inside `/api/overrides/replan` POST handler (REVISED per R3-followup in Round 3)

**Round 3 change vs Round 2**: Round 2 wrapped the entire flow in a single `tenantDb.transaction(...)` and the external `/fire` POST happened INSIDE that transaction. That holds Postgres row locks across a multi-second remote call, which the Evaluator correctly flagged as anti-pattern (lock contention under load + ambiguous state if `/fire` returns 200 but the network drops the response).

Round 3 splits the flow into **two transactions bridged by the `success=null` in-flight marker** that R4 already specified for override_actions. The external `/fire` POST sits between the two transactions, OUTSIDE any DB tx:

```typescript
async function handleReplan(tenantDb, operatorUserId, csrfToken) {
  // R6: validate CSRF first (NO DB work yet)
  if (!validateCsrf(csrfToken)) throw 403;

  // Cap-budget confirmation already enforced upstream (AC-018-1).

  return withAuditOrAbort(tenantDb, { routine_name: 'replan_orchestrator', ... }, async (runId) => {
    // ─────────────────────────────────────────────────────────────────────
    // Transaction A — cancel + insert in-flight audit row
    //
    // Holds Postgres locks for ONLY the duration of two writes (~1ms each).
    // No remote calls inside.
    // ─────────────────────────────────────────────────────────────────────
    const { auditId, beforeSchedule, cancelledRowIds } = await tenantDb.transaction(async (tx) => {
      // A1. Read current schedule (for diff visibility + audit before_state).
      const before = await tx.select().from(pair_schedules)
        .where(and(eq(tenant_id), eq(date, todayGmt()), eq(status, 'scheduled')));

      // A2. Mark today's existing pair_schedules rows as cancelled
      //     (status='cancelled'; do NOT delete — audit history preserved).
      const cancelled = await tx.update(pair_schedules)
        .set({ status: 'cancelled' })
        .where(and(eq(tenant_id), eq(date, todayGmt()), eq(status, 'scheduled')))
        .returning({ id: pair_schedules.id });

      // A3. Insert override_actions row in IN-FLIGHT state (success=null).
      //     The orphan-detect cron (NFR-004) already watches for success=null
      //     rows older than 5 min — if Transaction B never lands, this row
      //     becomes visible to the cron and gets manually settled or alerted.
      const [{ id }] = await tx.insert(override_actions).values({
        action_type: 'replan',
        operator_user_id: operatorUserId,
        before_state_json: { schedule: before },
        after_state_json: null,
        success: null,         // ← in-flight marker (R4 schema delta)
        error_message: null,
        params_json: { trigger: 'dashboard' },
      }).returning({ id: override_actions.id });

      return { auditId: id, beforeSchedule: before, cancelledRowIds: cancelled.map(r => r.id) };
    });
    // Transaction A committed. Postgres locks released. Cancelled rows are
    // visible to the Executor's pre-fire stale-check. Even if Transaction B
    // never lands, the system is consistent: stale Executors will noop, the
    // operator can see the in-flight row in the dashboard.

    // ─────────────────────────────────────────────────────────────────────
    // External `/fire` POST — NO DB tx open. Multi-second latency OK.
    // ─────────────────────────────────────────────────────────────────────
    let fireResp: FireApiResponse | null = null;
    let fireErr: unknown = null;
    try {
      fireResp = await callFireApi({ routine_id: PLANNER_ROUTINE_ID, ... });
    } catch (e) {
      fireErr = e;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Transaction B — settle the audit row
    //
    // Two writes (~1ms each). If THIS tx fails (DB blip), the override_actions
    // row stays in success=null state; orphan-detect cron handles it.
    // ─────────────────────────────────────────────────────────────────────
    await tenantDb.transaction(async (tx) => {
      if (fireErr) {
        await tx.update(override_actions)
          .set({
            success: false,
            error_message: `fire_api_failed: ${String(fireErr).slice(0, 500)}`,
            after_state_json: { cancelled_pair_schedule_ids: cancelledRowIds },
          })
          .where(eq(override_actions.id, auditId));
      } else {
        await tx.update(override_actions)
          .set({
            success: true,
            after_state_json: {
              planner_session_id: fireResp!.claude_code_session_id,
              planner_session_url: fireResp!.claude_code_session_url,
              cancelled_pair_schedule_ids: cancelledRowIds,
            },
          })
          .where(eq(override_actions.id, auditId));
      }
    });

    // Telegram broadcast (AC-018-3) — outside both txs, after commit, in
    // a try/catch. A TG failure does NOT roll back the replan.
    if (fireResp && !fireErr) {
      try { await broadcastTgNewSchedule(fireResp); } catch (e) { /* logged, not fatal */ }
    }

    if (fireErr) throw fireErr; // propagate to withAuditOrAbort wrapper for routine_runs row
    return { runId, plannerSessionId: fireResp!.claude_code_session_id };
  });
}
```

**Why this design**:

1. **No row locks across remote calls**. Both transactions are short-lived writes (~1ms total per tx). Connection-pool sizing under load no longer interacts with Anthropic API latency.
2. **`success=null` in-flight marker** is the bridge — already specified by R4 for the override-handler flow, reused here. The orphan-detect cron (NFR-004) already polls for `override_actions WHERE success IS NULL AND at < now() - interval '5 minutes'` so an audit-row stuck in-flight gets surfaced for manual recovery.
3. **Failure modes mapped to deterministic states**:

| Failure point | Database state after | Recovery |
|---|---|---|
| Tx A fails (e.g., DB unavailable) | No cancellation, no audit row, no /fire call | Operator retries replan; nothing has changed |
| `/fire` POST fails (timeout, 5xx, network blip) | Old rows = cancelled; audit row = `success=null`; `/fire` not made | Tx B catches `fireErr` → audit row = `success=false`. Operator sees error toast, retries. Stale executors that fire from Anthropic side noop via R3 pre-fire check |
| `/fire` POST succeeds but response is dropped before client receives | Old rows = cancelled; audit row = `success=null`; Anthropic fired the Planner | Tx B catches the network error → audit row = `success=false` with misleading `error_message`. The Planner's own routine-run row (`routine_runs WHERE routine_name='planner'`) provides ground truth. The orphan-detect cron will cross-reference and surface the disagreement; operator confirms via dashboard. Worst case: the operator manually re-triggers, which is idempotent — the new Planner write will overwrite the previous Planner's pair_schedules rows for the same (tenant, date) keys (sub-action g uses `INSERT ... ON CONFLICT DO UPDATE` per FR-002 AC-002-2g) |
| Tx B fails (DB blip after `/fire` succeeded) | Old rows = cancelled; audit row = `success=null`; new rows being written by Planner sub-action g | Orphan-detect cron picks up the `success=null` row > 5 min old; operator manually sets `success=true` after verifying the Planner ran (visible in `routine_runs`). The data is consistent; only the audit log is stale-but-recoverable |

4. **Race window with the new Planner**: between Tx A committing and Tx B running, the new Planner is firing. The Planner's sub-action g writes new `pair_schedules` rows. If Tx B fires CONCURRENTLY with the Planner's writes, there's no conflict — Tx B writes only to `override_actions`, Planner writes only to `pair_schedules`. No row-level lock contention.
5. **Idempotency**: a second replan triggered while the first is in-flight (operator double-clicks) is gated by the dashboard `<CsrfForm>` re-fetching a fresh token; the ON CONFLICT clause in the Planner sub-action g naturally absorbs the second write.

Key invariants (carry over from Round 2):
- Old rows are marked `cancelled`, NOT deleted. Audit history preserved.
- New rows are written by the Planner's body (sub-action g), not by the route handler — this keeps the Planner authoritative for scheduling.

Tests in `replan-cleanup.test.ts` are EXTENDED (Round 3) to cover the new failure modes:
- Case 5 (NEW): Tx A succeeds, `/fire` rejects → assert `success=false`, `error_message` populated, `after_state_json.cancelled_pair_schedule_ids` populated, audit row settled (success ≠ null).
- Case 6 (NEW): Tx A succeeds, `/fire` resolves, Tx B mock-throws → assert audit row stays `success=null` (in-flight), assert orphan-detect cron picks it up after time-warp.

### Race window: a one-off fires DURING the cancel-then-fire-Planner gap

Timeline:
- `t0`: re-plan starts; old row marked `cancelled`.
- `t0 + 100ms`: `/fire` POST starts.
- `t0 + 200ms`: BEFORE the Planner has written new rows, the OLD scheduled one-off (queued at Anthropic side) actually fires. Its routine starts.
- `t0 + 300ms`: Old Executor routine begins. Runs `withAuditOrAbort`. First step: read its `(pair, session, today)` row from `pair_schedules`.
- Outcome A: row exists with `status='cancelled'` → write stale-plan-noop `routine_runs` end-row + `output_json={"reason": "stale-plan-noop", "executor_one_off_status": "cancelled"}`, exit. Zero MT5 calls.
- Outcome B: Planner has already overwritten the row (status='scheduled' again, but with new `scheduled_one_off_id`) → still detect the mismatch: this Executor's `routine_run` has its own one-off ID stamped at fire time; if the row's `scheduled_one_off_id` ≠ this one's, it's a stale one-off → same noop behavior.

**Implementation**: `packages/routines/src/executor.ts` first 20 lines ALWAYS check this BEFORE any MT5 call. The check uses the executor's own one-off ID (Anthropic provides it as `$ANTHROPIC_ONE_OFF_ID` env var per Spike 3 finding) compared against `pair_schedules.scheduled_one_off_id` for the (pair, session, today) row.

### Tests

`packages/routines/tests/replan-cleanup.test.ts` — vitest cases:

1. **AC-018-2 ordering**: pre-state has 14 `pair_schedules` rows (status='scheduled'). Call `handleReplan` with mocked `/fire`. Post-state: 14 rows status='cancelled', plus N new rows status='scheduled' (N = whatever the Planner mock returned). Audit row written.
2. **AC-018-2-b race window**: pre-state has 1 `pair_schedules` row, status='cancelled' (simulating the gap). Call executor.start() with mocked MT5. Assert: zero MT5 mock calls; `routine_runs` row written with `output_json.reason === "stale-plan-noop"`.
3. **Stale one-off ID mismatch**: pre-state has row status='scheduled' but with a `scheduled_one_off_id` ≠ the executor's `$ANTHROPIC_ONE_OFF_ID`. Same noop expectation.
4. **Happy path**: pre-state row status='scheduled' AND `scheduled_one_off_id` == `$ANTHROPIC_ONE_OFF_ID`. Executor proceeds normally.

These four cases jointly verify R3 + AC-018-2 + AC-018-2-b.

---

## Override handler flow (NEW per R4) — read-before-write semantics for AC-007-3 + AC-007-3-b + NFR-007

**Driver**: Without specifying which boundary `before_state_json` is captured at, "atomicity" testing has no defined surface. Round 2 commits to a 7-step flow per override route handler.

### The flow (every `/api/overrides/{close-pair, close-all, edit-position}` POST)

```typescript
// packages/dashboard/lib/override-handler.ts
async function executeOverride(req: Request, action: OverrideAction): Promise<Response> {
  // 1. Re-verify Auth.js session (already in proposal Round 1)
  const session = await auth();
  if (!session?.user) return new Response('unauthorized', { status: 401 });

  // 2. (R6) Validate CSRF token. 403 BEFORE any MT5 fetch or audit insert.
  const csrf = req.headers.get('x-csrf-token') ?? (await req.json())?.csrf;
  if (!validateCsrf(csrf, session)) return new Response('csrf invalid', { status: 403 });

  // 3. (R4) READ from MT5 BEFORE any state-mutating call.
  //    Per action_type:
  //      close_pair  → mt5.getPositionsByPair(pair)
  //      close_all   → mt5.getAllPositions()
  //      edit_sl_tp  → mt5.getPosition(ticket)
  //    If MT5 read fails: insert override_actions row with success=false,
  //      error_message='mt5_read_failed: <reason>', before_state_json=null,
  //      after_state_json=null. Return 502 with toast text. Zero Telegram.
  let beforeState: unknown;
  try {
    beforeState = await readMt5StateForAction(action);
  } catch (err) {
    await auditOverride(tenantDb, { action, beforeState: null, afterState: null,
                                     success: false, errorMessage: `mt5_read_failed: ${err}` });
    return new Response(JSON.stringify({ error: 'mt5_read_failed' }), { status: 502 });
  }

  // 4. INSERT override_actions row in the in-flight state (success=null).
  //    If audit insert fails: REFUSE to call MT5 — constitution §3 + §11.
  let auditId: number;
  try {
    auditId = await auditOverrideInsert(tenantDb, {
      action,
      beforeState,
      success: null,  // in-flight marker
    });
  } catch (err) {
    return new Response('audit_failed_aborting', { status: 503 });
  }

  // 5. WRITE to MT5 (close / modify).
  //    On failure: update audit row with success=false, error_message,
  //    after_state=last-known.
  try {
    const writeResp = await writeMt5StateForAction(action);

    // 6. Read post-state OR use the MT5 response.
    //    For close_pair / close_all: re-read mt5.getPositionsByPair() (expect empty).
    //    For edit_sl_tp: use writeResp.position (MT5's authoritative reply).
    const afterState = action.type === 'edit_sl_tp' ? writeResp.position
                                                    : await mt5.getPositionsByPair(action.pair);

    // 7. UPDATE audit row with success=true, after_state.
    //    Then: enqueue Telegram broadcast (out-of-tx; failure of TG send is
    //    captured separately and does not roll back the override).
    await auditOverrideUpdate(tenantDb, auditId, { afterState, success: true });
    await telegramBroadcast({ action, before: beforeState, after: afterState });

    return new Response(JSON.stringify({ success: true, auditId }), { status: 200 });
  } catch (err) {
    await auditOverrideUpdate(tenantDb, auditId, {
      afterState: await safeReadMt5StateForAction(action), // last-known; may equal before
      success: false,
      errorMessage: `mt5_write_failed: ${err}`,
    });
    return new Response(JSON.stringify({ error: 'mt5_write_failed' }), { status: 502 });
  }
}
```

### NFR-007 fault-injection test surface (4 boundaries)

Per Risk Flag #3 (mock at the route-handler boundary using MSW server-side):

| Boundary | What it tests | Test file |
|---|---|---|
| (a) MT5 READ fails | step 3 → audit row with success=false + before/after both null + 502 + no TG | `overrides-atomicity.spec.ts` test #1 |
| (b) Audit INSERT fails | step 4 → 503 + zero MT5 write + zero TG | test #2 |
| (c) MT5 WRITE fails | step 5 → audit row with success=false + before captured + after=last-known + 502 + no TG | test #3 |
| (d) Audit UPDATE fails | step 7 → log error, but the MT5 write already happened — this is the "we did the action but couldn't record success" edge; cron orphan-detect catches this within 24h. Test asserts: alert fires + audit row stays in 'in-flight' state (success=null) for cron pickup | test #4 |

### AC-007-3-b new test (driven by R4)

`packages/dashboard/tests/e2e/overrides-atomicity.spec.ts`:

```typescript
test('AC-007-3-b: before_state_json is captured from a real MT5 read pre-mutation', async () => {
  // Mock MT5 to return state X on read, success on write
  msw.use(
    rest.get('*/positions/EURUSD', (req, res, ctx) =>
      res(ctx.json({ positions: [{ ticket: 999, sl: 1.05, tp: 1.10, volume: 0.5 }] }))),
    rest.post('*/close_position_999', (req, res, ctx) => res(ctx.json({ success: true }))),
  );

  await page.goto('/overrides');
  await page.click('button:has-text("Close EUR/USD")');

  // Assert audit row
  const row = await db.select().from(override_actions).orderBy(desc(at)).limit(1);
  expect(row[0].before_state_json).toMatchObject({
    positions: [{ ticket: 999, sl: 1.05, tp: 1.10 }],
  });
  expect(row[0].success).toBe(true);
});

test('AC-007-3-b (write fails): before captured, after=last-known, success=false, no TG', async () => {
  msw.use(
    rest.get('*/positions/EURUSD', (req, res, ctx) =>
      res(ctx.json({ positions: [{ ticket: 999, sl: 1.05, tp: 1.10 }] }))),
    rest.post('*/close_position_999', (req, res, ctx) => res(ctx.status(500))),
  );

  await page.goto('/overrides');
  await page.click('button:has-text("Close EUR/USD")');
  await expect(page.getByText(/error/i)).toBeVisible();

  const row = await db.select().from(override_actions).orderBy(desc(at)).limit(1);
  expect(row[0].before_state_json.positions[0].ticket).toBe(999);
  expect(row[0].success).toBe(false);
  expect(row[0].error_message).toMatch(/mt5_write_failed/);

  expect(telegramBotMock).not.toHaveBeenCalled();
});
```

This test surface satisfies AC-007-3-b directly and feeds NFR-007 atomicity verification.

---

## CSRF protection (REVISED per R6 in Round 3) — self-issued HMAC double-submit-cookie

**Driver**: Auth.js v5 cookie sessions are vulnerable to CSRF on custom POST routes. Override actions (close-all, edit-SL/TP) are precisely the destructive operations a CSRF attack would target.

**Round 3 change vs Round 2**: Round 2 attempted to re-verify Auth.js's own CSRF cookie using `createHash('sha256').update(token + AUTH_SECRET)`. This was wrong on two axes confirmed via Context7:
1. Auth.js v5 stores its CSRF token in an **encrypted JWE cookie** (A256CBC-HS512), not in a `token|hash` plain-text concat. Re-verifying it from outside the library is brittle and would always return `false` against legitimate cookies.
2. The cookie was renamed in v5: `next-auth.csrf-token` → `authjs.csrf-token` (per the v5 migration doc).

The fix Round 3 commits to: **issue our own HMAC-signed CSRF cookie that we control end-to-end** (separate from Auth.js's internal CSRF cookie). This decouples our CSRF check from Auth.js internals (so future Auth.js library updates don't break our CSRF path), uses HMAC (the canonical primitive for double-submit-cookie integrity), and uses Node's `crypto.timingSafeEqual` for constant-time comparison (defends against timing attacks).

### Implementation: self-issued HMAC double-submit-cookie

Three pieces:
1. **Issuer** (`lib/csrf.ts → issueCsrfToken()`): generates a fresh 32-byte random token, computes `signature = HMAC-SHA256(AUTH_SECRET, token)`, returns `token|signature`. Called from a Next.js Route Handler `GET /api/csrf` that the form-side fetches; sets the cookie + returns the raw token in the JSON body.
2. **Validator** (`lib/csrf.ts → validateCsrf()`): reads the cookie, parses `token|signature`, recomputes `expectedSig = HMAC-SHA256(AUTH_SECRET, token)`, length-preflights then `timingSafeEqual`s `signature` vs `expectedSig`, then `timingSafeEqual`s `submittedToken` vs `token`. Both checks must pass.
3. **Cookie attributes** (production): `__Host-caishen.csrf-token`, `Path=/`, `Secure`, `HttpOnly=false` (form-side JS must read it), `SameSite=Strict`. Dev: `caishen.csrf-token` (no `__Host-` because dev is HTTP). The `__Host-` prefix mandates `Secure` + `Path=/` + no `Domain` attribute, so the cookie cannot leak to subdomains.

`packages/dashboard/lib/csrf.ts`:

```typescript
// HMAC-signed double-submit-cookie. Self-contained — does NOT rely on Auth.js's
// internal CSRF cookie (which is JWE-encrypted in v5; re-verifying it from
// outside the library is brittle).
//
// References:
// - HMAC pattern: OWASP Cheat Sheet — "Cross-Site_Request_Forgery_Prevention"
//   (Signed Double-Submit Cookie)
// - timingSafeEqual: https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptotimingsafeequala-b
//   (throws RangeError if buffer lengths differ — preflight first)

import { cookies } from 'next/headers';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE_PROD = '__Host-caishen.csrf-token';
const COOKIE_DEV  = 'caishen.csrf-token';
const cookieName  = () =>
  process.env.NODE_ENV === 'production' ? COOKIE_PROD : COOKIE_DEV;

const SIG_HEX_LEN = 64; // sha256 digest = 32 bytes = 64 hex chars

function hmacSig(token: string): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET missing — cannot sign CSRF token');
  return createHmac('sha256', secret).update(token).digest('hex');
}

/** Generate a new CSRF token + signature. Called by GET /api/csrf. */
export function issueCsrfToken(): { token: string; cookieValue: string } {
  const token = randomBytes(32).toString('hex'); // 64-hex-char client token
  const sig   = hmacSig(token);
  return { token, cookieValue: `${token}|${sig}` };
}

/** Set the cookie on the outgoing response (called by GET /api/csrf). */
export function setCsrfCookie(cookieValue: string): void {
  cookies().set(cookieName(), cookieValue, {
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    httpOnly: false,         // form-side JS must read this to echo it back
    sameSite: 'strict',
    maxAge: 60 * 60 * 12,    // 12h — survives a workday
  });
}

/** Validate a submitted token against the cookie. Returns true ONLY if BOTH
 *  the cookie's HMAC integrity holds AND the submitted token matches the
 *  cookie's token half. Constant-time on both comparisons. */
export function validateCsrf(submittedToken: string | null | undefined): boolean {
  if (!submittedToken) return false;

  const cookie = cookies().get(cookieName())?.value;
  if (!cookie) return false;

  const sepIdx = cookie.indexOf('|');
  if (sepIdx <= 0 || sepIdx >= cookie.length - 1) return false;
  const cookieToken = cookie.slice(0, sepIdx);
  const cookieSig   = cookie.slice(sepIdx + 1);

  // 1. Verify the cookie's own HMAC integrity (defends against a token-only
  //    forgery from a third-party origin that somehow read just the token half).
  if (cookieSig.length !== SIG_HEX_LEN) return false;
  const expectedSig = hmacSig(cookieToken);
  // expectedSig is also 64 hex chars; preflight already done.
  const sigA = Buffer.from(cookieSig,    'hex');
  const sigB = Buffer.from(expectedSig,  'hex');
  if (sigA.length !== sigB.length) return false;
  if (!timingSafeEqual(sigA, sigB)) return false;

  // 2. Verify the submitted token matches the cookie token (constant-time).
  const subBuf = Buffer.from(submittedToken);
  const ckBuf  = Buffer.from(cookieToken);
  if (subBuf.length !== ckBuf.length) return false;
  return timingSafeEqual(subBuf, ckBuf);
}
```

Every override route handler calls `validateCsrf(req.headers.get('x-csrf-token') ?? body.csrf)` BEFORE the MT5 read (per R4 step 2). Failure returns 403 with `{ error: 'csrf_invalid' }`. The validator does NOT take a `Session` parameter — Auth.js session verification happens in step 1 of the override handler flow; CSRF is independent.

The companion route `app/api/csrf/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { issueCsrfToken, setCsrfCookie } from '@/lib/csrf';
import { auth } from '@/lib/auth';

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { token, cookieValue } = issueCsrfToken();
  setCsrfCookie(cookieValue);
  return NextResponse.json({ csrfToken: token });
}
```

### Form-side wiring (REVISED — fetches from `/api/csrf`, not `getCsrfToken()`)

`packages/dashboard/components/csrf-form.tsx`:

```tsx
'use client';
import { useEffect, useState } from 'react';

export function CsrfForm({ action, children, ...props }: Props) {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/csrf', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(j => setToken(j?.csrfToken ?? null));
  }, []);
  if (!token) return null;
  return (
    <form action={action} {...props}>
      <input type="hidden" name="csrf" value={token} />
      {children}
    </form>
  );
}
```

Every dashboard override form uses `<CsrfForm>`. Forgetting to use it = no token submitted = 403 = test catches it. **Note**: this replaces the Round 2 use of `next-auth/react`'s `getCsrfToken()` — we do not use Auth.js's CSRF endpoint at all (it would return a token signed by JWE that our `validateCsrf` cannot verify).

### AC-016-{1,2,3}-b new tests (REVISED — split into algorithm-pinning unit + Playwright e2e)

**NEW Round 3 unit test** — `packages/dashboard/tests/unit/csrf.test.ts` — pins the HMAC algorithm against a known fixture so the BUILD cannot silently drift to a different primitive (e.g., back to `createHash` concat, or to a different hash function):

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { issueCsrfToken, validateCsrf } from '../../lib/csrf';

// Mock next/headers cookies() so we can inject a fake cookie.
const fakeCookies = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: () => ({
    get: (k: string) => (fakeCookies.has(k) ? { value: fakeCookies.get(k) } : undefined),
    set: (k: string, v: string) => { fakeCookies.set(k, v); },
  }),
}));

describe('CSRF — algorithm pinning (R6 anti-drift)', () => {
  const FIXED_SECRET = 'test-fixture-secret-do-not-change';
  const FIXED_TOKEN  = 'a'.repeat(64); // 64 hex chars
  // Pre-computed once: HMAC-SHA256(FIXED_SECRET, FIXED_TOKEN) hex
  const KNOWN_GOOD_SIG = createHmac('sha256', FIXED_SECRET)
                          .update(FIXED_TOKEN)
                          .digest('hex');

  beforeEach(() => {
    fakeCookies.clear();
    process.env.AUTH_SECRET = FIXED_SECRET;
    process.env.NODE_ENV    = 'development';
  });

  it('accepts a token whose signature is HMAC-SHA256(AUTH_SECRET, token)', () => {
    fakeCookies.set('caishen.csrf-token', `${FIXED_TOKEN}|${KNOWN_GOOD_SIG}`);
    expect(validateCsrf(FIXED_TOKEN)).toBe(true);
  });

  it('REJECTS a token whose signature is the broken concat-hash that Round 2 had', () => {
    // The Round 2 algorithm: createHash('sha256').update(token + secret).digest('hex')
    const { createHash } = require('node:crypto');
    const brokenSig = createHash('sha256')
                       .update(FIXED_TOKEN + FIXED_SECRET)
                       .digest('hex');
    fakeCookies.set('caishen.csrf-token', `${FIXED_TOKEN}|${brokenSig}`);
    expect(validateCsrf(FIXED_TOKEN)).toBe(false);
  });

  it('REJECTS a token whose signature uses a different HMAC key', () => {
    const wrongKeySig = createHmac('sha256', 'WRONG_SECRET')
                         .update(FIXED_TOKEN)
                         .digest('hex');
    fakeCookies.set('caishen.csrf-token', `${FIXED_TOKEN}|${wrongKeySig}`);
    expect(validateCsrf(FIXED_TOKEN)).toBe(false);
  });

  it('REJECTS when submitted token does not match cookie token', () => {
    fakeCookies.set('caishen.csrf-token', `${FIXED_TOKEN}|${KNOWN_GOOD_SIG}`);
    expect(validateCsrf('z'.repeat(64))).toBe(false);
  });

  it('REJECTS when cookie is missing entirely', () => {
    expect(validateCsrf(FIXED_TOKEN)).toBe(false);
  });

  it('REJECTS when cookie has no | separator', () => {
    fakeCookies.set('caishen.csrf-token', 'no-separator-here');
    expect(validateCsrf(FIXED_TOKEN)).toBe(false);
  });

  it('issueCsrfToken() output round-trips through validateCsrf()', () => {
    const { token, cookieValue } = issueCsrfToken();
    fakeCookies.set('caishen.csrf-token', cookieValue);
    expect(validateCsrf(token)).toBe(true);
  });

  it('uses __Host- prefix on production', () => {
    process.env.NODE_ENV = 'production';
    const { token, cookieValue } = issueCsrfToken();
    fakeCookies.set('__Host-caishen.csrf-token', cookieValue);
    expect(validateCsrf(token)).toBe(true);
    // And the dev-name cookie does NOT count in production:
    fakeCookies.clear();
    fakeCookies.set('caishen.csrf-token', cookieValue);
    expect(validateCsrf(token)).toBe(false);
  });
});
```

The second case (`REJECTS a token whose signature is the broken concat-hash`) is the key Round 3 anti-drift pin: if BUILD silently regressed to the Round 2 algorithm, this test would fail loudly. Test #2 + test #3 together pin the algorithm to "HMAC-SHA256, keyed with AUTH_SECRET, applied to the cookie's token half" and to no other primitive.

**Playwright e2e test (Round 2 wording, kept) — `packages/dashboard/tests/e2e/overrides-csrf.spec.ts`**:

```typescript
test.each(['close-pair', 'close-all', 'edit-position'])('AC-016-X-b: %s without CSRF returns 403', async (route) => {
  const session = await loginPasskey(page);

  const resp = await page.request.post(`/api/overrides/${route}`, {
    data: { pair: 'EUR/USD', /* no csrf */ },
    headers: { cookie: session.cookieHeader },
    // intentionally no x-csrf-token header
  });
  expect(resp.status()).toBe(403);

  // No MT5 mock call
  expect(mt5Mock.calls).toHaveLength(0);
  // No audit row inserted
  const rows = await db.select().from(override_actions);
  expect(rows).toHaveLength(0);
});

test.each(['close-pair', 'close-all', 'edit-position'])('AC-016-X-b: %s with CSRF returns 200', async (route) => {
  const session = await loginPasskey(page);
  // Fetch from OUR /api/csrf, not Auth.js's /api/auth/csrf.
  const csrfResp = await page.request.get('/api/csrf', { headers: { cookie: session.cookieHeader } });
  const { csrfToken } = await csrfResp.json();
  // Cookie was set on csrfResp; merge into the next request's cookie jar.
  const cookieHeader = mergeCookies(session.cookieHeader, csrfResp.headers()['set-cookie']);

  const resp = await page.request.post(`/api/overrides/${route}`, {
    data: { pair: 'EUR/USD', csrf: csrfToken, /* action params */ },
    headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
  });
  expect(resp.status()).toBe(200);
});
```

Pause/resume/replan POST routes also gain CSRF validation (same library, same pattern). The negative-only test (without CSRF) is replicated for those routes too — 6 negative + 6 positive cases total across all six override POST routes.

### Why this approach passes the Evaluator's blocking concern

The Evaluator's blocking finding was: "if the contract specifies `createHash('sha256')` and the Generator commits `createHmac('sha256')` instead, that's a silent scope drift". Round 3 closes that gap THREE ways:
1. The proposal text now explicitly specifies HMAC + `timingSafeEqual` + `__Host-` prefix.
2. The unit-test fixture (test #1 above) computes the known-good signature with HMAC-SHA256 in the test file itself; if BUILD changes the algorithm, this test fails at unit-test time, BEFORE any Playwright cycle.
3. Test #2 explicitly asserts the OLD broken algorithm is REJECTED — so a regression to the Round 2 form can't slip through.

Token-rotation Risk Flag #10 (Round 2) is updated below: because we now own the CSRF cookie issuance, rotation only happens when our own `/api/csrf` endpoint is re-fetched by the form, which is on every form-mount, not on Auth.js session refresh — so the rotation-induced 403 risk shrinks to "user opens form, lets it sit for >12h, then submits", which is a reasonable boundary.

---

## Healthcheck signal source (NEW per R5) — `last_message_handled_at` from Postgres

**Driver**: AC-005-1 requires a defined source for `last_message_handled_at`. Round 2 picks Postgres `MAX(received_at) FROM telegram_interactions` per Evaluator's recommendation.

### Why Postgres-based (option a in review)

- Single source of truth (the audit log already records every received TG message).
- Survives Channels-session restarts (a file-based heartbeat would zero out at restart).
- Works even if the Channels session is deadlocked but the wrapper script is still inserting `telegram_interactions` rows for "received but not yet handled" cases — actually that would be a false positive; see "Refinement" below.
- The healthcheck-handler script (Bun, behind nginx bearer proxy) calls `SELECT MAX(received_at) FROM telegram_interactions WHERE tenant_id=$1` directly.

### Refinement: distinguish "received" from "handled"

`telegram_interactions` already has `received_at` (when the wrapper inserted the row) AND `replied_at` (when the Channels session finished replying). The healthcheck signal is `MAX(replied_at)` — that's "session has handled a message", not "session has received one".

```typescript
// packages/channels/scripts/healthcheck-handler.ts
const result = await pgClient.query(
  `SELECT MAX(replied_at) AS last_handled FROM telegram_interactions WHERE tenant_id = $1`,
  [tenantId],
);
const lastHandledAt = result.rows[0]?.last_handled ?? null;

// "Handled within last 10 min" = healthy from a message-flow perspective.
// "No messages at all" = test the fallback signal: synthetic ping cron writes a
//   row with command_parsed='SYNTHETIC_PING' every 30 min via Vercel cron.
const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
const messageHealthy = lastHandledAt && new Date(lastHandledAt) > tenMinAgo;

// Compose final response
return Response.json({
  healthy: messageHealthy && systemdHealthy,
  uptime_sec: ...,
  last_message_handled_at: lastHandledAt?.toISOString() ?? null,
  reason: messageHealthy ? null : 'no recent message',
});
```

The 30-min synthetic-ping cron (option (c) from review) is added as a fallback so quiet periods don't spuriously trip "unhealthy". Cron path: `/api/cron/synthetic-ping` → POSTs a TG message via Bot API to a special debug-channel that the operator's TG account is muted on; Channels session handles it normally → row in `telegram_interactions` with `command_parsed='SYNTHETIC_PING'`. The 10-min window covers the 5-min Vercel-cron cadence + slack.

#### Round 3 clarification — synthetic-ping rows do NOT artificially inflate `MAX(replied_at)`

**The concern** (raised by Evaluator R5-followup): if the synthetic-ping cron writes its own `telegram_interactions` row, would a dead Channels session falsely report healthy because the cron keeps inserting "ping" rows?

**The answer — no, by construction.** The synthetic-ping flow uses the SAME wrapper-script path as a real operator message:

1. Vercel cron `/api/cron/synthetic-ping` POSTs a real Telegram message to the debug-channel via the Bot API. **No DB write happens at this step.**
2. The Channels session's wrapper script (running on the VPS, behind systemd) receives the Telegram update via long-polling.
3. The wrapper script inserts a `telegram_interactions` row with `received_at = NOW()`, `replied_at = NULL`, `command_parsed = 'SYNTHETIC_PING'`. **`replied_at` is still NULL at this point.**
4. The wrapper hands the message to the Channels-session subagent for handling.
5. ONLY when the subagent finishes its reply does the wrapper UPDATE the row to set `replied_at = NOW()`.

If the Channels session is dead (process killed, deadlocked, OOM):
- Step 1 still happens (Vercel cron is independent of the VPS).
- Step 2 still happens IF the wrapper script is alive; otherwise step 2 also fails.
- Step 3: if the wrapper is alive, the row is inserted with `replied_at = NULL`. If the wrapper is dead, no row at all.
- Step 4 fails (subagent dead).
- Step 5 NEVER happens — `replied_at` stays NULL forever for that ping.

`MAX(replied_at)` ignores NULL by definition, so the synthetic-ping row contributes nothing until it is actually handled. A dead session therefore does NOT get false-healthy from the cron firing — `MAX(replied_at)` correctly reports "the last time a real message was successfully handled", which is what the healthcheck signal is supposed to measure. The synthetic-ping is a **liveness probe**: if the session IS alive, ping rows DO get `replied_at` set, and quiet periods (no real operator messages for hours) don't spuriously trip "unhealthy". If the session is dead, no `replied_at` update means the healthcheck correctly reports unhealthy after the 10-min window.

**The one edge case worth naming**: the Channels-session wrapper itself has no concept of "synthetic vs real" when handling the message — it just replies. So if the operator wants to see synthetic-ping replies in their TG history, they will (subject to their per-channel mute setting). This is intentional — the synthetic ping is fundamentally indistinguishable from a real `/status` poll from the session's perspective; that's WHY it works as a liveness probe.

No code change for this clarification — Round 2's implementation was correct; only the doc loop had to close. The two existing healthcheck-signal tests (recent reply → healthy; 11-min gap → unhealthy) remain sufficient. Adding a third Round 3 test would be over-engineering; the property "MAX(replied_at) ignores NULL" is a Postgres invariant, not something the implementation can break.

### AC-005-1 test (vitest, in `packages/channels/tests/healthcheck-signal.test.ts`)

```typescript
test('AC-005-1: last_message_handled_at = MAX(replied_at) from telegram_interactions', async () => {
  await tenantDb.insert(telegram_interactions).values({
    received_at: new Date('2026-05-02T12:00:00Z'),
    replied_at:  new Date('2026-05-02T12:00:03Z'),
    command_parsed: '/status',
    /* ... */
  });

  const resp = await fetch(`http://localhost:8081/health?bearer=${HEALTH_BEARER_TOKEN}`);
  const body = await resp.json();
  expect(body.last_message_handled_at).toBe('2026-05-02T12:00:03.000Z');
  expect(body.healthy).toBe(true);
});

test('AC-005-1: 11-minute gap → healthy=false with reason "no recent message"', async () => {
  await tenantDb.insert(telegram_interactions).values({
    received_at: new Date(Date.now() - 11 * 60 * 1000),
    replied_at:  new Date(Date.now() - 11 * 60 * 1000 + 3000),
    command_parsed: '/status',
    /* ... */
  });

  const resp = await fetch(`http://localhost:8081/health?bearer=${HEALTH_BEARER_TOKEN}`);
  const body = await resp.json();
  expect(body.healthy).toBe(false);
  expect(body.reason).toMatch(/no recent message/);
});
```

This satisfies R5 with a deterministic, audit-trail-aligned signal.

---

## Data Model Proposal (Drizzle schema, snake_case per constitution §16)

One file per table under `packages/db/src/schema/`. Each table includes `tenant_id INTEGER NOT NULL DEFAULT 1` per constitution §4.

| Entity | Fields (selected; full Drizzle types below) | Serves FR | Indexes |
|--------|---------------------------------------------|-----------|---------|
| `tenants` | `id` (serial PK), `name` (text), `allowed_telegram_user_ids` (jsonb of int[]), `created_at` (timestamptz) | FR-004 AC-004-6, foundation | PK |
| `users` | `id` (serial PK), `tenant_id`, `email` (text unique), `created_at`. Also Auth.js DrizzleAdapter tables: `accounts`, `sessions`, `verification_tokens`, `authenticators` (passkeys) | FR-006, NFR-009 | unique(email), Auth.js defaults |
| `pair_configs` | `tenant_id`, `pair_code` (text), `mt5_symbol` (text), `sessions_json` (jsonb of `["EUR","NY"]`), `active_bool` (bool), `created_at`. PK = (`tenant_id`, `pair_code`). | FR-011, FR-012 | PK |
| `pair_schedules` | `id` (serial PK), `tenant_id`, `date` (date), `pair_code`, `session_name` (text), `start_time_gmt` (timestamptz nullable — empty Planner output → NULL), `end_time_gmt` (timestamptz nullable), `planner_run_id` (FK → routine_runs), `scheduled_one_off_id` (text — Anthropic's one-off ID), `status` (enum: `scheduled` `cancelled` `fired` `skipped_no_window`), `created_at` | FR-002 AC-002-2g, FR-018 AC-018-2 + AC-018-2-b | (`tenant_id`, `date`); (`tenant_id`, `pair_code`, `date`) |
| `routine_runs` | `id` (serial PK), `tenant_id`, `routine_name` (enum: `planner`, `executor`, `spike_*`, `cap_status`, `replan_orchestrator`), `pair` (text nullable for Planner), `session_window` (text nullable), `started_at` (timestamptz), `ended_at` (timestamptz nullable), `claude_code_session_id` (text), `claude_code_session_url` (text), `input_text` (text), `output_json` (jsonb nullable), `tool_calls_count` (int), `status` (enum: `running` `completed` `failed` `degraded`), `failure_reason` (text nullable), `degraded` (bool), `routine_fire_kind` (enum: `recurring`, `scheduled_one_off`, `fire_api`, `claude_run_bash`) | FR-007 AC-007-1, FR-002 AC-002-2i, FR-003 AC-003-4 | (`tenant_id`, `started_at` DESC); (`tenant_id`, `routine_name`, `started_at` DESC) |
| `executor_reports` | `id` (serial PK), `tenant_id`, `routine_run_id` (FK), `pair` (text), `session` (text), `report_md_blob_url` (text), `summary_md` (text — degraded fallback per FR-015 EC-015-1), `action_taken` (text), `created_at` | FR-015 AC-015-2 | (`tenant_id`, `created_at` DESC) |
| `orders` | `id` (serial PK), `tenant_id`, `mt5_ticket` (bigint), `pair` (text), `mt5_symbol` (text), `type` (enum: `market_buy` `market_sell` `limit_buy` `limit_sell` `stop_buy` `stop_sell` `no_trade` `rejected_by_risk`), `volume` (numeric), `price` (numeric), `sl` (numeric), `tp` (numeric), `opened_at` (timestamptz), `closed_at` (timestamptz nullable), `source_table` (text), `source_id` (bigint), `status` (enum: `open` `closed` `cancelled` `rejected`), `pnl` (numeric nullable) | FR-007 AC-007-4, FR-015, FR-016 | (`tenant_id`, `opened_at` DESC); (`tenant_id`, `mt5_ticket`) |
| `override_actions` | `id` (serial PK), `tenant_id`, `at` (timestamptz), `operator_user_id` (FK → users), `action_type` (enum: `close_pair` `close_all` `edit_sl_tp` `pause` `resume` `replan`), `target_pair` (text nullable), `target_ticket` (bigint nullable), `params_json` (jsonb), `before_state_json` (jsonb nullable — captured from MT5 read per R4 step 3), `after_state_json` (jsonb nullable), `success` (bool nullable — null = in-flight, true/false after settle), `error_message` (text nullable) | FR-007 AC-007-3 + AC-007-3-b, FR-016, FR-017, FR-018 | (`tenant_id`, `at` DESC) |
| `telegram_interactions` | `id` (serial PK), `tenant_id`, `received_at` (timestamptz), `replied_at` (timestamptz nullable), `from_user_id` (bigint), `message_text` (text), `command_parsed` (text — slash command name OR `FREE_TEXT` OR `REJECTED_NOT_ALLOWED` OR `SYNTHETIC_PING`), `tool_calls_made_json` (jsonb nullable), `reply_text` (text nullable), `claude_code_session_id` (text nullable) | FR-007 AC-007-2, FR-004 AC-004-6, FR-005 AC-005-1 | (`tenant_id`, `received_at` DESC); (`tenant_id`, `from_user_id`, `received_at` DESC); (`tenant_id`, `replied_at` DESC) |
| `channels_health` | `id` (serial PK), `tenant_id`, `checked_at` (timestamptz), `healthy_bool` (bool), `latency_ms` (int nullable), `error` (text nullable), `restart_reason` (enum nullable: `scheduled_idle` `manual` `crash`), `mute_alarm_until` (timestamptz nullable — the 90s mute marker per ADR-009) | FR-005 AC-005-1, AC-005-2, ADR-009 | (`tenant_id`, `checked_at` DESC) |
| `agent_state` | `tenant_id` (PK), `paused_bool` (bool default false), `paused_at` (timestamptz nullable), `paused_by` (FK → users nullable) | FR-017 AC-017-1 | PK |
| `cap_usage_local` | `id` (serial PK), `tenant_id`, `at` (timestamptz), `cap_kind` (enum: `planner_recurring` `executor_one_off_cap_counted` `executor_one_off_cap_exempt` `replan_fire` `cap_status_cron`), `routine_runs_id` (FK nullable) | FR-021 AC-021-1 (per ADR-008) | (`tenant_id`, `at` DESC) |
| `cap_usage` | `id` (serial PK), `tenant_id`, `date` (date), `daily_used` (int), `daily_limit` (int default 15), `weekly_used` (int), `weekly_limit` (int), `source` (enum: `local_counter` `anthropic_api`), `recorded_at` (timestamptz) | FR-021 AC-021-1 (rollup) | (`tenant_id`, `date`); UNIQUE (`tenant_id`, `date`, `source`) |

**Round 2 schema deltas vs Round 1:**
- `override_actions.success` is now nullable (was non-null) — needed because R4's flow uses `success=null` as the in-flight marker between steps 4 and 7.
- `override_actions.before_state_json` and `after_state_json` are nullable — needed because step 3 (MT5 read) can fail before any state is captured.
- `telegram_interactions.command_parsed` enum gains `SYNTHETIC_PING` — for R5 fallback signal.
- `telegram_interactions` gains an index on `(tenant_id, replied_at DESC)` — for R5's `MAX(replied_at)` healthcheck query.
- `routine_runs.routine_name` enum gains `replan_orchestrator` — for R3's audit-wrapper around the dashboard's replan handler.

**Key invariants enforced in `packages/db/src/`** (unchanged from Round 1):

1. **Tenant-scoped client factory** (`client.ts`):
   ```ts
   export function getTenantDb(tenantId: number) {
     return drizzle(pool, { schema }).$with({ tenantId });
   }
   ```

2. **Tenant-id linter** (`lint/tenant-id-lint.ts`):
   - AST-walks all `.ts` files in `packages/{routines,channels,dashboard}/`
   - Flags any `db.select/insert/update/delete` outside `getTenantDb()`
   - PER Q3 ANSWER: ALSO maintains `packages/db/lint/raw-sql-allowlist.txt` listing the ≤3 places where `db.execute(sql\`...\`)` is legitimately used (migrations, orphan-detect cron, spike diagnostics). Linter fails on `db.execute` outside the allowlist. Each entry has a comment justifying raw SQL + showing tenant_id is filtered.

3. **`audit.ts`** — implements audit-or-abort (`withAuditOrAbort` wrapper used by every Planner/Executor/spike entry-point and the new `replan_orchestrator`).

4. **`time.ts`** — pure GMT/UTC helpers; DST-day tests Mar 30 + Oct 26 2026.

---

## API Surface Proposal (Next.js dashboard route handlers)

| Endpoint | Method | Purpose | Auth | CSRF | Serves FR |
|----------|--------|---------|------|------|-----------|
| `/api/auth/[...nextauth]` | GET/POST | Auth.js handlers | n/a | built-in | FR-006, NFR-009 |
| `/api/overview` | GET | balance + equity + positions | session | n/a (GET) | FR-006 AC-006-3 |
| `/api/schedule` | GET | today's `pair_schedules` rows + countdowns | session | n/a (GET) | FR-006, FR-018 |
| `/api/pairs` | GET | active pair list (read-only v1) | session | n/a (GET) | FR-011 AC-011-3 |
| `/api/positions` | GET | live MT5 positions via tunnel | session | n/a (GET) | FR-006 |
| `/api/overrides/close-pair` | POST | body: `{pair, csrf}` | session + re-verify | **YES (R6)** | FR-016 AC-016-1, AC-016-1-b, NFR-007 |
| `/api/overrides/close-all` | POST | body: `{confirmation: "CLOSE-ALL", csrf}` | session + re-verify + body confirmation | **YES (R6)** | FR-016 AC-016-2, AC-016-2-b |
| `/api/overrides/edit-position` | POST | body: `{ticket, sl, tp, csrf}` | session + re-verify | **YES (R6)** | FR-016 AC-016-3, AC-016-3-b |
| `/api/overrides/pause` | POST | body: `{csrf}` — sets `agent_state.paused_bool=true`, cancels not-yet-fired one-offs | session + re-verify | **YES (R6)** | FR-017 AC-017-3 |
| `/api/overrides/resume` | POST | body: `{csrf}` | session + re-verify | **YES (R6)** | FR-017 |
| `/api/overrides/replan` | POST | body: `{confirm_low_cap?, csrf}` — fires Planner via `/fire` | session + re-verify + cap-confirm if ≤ 2 slots | **YES (R6)** | FR-018 AC-018-1, AC-006-5 |
| `/api/reports/[id]` | GET | mints signed Vercel Blob URL (1h expiry) | session | n/a (GET) | FR-015 AC-015-1 |
| `/api/archive-fetch` | GET | query: `?date=YYYY-MM-DD` | session | n/a (GET) | ADR-006 |
| `/api/cron/channels-health` | GET | every 5 min | CRON_SECRET | n/a (cron) | FR-005 AC-005-2 |
| `/api/cron/audit-archive` | GET | daily 03:30 GMT | CRON_SECRET | n/a (cron) | ADR-006 |
| `/api/cron/orphan-detect` | GET | daily | CRON_SECRET | n/a (cron) | NFR-004 |
| `/api/cron/cap-rollup` | GET | daily 12:00 GMT | CRON_SECRET | n/a (cron) | FR-021 AC-021-1 |
| `/api/cron/usage-reconcile` | GET | conditional, daily | CRON_SECRET | n/a (cron) | FR-021 (per ADR-008) |
| `/api/cron/synthetic-ping` | GET | every 30 min — sends a synthetic TG ping to debug channel for R5 fallback signal | CRON_SECRET | n/a (cron) | FR-005 AC-005-1 fallback |

**Cron schedule (vercel.json crons[])**:
```jsonc
{
  "crons": [
    {"path": "/api/cron/channels-health",   "schedule": "*/5 * * * *"},
    {"path": "/api/cron/orphan-detect",     "schedule": "15 4 * * *"},
    {"path": "/api/cron/audit-archive",     "schedule": "30 3 * * *"},
    {"path": "/api/cron/cap-rollup",        "schedule": "0 12 * * *"},
    {"path": "/api/cron/synthetic-ping",    "schedule": "*/30 * * * *"}
    // /api/cron/usage-reconcile entry added IF FR-001 spike PASSes /v1/usage exposure check
  ]
}
```

---

## FR → Implementation Mapping

| FR | Components touched | Files (planned) | Test strategy |
|----|---|---|---|
| FR-001 | routines/spike/* + db/audit | `packages/routines/src/spike/ac-001-{1,2,3,4}.ts`, `docs/spike-report-fr-001.md`, `.harness/data/spike-fr-001-outcomes.json` (NEW — feeds Tier 2 prompt-preserve test) | Each spike writes routine_runs row + appends to spike-report; vitest math-fidelity in CI; Spike 3 ALSO probes deployed-prompt READ endpoint (R1 driver) |
| FR-002 | routines/planner.ts + db | `packages/routines/src/planner.ts`, `packages/routines/src/news.ts`, `packages/routines/src/schedule-fire.ts`, `packages/routines/src/prompt-loader.ts` | vitest with mocked deps + `replan-cleanup.test.ts` for EC-002-3 ordering (R3 driver) |
| FR-003 | routines/executor.ts + db + telegram-bot | `packages/routines/src/executor.ts`, `packages/routines/src/mt5.ts`, `packages/routines/src/telegram-bot.ts` | vitest XAU/USD hard test + pre-fire stale-check (R3 driver — feeds AC-018-2-b) |
| FR-004 | channels/agents + channels/src/* + infra/vps | as proposed; subagent yaml's Write scope NARROWED per R2 (work/ only, not scripts/agents/) | YAML schema validation + tools-list assertion includes "Write does NOT include scripts/ or agents/" check |
| FR-005 | channels/scripts/healthcheck-handler + dashboard/api/cron/channels-health + synthetic-ping cron + infra/vps | `packages/channels/scripts/healthcheck-handler.ts` queries `MAX(replied_at)` per R5; `apps/dashboard/app/api/cron/synthetic-ping/route.ts` NEW | `healthcheck-signal.test.ts` per R5 + manual smoke |
| FR-006 | dashboard/* | as proposed + `lib/csrf.ts` + `components/csrf-form.tsx` per R6 | Playwright NFR-009; CSRF 403 on missing token (R6 driver) |
| FR-007 | db/audit + every agent + dashboard/api | as proposed + override-handler.ts implementing R4's 7-step flow | vitest for each step boundary + AC-007-3-b before-state assertion (R4 driver) |
| FR-008 | db/schema/* + db/migrations | as proposed; `override_actions.success/before/after` NULLABLE deltas per R4 | post-migration column nullability test |
| FR-009 | infra/vps/setup.sh + infra/vps/nginx + systemd | as proposed | bash test in CI |
| FR-010 | .lefthook.yml + Makefile + .gitleaks.toml + ci | as proposed | NEGATIVE test: write `ANTHROPIC_API_KEY=fake` → lefthook rejects |
| FR-011 | db/queries/pairs.ts + dashboard | as proposed | vitest + Playwright read-only |
| FR-012 | db/migrations/0002_seed_pairs | as proposed | post-seed row count + GBP/JPY absent |
| FR-013 | CONDITIONAL — routines/compute-python-mcp/ if needed | If built: VS impl. If skipped: skip-marker test per Q4 answer | per Q4 — skip-marker vitest in `fr-013-skip-marker.test.ts` |
| FR-014 | routines/news.ts | snapshot vs frozen golden | as proposed |
| FR-015 | routines/executor + dashboard/api/reports/[id] | Vercel Blob upload + signed-URL minter | vitest + Playwright |
| FR-016 | dashboard/api/overrides/* + override-handler.ts (R4) + csrf.ts (R6) + telegram-bot | per R4 7-step flow; per R6 CSRF gate | NFR-007 fault inject at 4 boundaries (R4) + AC-007-3-b before-state (R4) + AC-016-{1,2,3}-b CSRF 403 (R6) |
| FR-017 | db/schema/agent-state + dashboard/api/overrides/{pause,resume} + planner/executor pre-fire | as proposed + CSRF gate per R6 | vitest pause/resume |
| FR-018 | dashboard/api/overrides/replan + channels/src/commands/replan + replan-cleanup.test.ts | per R3 cleanup-flow ordering + AC-018-2-b race window check; CSRF gate per R6 | replan-cleanup.test.ts vitest cases (R3) |
| FR-019 | routines/telegram-bot + executor's last step | direct Bot API; retry-with-backoff on rate-limit | vitest format match + retry path |
| FR-020 | rewrite .harness/init.sh + infra/vps/setup.sh | bash CI on clean Linux VM + LOUD failure mode | bash unit test |
| FR-021 | dashboard/api/cron/cap-rollup + Overview cap progress bar + Telegram alert | as proposed | vitest cap rollup + 12/14/15 alert tiers |

---

## AC → Test Approach

| AC | How I'll verify it in BUILD mode |
|----|----------------------------------|
| AC-001-1 | Live spike against Anthropic console; spike-report-fr-001.md committed |
| AC-001-2 | Live spike + vitest math-fidelity comparison vs Python reference |
| AC-001-3 | Live spike + CI smoke test on every commit (.github/workflows/beta-header.yml) — also probes deployed-prompt READ endpoint (R1) |
| AC-001-4 | 24h soak with synthetic load + /usage screenshots in spike report |
| **AC-002-1** | **(R1) Tier 1 — `prompt-preserve.test.ts` reads `.harness/spec/preserve/planner-systemprompt.md` and byte-compares against `packages/routines/src/preserve-mirror/planner-systemprompt.md` (the file shipped to Anthropic). PASS = byte-identical, no smart-quote/CRLF/trailing-ws normalization. Always runs in CI.** |
| **AC-002-1-b (NEW per R1)** | **Tier 2 — `prompt-preserve-deployed.test.ts` reads `.harness/data/spike-fr-001-outcomes.json`; if `deployed_prompt_endpoint != null`, fetches the live deployed Planner system prompt via the recorded URL and byte-compares against the source file. If endpoint unavailable, test SKIPS and `implementation-report.md` flags constitution §2 verification as file-side only + manual screenshot+diff in operator's pre-deploy checklist (`docs/operator-pre-deploy-checklist.md`).** |
| AC-002-2 | vitest: full Planner module unit test with mocked deps; integration on local Postgres; assert all 9 sub-actions (a-i) execute in order |
| AC-002-2(h) (re-plan cleanup) | (R3) `replan-cleanup.test.ts` case 1: 14 pre-existing pair_schedules → handleReplan → 14 marked status='cancelled' + N new status='scheduled' rows + audit row written |
| AC-002-3 | vitest: empty start_time/end_time → no executor scheduled |
| AC-002-4 | vitest: unparseable LLM → failure audit row + emergency Telegram |
| **AC-003-1** | **(R1) Tier 1 — same as AC-002-1 for `spartan-systemprompt.md`** |
| **AC-003-1-b (NEW per R1)** | **Tier 2 — same as AC-002-1-b for Spartan/Executor** |
| AC-003-2 | vitest: input format string equality with template |
| AC-003-3 | vitest: synthetic XAU/USD run + assert `symbol_name === "XAUUSD"` exact equality |
| AC-003-4 | vitest: Blob path format + executor_reports + orders + routine_runs end-row |
| AC-003-5 | vitest: telegram-bot called with format string |
| AC-004-1 | `systemd-analyze verify`; manual on staging VPS; ALSO assert `User=caishen` + `WorkingDirectory` ownership (Risk #9 endorsed) |
| AC-004-2 | bash idempotency test |
| **AC-004-3** | **YAML schema validation + tools-list assertion (no `Bash(*)`); ALSO (R2) assert Write allowlist EXCLUDES `scripts/` and `agents/` directories — only `work/**` and explicit data files allowed** |
| AC-004-4 | vitest per command + integration |
| AC-004-5 | Manual on staging + production rolling NFR view |
| AC-004-6 | vitest: off-allowlist user → polite refusal + audit + zero tool calls |
| **AC-005-1** | **(R5) bash + curl: bearer pass/fail/503-when-systemd-failed; vitest `healthcheck-signal.test.ts` asserts `last_message_handled_at = MAX(replied_at) FROM telegram_interactions`; 11-min gap → healthy=false reason='no recent message'; synthetic-ping cron writes a row every 30 min as fallback** |
| AC-005-2 | vitest: 3 unhealthy streak → direct-bot-API alert (out-of-band) |
| AC-005-3 | vitest: insert unhealthy streak, first message after restart contains "down between HH:MM and HH:MM" |
| AC-006-1 | Playwright NFR-009 enumeration + passkey register/login |
| AC-006-2 | Playwright per-screen happy path |
| AC-006-3 | Playwright 30s/60s stale-banner triggers |
| AC-006-4 | Playwright NFR-007 atomicity (covered under AC-016-* + AC-007-3-b) |
| AC-006-5 | Playwright force-replan happy path |
| AC-007-1 | vitest: routine.start without audit row → throws; orphan-detect returns 0 |
| AC-007-2 | vitest: each command path writes correct command_parsed |
| AC-007-3 | Playwright + DB row assertion |
| **AC-007-3-b (NEW per R4)** | **Playwright `overrides-atomicity.spec.ts`: mock MT5 to return state X on read, success on write → assert audit's `before_state_json === X`. Variant: mock MT5 to fail write → assert before captured, success=false, no Telegram, after=last-known.** |
| AC-007-4 | vitest: source_table+source_id back-reference |
| AC-007-5 | Playwright: click "View Claude session" → href === routine_runs.claude_code_session_url |
| AC-008-1 | vitest: post-migration table list + per-table column existence + (R4) override_actions.success/before/after nullability |
| AC-008-2 | vitest: tenant-id-lint scans repo, expects 0 violations + raw-SQL-allowlist file exists with ≤3 entries |
| AC-008-3 | vitest: post-migration index existence + (R5) telegram_interactions.replied_at index |
| AC-009-1..4 | curl + bash + init.sh smoke |
| AC-010-1 | Negative test: write `ANTHROPIC_API_KEY=fake`, lefthook rejects |
| AC-010-2..5 | as proposed |
| AC-011-1..3 | vitest + Playwright (read-only) |
| AC-012-1..3 | vitest: post-seed row count + pair_codes + GBP/JPY absent |
| AC-013-1..2 | If built: vitest + tool-call test; If skipped: `fr-013-skip-marker.test.ts` per Q4 answer |
| AC-014-1..3 | vitest snapshot vs frozen golden + return-shape assertion |
| AC-015-1..2 | vitest mock Blob + Playwright open-in-tab + markdown render |
| **AC-016-1** | **(R4) Playwright: click close-pair → CSRF gate passes → MT5 read → audit insert (success=null) → MT5 write → audit update (success=true) → Telegram POST. Mocked MT5 at all four boundaries.** |
| **AC-016-1-b (NEW per R6)** | **Playwright `overrides-csrf.spec.ts`: POST `/api/overrides/close-pair` without CSRF token → 403, no MT5 mock call, no audit row inserted. With token → 200.** |
| **AC-016-2** | **(R4 + R6) Playwright: click close-all → modal requires "CLOSE-ALL" typed → CSRF token bundled → confirm → loops** |
| **AC-016-2-b (NEW per R6)** | **Playwright: POST `/api/overrides/close-all` without CSRF → 403** |
| **AC-016-3** | **(R4 + R6) Playwright: edit form valid input → CSRF gate passes → MT5 modify mocked → audit row + before/after diff visible** |
| **AC-016-3-b (NEW per R6)** | **Playwright: POST `/api/overrides/edit-position` without CSRF → 403** |
| AC-016-4 | vitest: each /closepair, /closeall, /edit command script writes audit row with same schema |
| AC-017-1..4 | vitest: agent_state singleton + paused-skip + pre-fire check ordering |
| AC-018-1 | (R6) Playwright: click force-replan → CSRF gate → cap check → /fire mocked → audit row |
| **AC-018-2** | **(R3) `replan-cleanup.test.ts` case 1: post-replan, today's pair_schedules marked `cancelled`, new ones written with status='scheduled', stale one-off cancellation surfaced via DB-side mark; AC-018-3 Telegram broadcast via `replan-broadcast.test.ts`** |
| **AC-018-2-b (NEW per R3)** | **`replan-cleanup.test.ts` case 2 (race window): pre-state row status='cancelled'; simulate Executor pre-fire check; assert zero MT5 mock calls + `routine_runs` end-row with `output_json.reason === "stale-plan-noop"`. Case 3: stale `scheduled_one_off_id` mismatch → same noop.** |
| AC-018-3 | vitest: post-replan, telegram-bot called with new schedule formatted message |
| AC-019-1..3 | vitest: format match + error-format match + retry-with-backoff |
| AC-020-1..3 | bash CI: clean Linux VM + LOUD failure mode |
| AC-021-1..4 | vitest: cap_usage_local rollup + 12/14/15 alert tiers + tooltip variant |

ECs covered analogously — each EC has at least one vitest case.

---

## NFR Approach (unchanged from Round 1 except where noted)

| NFR | Approach |
|-----|---------|
| NFR-001 | M0 spike measures across staging runs; 5×1-min stub test in Evaluator harness |
| NFR-002 | `telegram_interactions.received_at`/`replied_at` measurement infra; 24h staging soak post-FR-004; production rolling-NFR view (Q5 endorsed) |
| NFR-003 | Playwright synthetic in CI |
| NFR-004 | Daily orphan-detect cron query returns 0; ALSO catches R4 step (d) "audit UPDATE failed" edge — orphan in `success=null` state surfaces via this cron |
| NFR-005 | `make audit-no-api-key` + gitleaks + lefthook + CI |
| NFR-006 | FR-001 AC-001-4 spike + ongoing weekly cron (post-FR-021) |
| **NFR-007** | **(R4) Playwright fault injection at 4 distinct boundaries: MT5 read fail, audit insert fail, MT5 write fail, audit update fail. Each asserts the exact recovery state per the 7-step flow.** |
| NFR-008 | vitest DST-day test |
| NFR-009 | Playwright route-enumeration test; 401/redirect on every route un-authed |
| NFR-010 | Constitution lint runs in CI |

---

## Build Order (technical dependency order — REPLACES contract's "Suggested Build Order")

Same milestone groupings as contract; minor reorderings within M1 for technical deps. Round 2 changes: CSRF helper (`lib/csrf.ts`) added in M3 step 17 BEFORE first override route handler in M4; replan-cleanup ordering encoded into FR-002 step 13 before FR-018 step 22.

**M0 — Architecture spike**
1. Workspace scaffolding: `package.json` workspaces, `bun install`, `tsconfig.base.json`, `biome.json`, `.lefthook.yml`, `Makefile` skeleton.
2. **FR-010** (per Q1 answer — pulled forward from M1 #2 to M0 #2). Pre-commit + `make audit-no-api-key` + gitleaks + CI lint must exist BEFORE any spike code commits.
3. **FR-001** spikes 1-4 in sequence over 24-48h elapsed time. Spike 3 ALSO records `deployed_prompt_endpoint` outcome (R1 driver). Spike report committed.
4. Mid-spike: ADR updates if any spike PARTIAL/FAIL.

**M1 — Foundation: data + secrets + tunnel**
5. **FR-008** Postgres schema + migrations + tenant-scoped client (Round 2 deltas: `override_actions` nullability, `command_parsed` enum gains SYNTHETIC_PING, `routine_name` enum gains `replan_orchestrator`, `telegram_interactions(tenant_id, replied_at)` index).
6. **FR-008** tenant-id-lint.ts + raw-SQL-allowlist file (Q3 answer).
7. **FR-012** seed migration.
8. **FR-011** pair-config query helpers.
9. **FR-009** Tailscale Funnel + nginx bearer-proxy + systemd units.
10. **FR-020** init.sh full rewrite.
11. **FR-014** news-fetch port.
12. **FR-007** audit-or-abort module + tests + override-handler.ts skeleton implementing R4's 7-step flow (handler used in M4).

**M2 — Trading core**
13. **FR-002** Planner routine TS body + prompt-loader + schedule-fire selector + (R3) Executor pre-fire stale-check helper used by FR-003.
14. **FR-003** Executor routine TS body + XAU/USD hard test + report-upload + (R3) pre-fire stale-check wired in.
15. **FR-013** CONDITIONAL.
16. **FR-019** telegram-bot direct API.

**M3 — Dashboard read-only**
17. **FR-006** scaffold (Auth.js + Drizzle adapter + middleware + 5 screens read-only) + (R6) `lib/csrf.ts` + `components/csrf-form.tsx`.
18. **FR-006** AC-006-2 5 core screens.
19. **FR-015** signed-URL minting + History view.

**M4 — Dashboard overrides + Telegram polish**
20. **FR-016** override action handlers (R4 7-step flow) + atomicity tests + (R6) CSRF tests.
21. **FR-017** pause/resume.
22. **FR-018** force re-plan (R3 cleanup-flow ordering + AC-018-2-b race window).
23. **FR-004** Channels-session subagent + scripts + systemd unit + setup.sh additions; subagent yaml uses NARROWED Write allowlist (R2).
24. **FR-005** healthcheck endpoint querying MAX(replied_at) (R5) + Vercel cron + synthetic-ping cron + out-of-band alert + recovery hint + restart-on-idle systemd timer.

**M5 — Hardening + observability**
25. **FR-021** cap-monitoring cron + dashboard progress bar + Telegram alerts.

**Final pass**
26. Generator invokes `impeccable` skill on the deployed Vercel preview.

---

## Risk Flags (things I'm uncertain about — Round 2 status)

1. **FR-001 spike is partly LIVE** — Round 1 flag, Evaluator accepted. No change.
2. **FR-013 SKIP path** — Mitigated via Q4 answer (`fr-013-skip-marker.test.ts`).
3. **NFR-007 fault-injection at MSW** — Endorsed. R4 specifies the 4 boundaries.
4. **Anthropic Routines API instability for prompt-fetch test** — Mitigated via R1 / two-tier test (Tier 2 conditional on Spike 3 outcome).
5. **`design/dashboard-bundle/` likely missing** — Round 1 flag, accepted with operator escalation path.
6. **FR-011 vs FR-002 ordering** — Round 1 flag, accepted.
7. **`tenant-id-lint.ts` AST-bypassable** — Mitigated via Q3 raw-SQL-allowlist.
8. **Healthcheck-handler bearer separation** — Round 1 flag, accepted.
9. **Channels session running as caishen user** — Round 1 flag, endorsed; AC-004-1 test gains `User=caishen` + ownership assertion.

**Round 2 Risk Flag #10 — REVISED Round 3**: **CSRF token rotation.** Round 2's risk was that Auth.js v5's CSRF token might rotate on session refresh, causing 403 on a long-open form. **Round 3's self-issued HMAC cookie removes that coupling**: our CSRF cookie is set by `GET /api/csrf` (called on form-mount) with `maxAge=12h` and is independent of Auth.js's session lifecycle. Risk now narrows to: "operator opens an override form, lets it sit >12h, then submits → 403". Mitigation: `<CsrfForm>` re-fetches `/api/csrf` once on submit-failure and retries; if the retry's POST also returns 403, the form surfaces "Session may have expired — please refresh" instead of silently looping. Implementation-report will note actual observed rotation frequency.

**NEW Round 2 Risk Flag #11**: **Replan race window: actively-running Executor.** R3 covers the case where a stale ONE-OFF fires post-cancel. It does NOT cover the case where an Executor was ALREADY running at `t0` (the moment re-plan triggers). That executor will complete its own MT5 actions BEFORE the new schedule is in place. Mitigation: this is intentional — interrupting a running Executor mid-trade is more dangerous than letting it finish; the new Planner picks up from the post-Executor state. Flagged for transparency. Treated as DESIGN INTENT, not a bug.

---

## Questions for Evaluator (Round 2 — most are now answered; preserved here for traceability)

All 7 Round 1 questions were answered in `review.md`. Round 2 surfaces no new asks. The mapping below records the answers as committed-to in this proposal.

| Question | Round 1 framing | Round 2 commitment |
|---|---|---|
| Q1 | FR-010 pulled forward to M0 #2? | Endorsed. Build order step 2 = FR-010. |
| Q2 | Byte-identity test mechanism? | Two-tier (R1). Tier 1 always runs (file-side), Tier 2 conditional on Spike 3. |
| Q3 | tenant-id-lint scope? | AST + regex + raw-SQL-allowlist file with ≤3 entries. |
| Q4 | FR-013 SKIP verification? | Skip-marker vitest (`fr-013-skip-marker.test.ts`). |
| Q5 | Channels NFR-002 24h soak? | Staging measurement + production rolling-NFR view; Evaluator verifies infra exists. |
| Q6 | FR-006 design source if bundle missing? | Implementation-report flag + escalation path; Product Depth ≤6 = fail = operator exports bundle, re-iterates. |
| Q7 | Tool allowlist syntax? | Confirmed `Bash(/path)` and `Bash(/path:*)` are correct. R2 narrows the Write scope further. |

---

## If Round 2+: Response to Previous Review

This is Round 3 (the final negotiation round). Round 2 fully resolved 5 of 6 R-asks; review.md surfaced one BLOCKING item (R6 cryptographic primitive bug) + two non-blocking follow-ons (R3-followup transactional-boundary, R5-followup synthetic-ping doc loop). Round 3 closes all three.

### Round 3 — direct response to Round 2 review

| R-ID | Round 2 review's ask | Round 3 response | Sections updated in this proposal (Round 3 deltas) |
|---|---|---|---|
| **R6 (Round 3 — blocking)** | Rewrite `lib/csrf.ts` to use `createHmac('sha256', AUTH_SECRET).update(token)` (HMAC, not concat-hash); use `timingSafeEqual` for constant-time equality; support `__Host-` cookie prefix on production; add a unit test that pins the HMAC algorithm against a known fixture. | Adopted with one substantive deviation: rather than re-verifying Auth.js's own CSRF cookie (which Context7 confirmed is JWE-encrypted in v5 — verifying it from outside the library is brittle, and the cookie was renamed to `authjs.csrf-token`), Round 3 issues OUR OWN HMAC-signed CSRF cookie via `GET /api/csrf`. This decouples our CSRF check from Auth.js library internals. The HMAC primitive, `timingSafeEqual` constant-time comparison, and `__Host-` production prefix all match the Evaluator's outline. The unit test (8 cases) explicitly REJECTS the broken Round 2 concat-hash signature AND the canonical HMAC keyed with a wrong secret, pinning the algorithm in two directions. | "CSRF protection (REVISED per R6 in Round 3) — self-issued HMAC double-submit-cookie" (full rewrite of section); Directory structure: `app/api/csrf/route.ts` added, `lib/csrf.ts` rewritten, `tests/unit/csrf.test.ts` added; Risk Flag #10 revised (rotation risk narrowed because we own the cookie lifecycle now). |
| **R3-followup (Round 3 — non-blocking but worth fixing)** | Split `handleReplan` into two transactions bridged by `success=null` in-flight marker, with the external `/fire` POST OUTSIDE both transactions, so Postgres row locks aren't held across remote-call latency. | Adopted exactly as the Evaluator outlined. Tx A = read beforeSchedule + cancel old rows + insert override_actions with `success=null`. External `/fire` POST happens between txs (no DB tx open). Tx B = settle override_actions to either `success=true` (with `after_state_json.planner_session_id`) or `success=false` (with `error_message`). The existing R4 in-flight marker is the bridge; the existing NFR-004 orphan-detect cron picks up any `success=null` row >5 min old as the recovery surface. New table maps 4 failure points to deterministic states + recovery procedures. Two new tests added to `replan-cleanup.test.ts` (case 5 = `/fire` rejection, case 6 = Tx B failure after `/fire` success). | "Re-plan cleanup flow (NEW per R3) → Transactional ordering inside `/api/overrides/replan` POST handler (REVISED per R3-followup in Round 3)" — full rewrite of subsection; failure-mode table added; tests extended from 4 cases to 6. |
| **R5-followup (Round 3 — non-blocking, doc only)** | One paragraph clarifying that synthetic-ping rows do NOT artificially inflate `MAX(replied_at)` because they go through the same wrapper-handle-reply path as real messages. | Adopted as a doc-only addition. New 5-step walkthrough in the healthcheck section explains: synthetic-ping cron POSTs a real TG message → wrapper inserts row with `replied_at=NULL` → only the Channels-session subagent finishing its reply causes the wrapper to set `replied_at`. If the session is dead, `replied_at` stays NULL forever for that ping; `MAX(replied_at)` ignores NULLs by Postgres semantics. No code change — Round 2 was correct in spirit, only the doc loop had to close. The two existing healthcheck tests remain sufficient (the property is a Postgres invariant, not implementation-side). | "Healthcheck signal source (NEW per R5) → Refinement: distinguish 'received' from 'handled' → Round 3 clarification — synthetic-ping rows do NOT artificially inflate `MAX(replied_at)`" — new sub-subsection. |

### Round 2 — direct response to Round 1 review (unchanged from previous proposal version, kept for traceability)

This is the original Round 2 table; all 6 entries below are still applicable. Round 3 only revised R6 (above) and added the two follow-ons (above).

| R-ID | Evaluator's ask | Round 2 response | Sections updated in this proposal |
|---|---|---|---|
| **R1** | Two-tier byte-identity test for SPARTAN + Planner prompts (file-side always; deployed-side conditional on FR-001 Spike 3 confirming the API endpoint). Per constitution §2. | Adopted as proposed. New section "Two-tier prompt-preservation test" specifies Tier 1 (`prompt-preserve.test.ts`) ALWAYS runs (file-side byte-compare + Unicode normalization guard); Tier 2 (`prompt-preserve-deployed.test.ts`) reads `.harness/data/spike-fr-001-outcomes.json` and either runs the live-fetch test or skips with implementation-report flag + operator pre-deploy checklist (`docs/operator-pre-deploy-checklist.md`). Spike 3 EXTENDED to probe the deployed-prompt READ endpoint. Recommend AC-002-1-b and AC-003-1-b additions to contract. | "Two-tier prompt-preservation test (NEW per R1)"; Spike 3 outline (extended step 6); FR mapping FR-001 + FR-002 + FR-003 rows; AC table AC-002-1, AC-002-1-b, AC-003-1, AC-003-1-b rows; Build Order M0 step 3. |
| **R2** | Narrow the Channels subagent's Write allowlist — `/opt/caishen-channels/**` is too broad; exclude `scripts/` and `agents/`. | Adopted. New layout convention table splits the directory tree into operator-managed-immutable (`agents/`, `scripts/`, `data/<allowlist>` read-only) vs subagent-managed (`work/**` read+write). Subagent yaml's tools list now reads: `Read(/opt/caishen-channels/work/**)`, `Read(/opt/caishen-channels/data/pair-list-cache.json)`, `Write(/opt/caishen-channels/work/**)` — explicitly NO `scripts/` or `agents/`. Subagent system prompt has explicit "Self-modification is forbidden" clause. AC-004-3 test gains an assertion that the Write allowlist excludes `scripts/` and `agents/`. | "Channels Subagent (AC-004-3) — exact yaml shape (REVISED per R2)"; FR mapping FR-004 row; AC table AC-004-3 row; layout convention table at top of the section. |
| **R3** | Make the re-plan cleanup flow explicit (FR-002 EC-002-3 + FR-018 AC-018-2): delete pair_schedules → cancel one-offs → write new schedule → handle race window. | Adopted. New section "Re-plan cleanup flow (NEW per R3)" specifies: (a) cancellation path = DB-side mark-as-cancelled (Anthropic API has no /cancel endpoint per Spike 3); (b) Executor pre-fire stale-check using `$ANTHROPIC_ONE_OFF_ID` env var compared against `pair_schedules.scheduled_one_off_id`; (c) transactional ordering inside `/api/overrides/replan`: read beforeSchedule → mark old rows cancelled → insert override_actions → call `/fire` → update with afterState → broadcast TG; (d) race window covered by Executor's first-20-lines noop logic. New `replan-cleanup.test.ts` with 4 vitest cases. Recommend AC-018-2-b addition to contract. | "Re-plan cleanup flow (NEW per R3)"; Spike 3 (records `$ANTHROPIC_ONE_OFF_ID` env var availability — implicit); FR mapping FR-002, FR-003, FR-018 rows; Data Model `pair_schedules.status` enum + `routine_runs.routine_name` enum gains `replan_orchestrator`; AC table AC-002-2(h), AC-018-2, AC-018-2-b rows; Build Order M2 #13 + M2 #14 + M4 #22; new Risk Flag #11 (running-Executor edge — design intent). |
| **R4** | Specify override handler's read-before-write semantics so `before_state_json` capture is testable (NFR-007 atomicity). | Adopted. New section "Override handler flow (NEW per R4)" specifies the 7-step flow with explicit code outline: (1) Auth.js, (2) CSRF [R6], (3) MT5 read for before_state, (4) audit insert with success=null, (5) MT5 write, (6) read after_state, (7) audit update + Telegram. NFR-007 fault-injection table maps each of 4 MSW boundaries to an `overrides-atomicity.spec.ts` test case. AC-007-3-b test code shown. `override_actions` schema deltas (success/before/after now NULLABLE) listed. Recommend AC-007-3-b addition to contract. | "Override handler flow (NEW per R4)"; Data Model `override_actions` deltas; FR mapping FR-007 + FR-016 rows; AC table AC-007-3, AC-007-3-b, AC-016-1, AC-008-1 rows; NFR table NFR-007 row; Build Order M1 #12 (override-handler skeleton) + M4 #20. |
| **R5** | Pick signal source for `last_message_handled_at`. Evaluator recommended Postgres `MAX(received_at) FROM telegram_interactions`. | Adopted with refinement: `MAX(replied_at)` (not `received_at`) so the signal reflects "session has handled a message", not just "wrapper received one". 30-min synthetic-ping cron added as fallback for quiet periods. New `healthcheck-signal.test.ts` with two cases (recent reply → healthy; 11-min gap → unhealthy with reason). Schema deltas: `telegram_interactions(tenant_id, replied_at DESC)` index added; `command_parsed` enum gains `SYNTHETIC_PING`. New API route `/api/cron/synthetic-ping` (every 30 min). | "Healthcheck signal source (NEW per R5)"; API Surface table; Cron schedule; Data Model `telegram_interactions` row; FR mapping FR-005 row; AC table AC-005-1 + AC-008-3 rows. |
| **R6** | CSRF protection on dashboard `/api/overrides/*` POST routes. Required for OWASP survival per criteria.md Code Quality threshold. | Adopted. New section "CSRF protection (NEW per R6)" specifies double-submit-cookie pattern using Auth.js v5's existing CSRF token. New files: `lib/csrf.ts` (validation helper), `components/csrf-form.tsx` (auto-injects token from `getCsrfToken()`). All 6 override POST routes (close-pair, close-all, edit-position, pause, resume, replan) call `validateCsrf()` BEFORE any other action — 403 on failure. New `overrides-csrf.spec.ts` Playwright spec with 6 negative + 6 positive tests. New Risk Flag #10 (CSRF token rotation on session refresh — minor; mitigated by retry-once-on-403). Recommend AC-016-1-b, AC-016-2-b, AC-016-3-b additions to contract. | "CSRF protection (NEW per R6)"; Directory structure `lib/csrf.ts` + `components/csrf-form.tsx` + `tests/e2e/overrides-csrf.spec.ts`; API Surface table CSRF column; FR mapping FR-006 + FR-016 + FR-017 + FR-018 rows; AC table AC-016-1, AC-016-1-b, AC-016-2, AC-016-2-b, AC-016-3, AC-016-3-b, AC-017-3, AC-018-1 rows; Build Order M3 #17 (CSRF helper precedes override handlers); Risk Flag #10 (NEW). |

### Proposed-by-Evaluator new ACs — flagged for inclusion in FINALIZE-CONTRACT

The Evaluator's review proposed 4 new ACs to add to the final contract. Round 2 commits to test scaffolding for each AND recommends they be added to `contract.md` in FINALIZE-CONTRACT mode (this proposal does not modify the contract):

| New AC | Driver | Suggested final wording (per Evaluator's review.md "New ACs" section) | Test surface in this proposal |
|---|---|---|---|
| **AC-002-1-b** | R1 | "A vitest CI test diffs the routine's deployed-prompt-source-of-truth file against `.harness/spec/preserve/planner-systemprompt.md` byte-for-byte. PASS = byte-identical (no smart-quote/CRLF/trailing-ws normalization). AC-002-1-c (conditional, runs only if Spike 3 confirms 'get current system prompt' endpoint): a CI test fetches the live deployed system prompt via Anthropic API and byte-compares against the file. If endpoint does not exist: implementation-report.md notes constitution §2 verification is at file-side only, and operator's pre-deploy checklist gains a manual screenshot+diff step." | `prompt-preserve.test.ts` (Tier 1) + `prompt-preserve-deployed.test.ts` (Tier 2 conditional skip) + `docs/operator-pre-deploy-checklist.md` |
| **AC-003-1-b** | R1 | Same wording as AC-002-1-b but for `spartan-systemprompt.md`. | Same test files cover both Spartan + Planner. |
| **AC-007-3-b** | R4 | "Every override action's `before_state_json` is the result of a server-side MT5 REST read performed BEFORE any state-mutating call. Test: vitest mocks MT5 to return state X on the read, returns success on the write; asserts `override_actions.before_state_json` deserializes to X. Test: vitest mocks MT5 to return state X, fails the write; asserts before_state_json=X, success=false, no Telegram, after_state_json=last-known." | `overrides-atomicity.spec.ts` AC-007-3-b cases (2 happy + fail variants shown in R4 section) |
| **AC-016-1-b / -2-b / -3-b** | R6 | "The route handler validates a CSRF token on every request; missing/invalid token returns 403 without invoking MT5. Test: Playwright POST without CSRF token expects 403 + no MT5 mock call + no audit row inserted." | `overrides-csrf.spec.ts` 6 negative + 6 positive cases; replicated for pause/resume/replan even though those are flagged under FR-017 + FR-018 (those routes also gain CSRF; bundle as part of the same AC family for contract simplicity). |
| **AC-018-2-b** | R3 | "An Executor one-off that fires AFTER the re-plan deletes its pair_schedules row reads agent_state + pair_schedules at start; if its own (pair, session, today) row no longer exists OR is cancelled, writes a 'stale-plan-noop' audit row and exits BEFORE any MT5 call. Test: vitest with timing — insert pair_schedules, simulate Executor pre-fire check after deletion → exits with stale-plan-noop audit row, zero MT5 mock calls." | `replan-cleanup.test.ts` cases 2 + 3 |

**Recommendation to orchestrator**: when FINALIZE-CONTRACT runs (after this proposal is accepted), add these 5 ACs (AC-002-1-b, AC-003-1-b, AC-007-3-b, AC-016-1-b/-2-b/-3-b grouped, AC-018-2-b) to the final `contract.md`'s "Test Criteria (flat list)" section. The build artefacts in this proposal (test files, helpers, schema deltas) are sufficient to satisfy them.

### Answers to Generator's Round 1 Questions — committed-to in Round 2

All seven of my Round 1 questions were answered in `review.md`. Each answer is now embedded in the proposal:

- **Q1 (FR-010 pull-forward)**: endorsed; build order M0 #2.
- **Q2 (byte-identity test)**: two-tier; see R1 section.
- **Q3 (tenant-id-lint scope)**: AST + regex + raw-SQL-allowlist; see Data Model invariant #2.
- **Q4 (FR-013 SKIP path)**: skip-marker vitest `fr-013-skip-marker.test.ts`; see Vercel Sandbox section + AC-013 row.
- **Q5 (Channels NFR-002 soak)**: staging + rolling production view; Evaluator verifies infra; AC-004-5 row.
- **Q6 (design bundle missing)**: implementation-report flag + operator escalation if Product Depth ≤ 6; Risk Flag #5 (unchanged).
- **Q7 (tool allowlist syntax)**: confirmed; the Round 2 R2 narrowing is on top of this confirmed syntax.

### Round 1 Risk Flag dispositions

All 9 Round 1 risk flags were addressed in review.md and are recorded in the Round 2 "Risk Flags" section above. New Round 2 flags #10 (CSRF rotation) and #11 (running-Executor edge) added.
