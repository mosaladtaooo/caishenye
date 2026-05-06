<!-- BELCORT Harness — Build Contract — FINAL (Negotiated) -->

# Build Contract — Final (Negotiated)

**Negotiated**: 2026-05-03
**Rounds**: 3 of max 3
**Agreement**: Generator proposal (Round 3) + Evaluator review (Round 3 verdict: agreed)
**Feature**: 001-foundation-routines-channels-dashboard

---

## Negotiation summary

This contract reflects the merged agreement between Generator and Evaluator after three rounds of negotiation. Round 3 closed three items the Round 2 review surfaced: the R6 cryptographic primitive (CSRF moved to a self-issued HMAC-SHA256 cookie via `GET /api/csrf`, decoupled from Auth.js v5 internals); R3-followup (re-plan handler split into two short transactions bridged by a `success=null` in-flight marker, with the external `/fire` POST outside both txs); R5-followup (documentary tightening of why synthetic-ping rows do not artificially inflate `MAX(replied_at)` — Postgres ignores NULL).

The negotiated **Build Order** below replaces the draft contract's "Suggested Build Order" with the Generator's technical-dependency order, including the Q1 reorder that pulls **FR-010 forward to M0 step 2** so every spike commit must already pass the no-API-key gate (Evaluator endorsed in Round 1).

Five new ACs were added during negotiation and appear in the flat-list "Test Criteria" section below:
- **AC-002-1-b** — Tier 2 deployed-side byte-identity test for the Planner system prompt (conditional on Spike 3 outcome)
- **AC-003-1-b** — Tier 2 deployed-side byte-identity test for the Executor (Spartan) system prompt (conditional on Spike 3 outcome)
- **AC-007-3-b** — `before_state_json` is captured from a real MT5 read BEFORE any state-mutating call, with explicit fault-injection coverage when the write fails
- **AC-016-1-b / -2-b / -3-b** — CSRF rejection tests on `/api/overrides/{close-pair, close-all, edit-position}` POST routes (missing cookie, wrong secret, mismatched submitted-token)
- **AC-018-2-b** — Re-plan race window: a one-off scheduled to fire during the cleanup gap noops via the Executor pre-fire stale-check

---

## Scope

FRs in this build (all 21):
- FR-001: Architecture-spike verification of LOAD-BEARING ASSUMPTIONS
- FR-002: Daily Planner Routine
- FR-003: Per-pair Executor Routines
- FR-004: Always-on Channels session (Telegram surface)
- FR-005: Channels-session health check + crash recovery
- FR-006: Mission-control dashboard (Next.js + shadcn/ui, Vercel)
- FR-007: Audit trail across the entire system
- FR-008: Postgres schema with multi-tenant tenant_id
- FR-009: VPS-to-cloud public tunnel (Tailscale Funnel + app-layer bearer — per clarify Q2)
- FR-010: Subscription-only auth (no `ANTHROPIC_API_KEY`)
- FR-011: Pair config (DB-driven)
- FR-012: V1 pair list seed
- FR-013: Code interpreter substitute (compute_python MCP) — CONDITIONAL, gated on Spike 2 (FR-001 AC-001-2) math-fidelity outcome
- FR-014: News fetch + markdown rendering port
- FR-015: Trade history + report archive
- FR-016: Override actions
- FR-017: Pause/resume agent
- FR-018: Force re-plan
- FR-019: Telegram report messages (preserve existing behavior)
- FR-020: Initial setup script (init.sh)
- FR-021: Daily cap monitoring + alerts

FRs deferred to future features: (none — v1 is the entire system)

---

## Component/Module Breakdown

The codebase is a **Bun workspaces monorepo** with four packages:

- **`packages/db/`** — Drizzle schema, migrations, tenant-scoped client factory, `audit.ts` (constitution §3 audit-or-abort), tenant-id linter (`lint/tenant-id-lint.ts`). Single source of truth for the data model. Depended on by every other package.
- **`packages/routines/`** — Trading core. Planner + Executor TS body code (run inside Anthropic Routines as Bash steps), three spike modules (FR-001 — Spike 1 cap-exempt verification was DROPPED in v1.1 per ADR-002 revised), news-fetch port (FR-014), prompt-loader (constitution §2 byte-identity), MT5 REST client, Telegram Bot API client (FR-019). The cron tick at `/api/cron/fire-due-executors` (in `packages/dashboard/`) is the sole fire path; no schedule-fire selector module exists in v1.1.
- **`packages/channels/`** — Always-on Channels session. Subagent yaml (`agents/caishen-telegram.md`), wrapper scripts (operator-managed, immutable to the subagent — R2 hardening), per-command scripts (`status.sh`, `balance.sh`, etc.), allowlist enforcement, healthcheck handler.
- **`packages/dashboard/`** — Next.js 16 App Router + shadcn/ui + SWR. Auth.js v5 with Passkey provider, Drizzle adapter. Five core screens (Overview, Per-pair, Schedule, History, Overrides). All `/api/overrides/*` POST routes are CSRF-protected via `lib/csrf.ts` (R6).

Outside `packages/` but inside the repo:
- **`infra/`** — VPS setup script, systemd units, nginx bearer-proxy config, CI YAML, local docker-compose for Postgres.
- **`design/dashboard-bundle/`** — Operator-exported Claude Design output (consumed by `frontend-design` skill during dashboard build).
- **`docs/`** — `spike-report-fr-001.md` (FR-001 deliverable), `operator-pre-deploy-checklist.md` (R1 escape hatch when Tier 2 prompt-preserve endpoint unavailable), `adr/`.
- **`.harness/`** — Pipeline state (unchanged).

---

## Directory Structure

```
财神爷/
├── package.json                    # root: workspaces, packageManager: bun@<pinned>
├── bun.lock                        # committed
├── biome.json                      # lint + format (constitution §17)
├── tsconfig.base.json              # strict, no-any enforced
├── .gitleaks.toml                  # constitution §10
├── .lefthook.yml                   # pre-commit: no-api-key + biome + gitleaks
├── Makefile                        # `make audit-no-api-key`, `make spike`, `make seed`
├── design/dashboard-bundle/        # operator-exported Claude Design output
├── docs/
│   ├── spike-report-fr-001.md
│   ├── operator-pre-deploy-checklist.md
│   └── adr/
├── infra/
│   ├── vps/
│   │   ├── setup.sh                                       # AC-020-2; idempotent
│   │   ├── systemd/
│   │   │   ├── caishen-channels.service                   # AC-004-1
│   │   │   ├── caishen-channels-restart.service           # ADR-009 oneshot
│   │   │   ├── caishen-channels-restart.timer             # 30-min cadence
│   │   │   ├── caishen-mt5-bearer-proxy.service           # AC-009-2
│   │   │   └── tailscale-funnel.service
│   │   └── nginx/
│   │       └── mt5-bearer.conf
│   ├── ci/
│   │   └── github-workflows/                              # bun → lint → tsc → vitest → no-api-key → gitleaks
│   └── local/
│       ├── docker-compose.yml                             # local Postgres 16
│       └── seed-local.ts                                  # FR-012 seed
├── packages/
│   ├── db/
│   │   ├── package.json                                   # name: "@caishen/db"
│   │   ├── drizzle.config.ts
│   │   ├── src/
│   │   │   ├── client.ts                                  # tenant-scoped client factory
│   │   │   ├── schema/                                    # one file per table
│   │   │   ├── queries/                                   # tenant-scoped helpers
│   │   │   ├── audit.ts                                   # withAuditOrAbort (constitution §3)
│   │   │   ├── migrate.ts
│   │   │   └── lint/
│   │   │       ├── tenant-id-lint.ts                      # AST + regex (Q3)
│   │   │       └── raw-sql-allowlist.txt                  # ≤3 entries, justified
│   │   └── migrations/
│   │       ├── 0001_init.sql
│   │       ├── 0002_seed_pairs.sql                        # FR-012 seed
│   │       └── meta/
│   ├── routines/
│   │   ├── package.json                                   # name: "@caishen/routines"
│   │   ├── src/
│   │   │   ├── planner.ts                                 # FR-002
│   │   │   ├── executor.ts                                # FR-003 (first 20 lines = pre-fire stale-check)
│   │   │   ├── spike/
│   │   │   │   ├── ac-001-2-duration-and-math.ts          # combines duration + math fidelity
│   │   │   │   ├── ac-001-3-fire-api.ts                   # ALSO probes deployed-prompt READ endpoint (R1)
│   │   │   │   └── ac-001-4-token-soak.ts
│   │   │   ├── news.ts                                    # FR-014
│   │   │   ├── ffcal.ts                                   # ForexFactory MCP client (legacy; replaced by calendar.ts in v1.1)
│   │   │   ├── calendar.ts                                # FR-022 v1.1 — fetchAndRenderCalendar via Vercel proxy
│   │   │   ├── indicators.ts                              # FR-022 v1.1 — fetchIndicator (TwelveData) via Vercel proxy
│   │   │   ├── mt5.ts                                     # MT5 REST client (typed)
│   │   │   ├── telegram-bot.ts                            # FR-019 direct Bot API
│   │   │   ├── prompt-loader.ts
│   │   │   ├── preserve-mirror/                           # byte-identical mirror of .harness/spec/preserve/
│   │   │   │   ├── spartan-systemprompt.md
│   │   │   │   └── planner-systemprompt.md
│   │   │   ├── time.ts                                    # GMT/UTC helpers (constitution §5)
│   │   │   ├── cap-counter.ts                             # FR-021 AC-021-1
│   │   │   ├── routine-runs.ts                            # withAuditOrAbort wrapper
│   │   │   └── compute-python-mcp/                        # CONDITIONAL — only if FR-013 builds
│   │   │       └── server.ts                              # Vercel Function exposing MCP server
│   │   └── tests/
│   │       ├── fixtures/rss/                              # frozen golden RSS feeds
│   │       ├── fixtures/spike/                            # 958-bar EUR/USD OHLC fixture
│   │       ├── news.test.ts                               # AC-014-2 snapshot
│   │       ├── prompt-preserve.test.ts                    # constitution §2 Tier 1 (AC-002-1, AC-003-1)
│   │       ├── prompt-preserve-deployed.test.ts           # constitution §2 Tier 2 (AC-002-1-b, AC-003-1-b — conditional skip)
│   │       ├── xau-symbol.test.ts                         # AC-003-3
│   │       ├── time-dst.test.ts                           # NFR-008 (Mar 30 + Oct 26, 2026)
│   │       ├── audit-or-abort.test.ts                     # AC-007-1 + EC-007-1
│   │       ├── replan-cleanup.test.ts                     # AC-018-2 + AC-018-2-b + Tx-failure cases (R3 + R3-followup)
│   │       ├── tenant-scope.test.ts                       # AC-008-2 lint
│   │       └── fr-013-skip-marker.test.ts                 # CONDITIONAL — asserts skip OR build
│   ├── channels/
│   │   ├── package.json                                   # name: "@caishen/channels"
│   │   ├── agents/
│   │   │   └── caishen-telegram.md                        # AC-004-3 subagent yaml (R2 narrowed scope)
│   │   ├── src/
│   │   │   ├── allowlist.ts                               # AC-004-6
│   │   │   ├── tg-interactions.ts                         # AC-007-2 audit row writer
│   │   │   ├── recovery.ts                                # AC-005-3
│   │   │   └── commands/
│   │   │       ├── status.ts
│   │   │       ├── positions.ts
│   │   │       ├── report.ts
│   │   │       ├── balance.ts
│   │   │       ├── history.ts
│   │   │       ├── pause.ts
│   │   │       ├── resume.ts
│   │   │       ├── closeall.ts
│   │   │       ├── closepair.ts
│   │   │       ├── replan.ts
│   │   │       └── edit.ts
│   │   ├── scripts/                                       # operator-managed, NOT writable by subagent (R2)
│   │   │   ├── restart-on-idle.sh                         # ADR-009 systemd-timer entry
│   │   │   └── healthcheck-handler.ts                     # AC-005-1 endpoint (queries MAX(replied_at))
│   │   └── tests/
│   │       ├── allowlist.test.ts                          # AC-004-6
│   │       ├── recovery.test.ts                           # AC-005-3
│   │       ├── healthcheck-signal.test.ts                 # AC-005-1 (R5)
│   │       └── commands/*.test.ts
│   └── dashboard/
│       ├── package.json                                   # name: "@caishen/dashboard"
│       ├── next.config.ts
│       ├── vercel.json                                    # crons[] — see API surface
│       ├── middleware.ts                                  # NFR-009 — Auth.js gate at root
│       ├── app/
│       │   ├── layout.tsx
│       │   ├── (auth)/
│       │   │   ├── login/page.tsx
│       │   │   └── auth/passkey-register/page.tsx         # INITIAL_REGISTRATION_TOKEN gated
│       │   ├── (dashboard)/
│       │   │   ├── layout.tsx                             # Auth.js auth() wrapper + nav
│       │   │   ├── page.tsx                               # Overview (AC-006-2 #1)
│       │   │   ├── pair/[pair]/page.tsx                   # Per-pair Detail (#2)
│       │   │   ├── schedule/page.tsx                      # Schedule + force re-plan (#3)
│       │   │   ├── history/page.tsx                       # History (#4 + cold archive recall)
│       │   │   └── overrides/page.tsx                     # Override Panel (#5)
│       │   └── api/
│       │       ├── auth/[...nextauth]/route.ts
│       │       ├── csrf/route.ts                          # GET — issues HMAC CSRF cookie (R6)
│       │       ├── overview/route.ts
│       │       ├── schedule/route.ts
│       │       ├── pairs/route.ts
│       │       ├── overrides/                             # ALL POSTs gated by validateCsrf (R6)
│       │       │   ├── close-pair/route.ts                # AC-016-1 + AC-016-1-b
│       │       │   ├── close-all/route.ts                 # AC-016-2 + AC-016-2-b
│       │       │   ├── edit-position/route.ts             # AC-016-3 + AC-016-3-b
│       │       │   ├── pause/route.ts                     # AC-017-3
│       │       │   ├── resume/route.ts
│       │       │   └── replan/route.ts                    # AC-018-1 (split-tx — R3-followup)
│       │       ├── reports/[id]/route.ts                  # AC-015-1 signed-URL minter
│       │       ├── archive-fetch/route.ts                 # ADR-006 cold-archive recall
│       │       └── cron/
│       │           ├── channels-health/route.ts           # AC-005-2 (every 5 min)
│       │           ├── audit-archive/route.ts             # ADR-006 (daily 03:30 GMT)
│       │           ├── orphan-detect/route.ts             # NFR-004 (daily)
│       │           ├── cap-rollup/route.ts                # FR-021 AC-021-1 (daily 12:00 GMT)
│       │           ├── synthetic-ping/route.ts            # AC-005-1 fallback (every 30 min)
│       │           └── usage-reconcile/route.ts           # CONDITIONAL on FR-001 Spike 4
│       ├── components/
│       │   └── csrf-form.tsx                              # wraps forms; fetches /api/csrf (R6)
│       ├── lib/
│       │   ├── auth.ts                                    # Auth.js v5 + DrizzleAdapter + Passkey
│       │   ├── csrf.ts                                    # HMAC-SHA256 double-submit-cookie helper (R6)
│       │   ├── override-handler.ts                        # 7-step flow (R4)
│       │   ├── mt5-server.ts                              # server-only MT5 fetch with bearer
│       │   ├── stale.ts                                   # 30s yellow / 60s red banner logic
│       │   └── markdown.ts                                # react-markdown wrapper
│       └── tests/
│           ├── e2e/
│           │   ├── auth-routes.spec.ts                    # NFR-009 route enumeration
│           │   ├── overview.spec.ts                       # AC-006-1..3
│           │   ├── overrides-atomicity.spec.ts            # NFR-007 fault injection at 4 boundaries (R4) + AC-007-3-b
│           │   ├── overrides-csrf.spec.ts                 # AC-016-{1,2,3}-b CSRF 403 (R6)
│           │   ├── replan.spec.ts                         # AC-018-1..3 + AC-018-2-b
│           │   └── cold-archive-recall.spec.ts            # ADR-006
│           └── unit/
│               ├── stale.test.ts
│               ├── csrf.test.ts                           # R6 algorithm-pinning fixture (8 cases)
│               └── route-handlers/*.test.ts
└── .harness/                       # pipeline state
```

---

## Data Model

Drizzle schema, snake_case per constitution §16. One file per table under `packages/db/src/schema/`. Every table includes `tenant_id INTEGER NOT NULL DEFAULT 1` per constitution §4.

| Entity | Selected fields | Serves FR | Indexes |
|--------|-----------------|-----------|---------|
| `tenants` | `id`, `name`, `allowed_telegram_user_ids` (jsonb int[]), `created_at` | FR-004 AC-004-6 | PK |
| `users` | `id`, `tenant_id`, `email` (unique). Plus Auth.js DrizzleAdapter tables (`accounts`, `sessions`, `verification_tokens`, `authenticators`) | FR-006, NFR-009 | unique(email) |
| `pair_configs` | PK=(`tenant_id`, `pair_code`), `mt5_symbol`, `sessions_json` (jsonb), `active_bool`, `created_at` | FR-011, FR-012 | PK |
| `pair_schedules` | `id`, `tenant_id`, `date`, `pair_code`, `session_name`, `start_time_gmt` (nullable), `end_time_gmt` (nullable), `planner_run_id` (FK), `scheduled_one_off_id` (text), `status` enum: `scheduled` `cancelled` `fired` `skipped_no_window`, `created_at` | FR-002 AC-002-2g, FR-018 AC-018-2 + AC-018-2-b | (`tenant_id`, `date`); (`tenant_id`, `pair_code`, `date`) |
| `routine_runs` | `id`, `tenant_id`, `routine_name` enum: `planner` `executor` `spike_*` `cap_status` **`replan_orchestrator`** (R3 delta), `pair`, `session_window`, `started_at`, `ended_at`, `claude_code_session_id`, `claude_code_session_url`, `input_text`, `output_json`, `tool_calls_count`, `status`, `failure_reason`, `degraded`, `routine_fire_kind` | FR-007 AC-007-1, FR-002 AC-002-2i, FR-003 AC-003-4 | (`tenant_id`, `started_at` DESC); (`tenant_id`, `routine_name`, `started_at` DESC) |
| `executor_reports` | `id`, `tenant_id`, `routine_run_id` (FK), `pair`, `session`, `report_md_blob_url`, `summary_md`, `action_taken`, `created_at` | FR-015 AC-015-2 | (`tenant_id`, `created_at` DESC) |
| `orders` | `id`, `tenant_id`, `mt5_ticket`, `pair`, `mt5_symbol`, `type` enum, `volume`, `price`, `sl`, `tp`, `opened_at`, `closed_at`, `source_table`, `source_id`, `status`, `pnl` | FR-007 AC-007-4, FR-015, FR-016 | (`tenant_id`, `opened_at` DESC); (`tenant_id`, `mt5_ticket`) |
| `override_actions` | `id`, `tenant_id`, `at`, `operator_user_id` (FK), `action_type` enum, `target_pair`, `target_ticket`, `params_json`, `before_state_json` (**nullable** — R4 delta), `after_state_json` (**nullable** — R4 delta), `success` (**nullable** — R4 delta; null = in-flight), `error_message` | FR-007 AC-007-3 + AC-007-3-b, FR-016, FR-017, FR-018 | (`tenant_id`, `at` DESC) |
| `telegram_interactions` | `id`, `tenant_id`, `received_at`, `replied_at` (nullable), `from_user_id`, `message_text`, `command_parsed` (slash command OR `FREE_TEXT` OR `REJECTED_NOT_ALLOWED` OR **`SYNTHETIC_PING`** — R5 delta), `tool_calls_made_json`, `reply_text`, `claude_code_session_id` | FR-007 AC-007-2, FR-004 AC-004-6, FR-005 AC-005-1 | (`tenant_id`, `received_at` DESC); (`tenant_id`, `from_user_id`, `received_at` DESC); **(`tenant_id`, `replied_at` DESC)** — R5 delta for healthcheck `MAX(replied_at)` |
| `channels_health` | `id`, `tenant_id`, `checked_at`, `healthy_bool`, `latency_ms`, `error`, `restart_reason` enum, `mute_alarm_until` (ADR-009) | FR-005 AC-005-1, AC-005-2 | (`tenant_id`, `checked_at` DESC) |
| `agent_state` | `tenant_id` (PK), `paused_bool`, `paused_at`, `paused_by` (FK) | FR-017 AC-017-1 | PK |
| `cap_usage_local` | `id`, `tenant_id`, `at`, `cap_kind` enum, `routine_runs_id` (FK) | FR-021 AC-021-1 (per ADR-008) | (`tenant_id`, `at` DESC) |
| `cap_usage` | `id`, `tenant_id`, `date`, `daily_used`, `daily_limit` (default 15), `weekly_used`, `weekly_limit`, `source` enum (`local_counter` / `anthropic_api`), `recorded_at` | FR-021 AC-021-1 (rollup) | (`tenant_id`, `date`); UNIQUE (`tenant_id`, `date`, `source`) |

### Key invariants enforced in `packages/db/src/`

1. **Tenant-scoped client factory** (`client.ts`): `getTenantDb(tenantId)` returns a Drizzle client with tenant context bound; raw `db` is not exported.
2. **Tenant-id linter** (`lint/tenant-id-lint.ts`): AST-walks all `.ts` files in `packages/{routines,channels,dashboard}/`, flags any `db.select/insert/update/delete` outside `getTenantDb()`, AND fails on `db.execute(sql\`...\`)` outside the `raw-sql-allowlist.txt` (≤3 entries; each justified with a comment showing tenant_id is filtered) — per Q3.
3. **`audit.ts`** — implements `withAuditOrAbort` wrapper used by every Planner / Executor / spike entry-point AND the new `replan_orchestrator` (R3-followup).
4. **`time.ts`** — pure GMT/UTC helpers; tests cover DST-day Mar 30 + Oct 26, 2026.

---

## API Surface

Next.js dashboard route handlers:

| Endpoint | Method | Purpose | Auth | CSRF | Serves FR |
|----------|--------|---------|------|------|-----------|
| `/api/auth/[...nextauth]` | GET/POST | Auth.js handlers | n/a | built-in | FR-006, NFR-009 |
| `/api/csrf` | GET | Issues HMAC-signed CSRF cookie + returns raw token (R6) | session required (401 otherwise) | n/a | FR-016/017/018 (helper) |
| `/api/overview` | GET | balance + equity + positions | session | n/a (GET) | FR-006 AC-006-3 |
| `/api/schedule` | GET | today's `pair_schedules` rows + countdowns | session | n/a (GET) | FR-006, FR-018 |
| `/api/pairs` | GET | active pair list (read-only v1) | session | n/a (GET) | FR-011 AC-011-3 |
| `/api/positions` | GET | live MT5 positions via tunnel | session | n/a (GET) | FR-006 |
| `/api/overrides/close-pair` | POST | body: `{pair, csrf}` | session + re-verify | **YES (R6)** | FR-016 AC-016-1 + AC-016-1-b, NFR-007 |
| `/api/overrides/close-all` | POST | body: `{confirmation: "CLOSE-ALL", csrf}` | session + re-verify + body confirmation | **YES (R6)** | FR-016 AC-016-2 + AC-016-2-b |
| `/api/overrides/edit-position` | POST | body: `{ticket, sl, tp, csrf}` | session + re-verify | **YES (R6)** | FR-016 AC-016-3 + AC-016-3-b |
| `/api/overrides/pause` | POST | body: `{csrf}` — sets `agent_state.paused_bool=true`, cancels not-yet-fired one-offs | session + re-verify | **YES (R6)** | FR-017 AC-017-3 |
| `/api/overrides/resume` | POST | body: `{csrf}` | session + re-verify | **YES (R6)** | FR-017 |
| `/api/overrides/replan` | POST | body: `{confirm_low_cap?, csrf}` — fires Planner via `/fire`; uses split-transaction flow (R3-followup) | session + re-verify + cap-confirm if ≤ 2 slots | **YES (R6)** | FR-018 AC-018-1, AC-006-5 |
| `/api/reports/[id]` | GET | mints signed Vercel Blob URL (1h expiry) | session | n/a (GET) | FR-015 AC-015-1 |
| `/api/archive-fetch` | GET | query: `?date=YYYY-MM-DD` | session | n/a (GET) | ADR-006 |
| `/api/cron/channels-health` | GET | fired every 5 min by GitHub Actions cron (`.github/workflows/cron-channels-health.yml`); Hobby-plan-compatible | CRON_SECRET (verified in both Vercel env AND GitHub repo Secrets) | n/a (cron) | FR-005 AC-005-2 |
| `/api/cron/audit-archive` | GET | daily 03:30 GMT | CRON_SECRET | n/a (cron) | ADR-006 |
| `/api/cron/orphan-detect` | GET | daily | CRON_SECRET | n/a (cron) | NFR-004 |
| `/api/cron/cap-rollup` | GET | daily 12:00 GMT | CRON_SECRET | n/a (cron) | FR-021 AC-021-1 |
| `/api/cron/usage-reconcile` | GET | conditional, daily | CRON_SECRET | n/a (cron) | FR-021 (per ADR-008) |
| `/api/cron/synthetic-ping` | GET | fired every 30 min by GitHub Actions cron (`.github/workflows/cron-synthetic-ping.yml`); POSTs synthetic TG ping for R5 fallback signal; Hobby-plan-compatible | CRON_SECRET (verified in both Vercel env AND GitHub repo Secrets) | n/a (cron) | FR-005 AC-005-1 fallback |

### Cron schedule (`packages/dashboard/vercel.json`)

The two sub-daily crons (`channels-health` 5-min, `synthetic-ping` 30-min) MOVED to GitHub Actions per AC-005-2 amendment (Vercel Hobby plan blocks sub-daily). Vercel cron config is reduced to daily-only. The corresponding `.github/workflows/cron-{channels-health,synthetic-ping}.yml` files invoke the same Next.js handlers via `curl -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}"`.

```jsonc
{
  "crons": [
    {"path": "/api/cron/orphan-detect",     "schedule": "15 4 * * *"},
    {"path": "/api/cron/audit-archive",     "schedule": "30 3 * * *"},
    {"path": "/api/cron/cap-rollup",        "schedule": "0 12 * * *"}
    // /api/cron/usage-reconcile entry added IF FR-001 Spike 4 PASSES /v1/usage exposure check
  ]
}
```

**v1.1 amendment**: The every-minute cron tick at `/api/cron/fire-due-executors` (Planner-write → cron-fire model per ADR-002 revised) is sub-daily and Hobby-plan-blocked from Vercel cron. It SHOULD live on GitHub Actions in parity with `cron-channels-health.yml` and `cron-synthetic-ping.yml` (per AC-005-2 amendment) — `.github/workflows/cron-fire-due-executors.yml` schedule `* * * * *`. If the operator's deployed v1.1 chose a different runtime (Vercel Pro upgrade, external scheduler, etc.), update this comment in a follow-up `/harness:edit`. See UNCLEAR § in this edit-patches file.

### GitHub Actions cron workflows (NEW — per AC-005-2 amendment)

Two workflow files in `.github/workflows/`:

- `cron-channels-health.yml` — schedule `*/5 * * * *` (best-effort; GH Actions cron has documented up-to-15-min jitter); single `curl` step hits `https://${VERCEL_DEPLOYMENT_URL}/api/cron/channels-health` with `Authorization: Bearer ${{ secrets.CRON_SECRET }}` and `--fail-with-body`. Job fails if curl exits non-zero.
- `cron-synthetic-ping.yml` — schedule `*/30 * * * *` (same jitter caveat); same shape; hits `/api/cron/synthetic-ping`.

Both workflows require two GitHub repo Secrets: `CRON_SECRET` (matching the Vercel env value) and `VERCEL_DEPLOYMENT_URL` (or hardcoded base URL in the workflow YAML; operator chooses).

---

## FR → Implementation Mapping

| FR | Components touched | Files (planned) | Test strategy |
|----|---|---|---|
| FR-001 | routines/spike + db/audit | `packages/routines/src/spike/ac-001-{2,3,4}.ts`, `docs/spike-report-fr-001.md`, `.harness/data/spike-fr-001-outcomes.json` (NEW — feeds Tier 2 prompt-preserve test) | Each spike writes `routine_runs` row + appends to spike-report; vitest math-fidelity in CI; Spike 3 ALSO probes deployed-prompt READ endpoint (R1). Spike 1 (AC-001-1 cap-exempt verification) DROPPED in v1.1 — no `claude /schedule` API exists; replaced by ADR-002 revised model. |
| FR-002 | routines/planner.ts + db | `packages/routines/src/planner.ts`, `news.ts`, `prompt-loader.ts` | vitest with mocked deps + `replan-cleanup.test.ts` for EC-002-3 ordering (R3); Planner writes `pair_schedules` rows in `status='scheduled'` only — cron tick at `/api/cron/fire-due-executors` does the firing |
| FR-003 | routines/executor.ts + db + telegram-bot | `packages/routines/src/executor.ts` (first 20 lines = pre-fire stale-check), `mt5.ts`, `telegram-bot.ts` | vitest XAU/USD hard test + pre-fire stale-check feeds AC-018-2-b |
| FR-004 | channels/agents + channels/src + infra/vps | as proposed; subagent yaml's Write scope NARROWED per R2 (work/ only, not scripts/agents/) | YAML schema validation + tools-list assertion includes "Write does NOT include scripts/ or agents/" check |
| FR-005 | channels/scripts/healthcheck-handler + dashboard/api/cron/{channels-health,synthetic-ping} + .github/workflows/cron-{channels-health,synthetic-ping}.yml | `packages/channels/scripts/healthcheck-handler.ts` queries `MAX(replied_at)` per R5; `packages/dashboard/app/api/cron/synthetic-ping/route.ts` NEW; `.github/workflows/cron-channels-health.yml` and `.github/workflows/cron-synthetic-ping.yml` NEW (per AC-005-2 amendment) | `healthcheck-signal.test.ts` per R5 + GH Actions schedule string assertion (vitest reads YAML, asserts cron expressions are `*/5 * * * *` and `*/30 * * * *` respectively) + manual smoke against deployed Vercel preview |
| FR-006 | dashboard/* | as proposed + `lib/csrf.ts` + `app/api/csrf/route.ts` + `components/csrf-form.tsx` per R6 | Playwright NFR-009 + CSRF 403 on missing token |
| FR-007 | db/audit + every agent + dashboard/api | as proposed + `override-handler.ts` implementing R4's 7-step flow | vitest for each step boundary + AC-007-3-b before-state assertion |
| FR-008 | db/schema/* + db/migrations | as proposed; `override_actions.success/before/after` NULLABLE deltas (R4); `routine_runs.routine_name` enum gains `replan_orchestrator` (R3); `telegram_interactions.command_parsed` enum gains `SYNTHETIC_PING` (R5); index on (`tenant_id`, `replied_at` DESC) (R5) | post-migration column nullability + index existence test |
| FR-009 | infra/vps/setup.sh + infra/vps/nginx + systemd | as proposed | bash test in CI |
| FR-010 | .lefthook.yml + Makefile + .gitleaks.toml + ci | as proposed | NEGATIVE test: write `ANTHROPIC_API_KEY=fake` → lefthook rejects |
| FR-011 | db/queries/pairs.ts + dashboard | as proposed | vitest + Playwright read-only |
| FR-012 | db/migrations/0002_seed_pairs | as proposed | post-seed row count + GBP/JPY absent |
| FR-013 | CONDITIONAL — routines/compute-python-mcp/ if needed | If built: Vercel Sandbox impl; if skipped: skip-marker test per Q4 | `fr-013-skip-marker.test.ts` |
| FR-014 | routines/news.ts | snapshot vs frozen golden | as proposed |
| FR-015 | routines/executor + dashboard/api/reports/[id] | Vercel Blob upload + signed-URL minter | vitest + Playwright |
| FR-016 | dashboard/api/overrides/* + override-handler.ts (R4) + csrf.ts (R6) + telegram-bot | per R4 7-step flow; per R6 CSRF gate | NFR-007 fault inject at 4 boundaries (R4) + AC-007-3-b before-state + AC-016-{1,2,3}-b CSRF 403 |
| FR-017 | db/schema/agent-state + dashboard/api/overrides/{pause,resume} + planner/executor pre-fire | as proposed + CSRF gate per R6 | vitest pause/resume |
| FR-018 | dashboard/api/overrides/replan + channels/src/commands/replan + replan-cleanup.test.ts | per R3 cleanup-flow ordering + R3-followup split-tx + AC-018-2-b race window check; CSRF gate per R6 | `replan-cleanup.test.ts` 6 vitest cases |
| FR-019 | routines/telegram-bot + executor's last step | direct Bot API; retry-with-backoff on rate-limit | vitest format match + retry path |
| FR-020 | rewrite .harness/init.sh + infra/vps/setup.sh | bash CI on clean Linux VM + LOUD failure mode | bash unit test |
| FR-021 | dashboard/api/cron/cap-rollup + Overview cap progress bar + Telegram alert | as proposed | vitest cap rollup + 12/14/15 alert tiers |

---

## Deliverables

### D1: [FR-001] Architecture-spike verification (M0)
- AC-001-2, AC-001-3, AC-001-4
- EC-001-2, EC-001-3, EC-001-4
- Output artefact: `docs/spike-report-fr-001.md` committed to repo; ADRs in `.harness/spec/architecture.md` updated if any assumption FAILED; `.harness/data/spike-fr-001-outcomes.json` committed (drives Tier 2 prompt-preserve conditional)
- **v1.1 retro note**: AC-001-1 (cap-exempt `/schedule` verification) and EC-001-1 (its FAIL-path edge case) DROPPED — no programmatic `claude /schedule` API exists. ADR-002 revised; Planner writes `pair_schedules` rows in `status='scheduled'` and the every-minute cron tick at `/api/cron/fire-due-executors` fires Executors via `/fire` API.

### D2: [FR-010] Subscription-only auth enforcement (M0 step 2 — gates every subsequent commit)
- AC-010-1, AC-010-2, AC-010-3, AC-010-4, AC-010-5
- EC-010-1
- **Pulled forward from M1 to M0 step 2 per Q1** so spike commits go through the no-API-key gate.

### D3: [FR-008] Postgres schema with multi-tenant tenant_id (M1)
- AC-008-1, AC-008-2, AC-008-3
- EC-008-1
- Round 2/3 schema deltas: `override_actions.success/before/after_state_json` nullable; `routine_runs.routine_name` enum gains `replan_orchestrator`; `telegram_interactions.command_parsed` enum gains `SYNTHETIC_PING`; new index `(tenant_id, replied_at DESC)` on `telegram_interactions`.

### D4: [FR-012] V1 pair list seed (M1)
- AC-012-1, AC-012-2, AC-012-3
- EC-012-1, EC-012-2

### D5: [FR-011] Pair config (M1)
- AC-011-1, AC-011-2, AC-011-3
- EC-011-1

### D6: [FR-009] Tailscale Funnel + app-layer bearer (M1) — per clarify Q2
- AC-009-1, AC-009-2, AC-009-3, AC-009-4
- EC-009-1, EC-009-2, EC-009-3

### D7: [FR-020] Initial setup script init.sh + VPS setup.sh (M1)
- AC-020-1, AC-020-2, AC-020-3
- EC-020-1

### D8: [FR-014] News fetch + markdown rendering port (M1)
- AC-014-1, AC-014-2, AC-014-3
- EC-014-1

### D9: [FR-007] Audit trail (M1 — must exist before any agent runs)
- AC-007-1, AC-007-2, AC-007-3, **AC-007-3-b** (NEW per R4), AC-007-4, AC-007-5
- EC-007-1, EC-007-2
- Includes `override-handler.ts` skeleton implementing R4's 7-step flow (used in M4 by FR-016).

### D10: [FR-002] Daily Planner Routine (M2)
- AC-002-1, **AC-002-1-b** (NEW per R1), AC-002-2, AC-002-3, AC-002-4
- EC-002-1, EC-002-2, EC-002-3 (covered by `replan-cleanup.test.ts` per R3)

### D11: [FR-003] Per-pair Executor Routines (M2)
- AC-003-1, **AC-003-1-b** (NEW per R1), AC-003-2, AC-003-3, AC-003-4, AC-003-5
- EC-003-1, EC-003-2, EC-003-3
- Includes pre-fire stale-check in first 20 lines of `executor.ts` (R3 — feeds AC-018-2-b)

### D12: [FR-013] compute_python MCP for Executor (M2) — CONDITIONAL
- AC-013-1, AC-013-2 (only if FR-013 builds)
- EC-013-1, EC-013-2
- **Conditional, gated on FR-001 AC-001-2 math-fidelity outcome** (per clarify Q8): if max relative error < 1e-3, FR-013 is SKIPPED in v1 and `decisions.md` records the skip + spike evidence; `fr-013-skip-marker.test.ts` asserts (a) decisions.md contains the FR-013-SKIPPED line, (b) executor connector list does NOT contain `compute_python`, (c) spike report shows max relative error < 1e-3. If FR-013 builds, the skip-marker test inverts.

### D13: [FR-019] Telegram outbound notifications (M2)
- AC-019-1, AC-019-2, AC-019-3
- EC-019-1
- **No queue table** — direct synchronous Telegram Bot API call from Executor's last step; 5s timeout; retry-with-backoff (3 attempts, exp, max 30s) on rate-limit.

### D14: [FR-006] Mission-control dashboard read-only (M3)
- AC-006-1, AC-006-2, AC-006-3 (overrides AC-006-4 deferred to D17; AC-006-5 deferred to D18)
- EC-006-1, EC-006-2
- Includes `lib/csrf.ts`, `app/api/csrf/route.ts`, `components/csrf-form.tsx` (R6) BEFORE first override route handler in M4.
- **Operator MUST have exported the Claude Design bundle to `design/dashboard-bundle/`** before this FR delivers Product Depth — if missing, the Generator scaffolds and `implementation-report.md` flags it; `impeccable` audit will surface the gap.

### D15: [FR-015] Trade history + report archive (M3)
- AC-015-1, AC-015-2
- EC-015-1

### D16: [FR-016] Override actions (M4)
- AC-016-1, **AC-016-1-b** (NEW per R6), AC-016-2, **AC-016-2-b** (NEW per R6), AC-016-3, **AC-016-3-b** (NEW per R6), AC-016-4
- EC-016-1
- Also closes AC-006-4 (override action handlers).
- Implements R4 7-step flow via `lib/override-handler.ts`; CSRF-gated via `validateCsrf()` in step 2.

### D17: [FR-017] Pause/Resume (M4)
- AC-017-1, AC-017-2, AC-017-3, AC-017-4
- EC-017-1
- CSRF-gated.

### D18: [FR-018] Force re-plan (M4)
- AC-018-1, AC-018-2, **AC-018-2-b** (NEW per R3), AC-018-3
- EC-018-1
- Also closes AC-006-5 (force re-plan handler).
- Uses **split-transaction flow** (R3-followup): Tx A (cancel + insert in-flight audit row) → external `/fire` POST OUTSIDE any tx → Tx B (settle audit row to `success=true|false`); bridged by `success=null` in-flight marker; orphan-detect cron picks up rows >5 min old.

### D19: [FR-004] Always-on Channels session (M4)
- AC-004-1, AC-004-2, AC-004-3, AC-004-4, AC-004-5, AC-004-6
- EC-004-1, EC-004-2, EC-004-3
- Note (per clarify Q1): AC-004-6 enforcement is via `tenants.allowed_telegram_user_ids` jsonb column populated by `infra/vps/setup.sh` from the `ALLOWED_TELEGRAM_USER_IDS` env var. Off-allowlist messages produce a `telegram_interactions` audit row with `command_parsed='REJECTED_NOT_ALLOWED'`. AC-004-3 system-prompt also includes the "yesterday's chat history is queryable from `telegram_interactions` via `mcp__postgres_query`" hint per clarify Q4.
- **Subagent Write scope NARROWED per R2**: subagent CANNOT write to `agents/` or `scripts/`; ONLY `work/**` is subagent-writable. `data/` is read-only via per-file allowlist.

### D20: [FR-005] Channels-session health check + crash recovery (M4)
- AC-005-1, AC-005-2, AC-005-3
- EC-005-1, EC-005-2
- Healthcheck signal source = `MAX(replied_at) FROM telegram_interactions` (R5); 30-min synthetic-ping cron as fallback for quiet periods (trigger source = GitHub Actions cron per AC-005-2 amendment, not Vercel cron — Vercel Hobby plan blocks sub-daily); 5-min cross-check cron also on GitHub Actions; restart-on-idle systemd timer per ADR-009; ADR-009's mute-marker is honored by the `/api/cron/channels-health` handler regardless of trigger source.

### D21: [FR-021] Daily cap monitoring + alerts (M5)
- AC-021-1, AC-021-2, AC-021-3, AC-021-4
- EC-021-1, EC-021-2

### D22: Design polish via `impeccable` (Generator-managed final pass)
- Run `impeccable` audit on the dashboard's deployed Vercel preview
- Address every Critical + High finding
- Document the audit + remediation in `implementation-report.md`

---

## Test Criteria (flat list for Evaluator in EVALUATE mode)

Every AC and EC from the FRs above. The Evaluator reads these directly. **Five new ACs** added during negotiation are bolded.

- [ ] AC-001-2 through AC-001-4 (FR-001) — AC-001-1 DROPPED in v1.1 per ADR-002 revised
- [ ] EC-001-2 through EC-001-4 (FR-001) — EC-001-1 DROPPED in v1.1 (was the AC-001-1 FAIL-path edge case)
- [ ] AC-002-1 (FR-002)
- [ ] **AC-002-1-b — Tier 2 deployed-side prompt-preservation for Planner: vitest reads `.harness/data/spike-fr-001-outcomes.json`; if `deployed_prompt_endpoint != null`, fetches the live Planner system prompt and byte-compares against `.harness/spec/preserve/planner-systemprompt.md`. If endpoint unavailable, test SKIPS and `implementation-report.md` flags constitution §2 verification as file-side only + manual screenshot+diff in operator's pre-deploy checklist (`docs/operator-pre-deploy-checklist.md`).** (NEW per R1)
- [ ] AC-002-2 (FR-002)
- [ ] AC-002-3 (FR-002)
- [ ] AC-002-4 (FR-002)
- [ ] EC-002-1 through EC-002-3 (FR-002)
- [ ] AC-003-1 (FR-003)
- [ ] **AC-003-1-b — Tier 2 deployed-side prompt-preservation for Executor (Spartan): same wording as AC-002-1-b applied to `spartan-systemprompt.md`. Tier 1 (file-side, AC-003-1) ALWAYS runs; Tier 2 conditional on Spike 3 outcome.** (NEW per R1)
- [ ] AC-003-2 (FR-003)
- [ ] AC-003-3 (FR-003)
- [ ] AC-003-4 (FR-003)
- [ ] AC-003-5 (FR-003)
- [ ] EC-003-1 through EC-003-3 (FR-003)
- [ ] AC-004-1 through AC-004-6 (FR-004)
- [ ] EC-004-1 through EC-004-3 (FR-004)
- [ ] AC-005-1 through AC-005-3 (FR-005)
- [ ] EC-005-1 through EC-005-2 (FR-005)
- [ ] AC-006-1 through AC-006-5 (FR-006)
- [ ] EC-006-1 through EC-006-2 (FR-006)
- [ ] AC-007-1 (FR-007)
- [ ] AC-007-2 (FR-007)
- [ ] AC-007-3 (FR-007)
- [ ] **AC-007-3-b — Every override action's `before_state_json` is the result of a server-side MT5 REST read performed BEFORE any state-mutating call. Test (Playwright `overrides-atomicity.spec.ts`): mocks MT5 to return state X on the read, succeeds on the write; asserts `override_actions.before_state_json` deserializes to X. Variant: mocks MT5 to return state X but FAIL the write; asserts `before_state_json=X`, `success=false`, no Telegram fired, `after_state_json=last-known`. Fault-injection coverage at all four boundaries (MT5 read fail, audit insert fail, MT5 write fail, audit update fail) per R4's 7-step flow.** (NEW per R4)
- [ ] AC-007-4 (FR-007)
- [ ] AC-007-5 (FR-007)
- [ ] EC-007-1 through EC-007-2 (FR-007)
- [ ] AC-008-1 through AC-008-3 (FR-008)
- [ ] EC-008-1 (FR-008)
- [ ] AC-009-1 through AC-009-4 (FR-009)
- [ ] EC-009-1 through EC-009-3 (FR-009)
- [ ] AC-010-1 through AC-010-5 (FR-010)
- [ ] EC-010-1 (FR-010)
- [ ] AC-011-1 through AC-011-3 (FR-011)
- [ ] EC-011-1 (FR-011)
- [ ] AC-012-1 through AC-012-3 (FR-012)
- [ ] EC-012-1 through EC-012-2 (FR-012)
- [ ] AC-013-1 through AC-013-2 (FR-013) — CONDITIONAL; if SKIPPED, `fr-013-skip-marker.test.ts` asserts the skip evidence
- [ ] EC-013-1 through EC-013-2 (FR-013)
- [ ] AC-014-1 through AC-014-3 (FR-014)
- [ ] EC-014-1 (FR-014)
- [ ] AC-015-1 through AC-015-2 (FR-015)
- [ ] EC-015-1 (FR-015)
- [ ] AC-016-1 (FR-016)
- [ ] **AC-016-1-b — `/api/overrides/close-pair` POST without a CSRF token returns 403 with NO MT5 mock call and NO audit row inserted; with a valid token (round-tripped via `GET /api/csrf` + `validateCsrf`) returns 200. Algorithm-pinning: unit test (`csrf.test.ts`) explicitly REJECTS the Round 2 broken concat-hash signature AND a wrong-secret HMAC, pinning the primitive to HMAC-SHA256(AUTH_SECRET, token). Tests cover missing cookie, wrong secret, mismatched submitted-token-vs-cookie-token.** (NEW per R6)
- [ ] AC-016-2 (FR-016)
- [ ] **AC-016-2-b — Same CSRF rejection coverage as AC-016-1-b applied to `/api/overrides/close-all` POST.** (NEW per R6)
- [ ] AC-016-3 (FR-016)
- [ ] **AC-016-3-b — Same CSRF rejection coverage as AC-016-1-b applied to `/api/overrides/edit-position` POST.** (NEW per R6)
- [ ] AC-016-4 (FR-016)
- [ ] EC-016-1 (FR-016)
- [ ] AC-017-1 through AC-017-4 (FR-017)
- [ ] EC-017-1 (FR-017)
- [ ] AC-018-1 (FR-018)
- [ ] AC-018-2 (FR-018)
- [ ] **AC-018-2-b — A one-off Executor scheduled to fire DURING the re-plan cleanup gap (between Tx A committing and Tx B settling, OR between cancel-and-fire-Planner) noops via the Executor's first-20-lines pre-fire stale-check: writes a `routine_runs` end-row with `output_json.reason === "stale-plan-noop"` BEFORE any MT5 call. Test (`replan-cleanup.test.ts` cases 2 + 3): pre-state has 1 `pair_schedules` row in `status='cancelled'` OR with `scheduled_one_off_id` ≠ executor's `$ANTHROPIC_ONE_OFF_ID`; call `executor.start()` with mocked MT5; assert zero MT5 mock calls AND `routine_runs` row written with reason='stale-plan-noop'.** (NEW per R3)
- [ ] AC-018-3 (FR-018)
- [ ] EC-018-1 (FR-018)
- [ ] AC-019-1 through AC-019-3 (FR-019)
- [ ] EC-019-1 (FR-019)
- [ ] AC-020-1 through AC-020-3 (FR-020)
- [ ] EC-020-1 (FR-020)
- [ ] AC-021-1 through AC-021-4 (FR-021)
- [ ] EC-021-1 through EC-021-2 (FR-021)

---

## Build Order (technical dependency order — REPLACES draft contract's "Suggested Build Order")

Same milestone groupings as the original brainstorm; minor reorderings within milestones for technical deps. Round 1 changes: **FR-010 pulled forward from M1 step 2 to M0 step 2 (per Q1)** so the no-API-key pre-commit gate exists BEFORE any spike code commits. Round 2 changes: CSRF helper (`lib/csrf.ts`) added in M3 step 17 BEFORE the first override route handler in M4; `replan-cleanup` ordering encoded into FR-002 step 13 before FR-018 step 22.

**M0 — Architecture spike (must run before anything else is built)**
1. Workspace scaffolding: root `package.json` workspaces, `bun install`, `tsconfig.base.json`, `biome.json`, `.lefthook.yml`, `Makefile` skeleton.
2. **FR-010** (per Q1 — pulled forward from M1). Pre-commit + `make audit-no-api-key` + gitleaks + CI lint must exist BEFORE any spike code commits.
3. **FR-001** spikes 1-4 in sequence over 24-48h elapsed time. Spike 3 ALSO records `deployed_prompt_endpoint` outcome (R1). Spike report committed.
4. Mid-spike: ADR updates if any spike PARTIAL/FAIL.

**M1 — Foundation: data + secrets + tunnel**
5. **FR-008** Postgres schema + migrations + tenant-scoped client (Round 2/3 deltas: `override_actions` nullability per R4, `command_parsed` enum gains `SYNTHETIC_PING` per R5, `routine_name` enum gains `replan_orchestrator` per R3, `telegram_interactions(tenant_id, replied_at)` index per R5).
6. **FR-008** `tenant-id-lint.ts` + raw-SQL-allowlist file (Q3).
7. **FR-012** seed migration.
8. **FR-011** pair-config query helpers.
9. **FR-009** Tailscale Funnel + nginx bearer-proxy + systemd units.
10. **FR-020** `init.sh` full rewrite + `infra/vps/setup.sh`.
11. **FR-014** news-fetch port.
12. **FR-007** audit-or-abort module + tests + `override-handler.ts` skeleton implementing R4's 7-step flow (handler used in M4).

**M2 — Trading core**
13. **FR-002** Planner routine TS body + prompt-loader + (R3) Executor pre-fire stale-check helper used by FR-003. (No schedule-fire selector — the cron tick at `/api/cron/fire-due-executors` is the sole fire path under v1.1 ADR-002 revised.)
14. **FR-003** Executor routine TS body + XAU/USD hard test + report-upload + (R3) pre-fire stale-check wired in.
15. **FR-013** CONDITIONAL — only if FR-001 AC-001-2 math-fidelity max relative error ≥ 1e-3 OR Opus refuses to compute.
16. **FR-019** telegram-bot direct API.

**M3 — Dashboard read-only**
17. **FR-006** scaffold (Auth.js + Drizzle adapter + middleware + 5 screens read-only) + (R6) `lib/csrf.ts` + `app/api/csrf/route.ts` + `components/csrf-form.tsx`.
18. **FR-006** AC-006-2 5 core screens.
19. **FR-015** signed-URL minting + History view.

**M4 — Dashboard overrides + Telegram polish**
20. **FR-016** override action handlers (R4 7-step flow) + atomicity tests + (R6) CSRF tests.
21. **FR-017** pause/resume (CSRF-gated).
22. **FR-018** force re-plan (R3 cleanup-flow ordering + R3-followup split-tx + AC-018-2-b race window).
23. **FR-004** Channels-session subagent + scripts + systemd unit + setup.sh additions; subagent yaml uses NARROWED Write allowlist (R2).
24. **FR-005** healthcheck endpoint querying `MAX(replied_at)` (R5) + Vercel cron + synthetic-ping cron + out-of-band alert + recovery hint + restart-on-idle systemd timer.

**M5 — Hardening + observability**
25. **FR-021** cap-monitoring cron + dashboard progress bar + Telegram alerts.

**Final pass — design polish (Generator-managed)**
26. Generator invokes the `impeccable` skill on the dashboard's deployed Vercel preview for a design audit + polish pass before evaluation. Findings addressed in the same build cycle.

---

## NFRs to Verify

- **NFR-001** (≥99.5% scheduled fires execute) — measure across the staging spike runs in M0; Evaluator runs a stub end-to-end (5 one-offs spaced 1 min apart, all succeed within tolerance).
- **NFR-002** (Telegram p95 ≤ 3s) — measure via `telegram_interactions.received_at`/`replied_at` columns in 24h staging soak; production rolling-NFR view (Q5).
- **NFR-003** (dashboard live ≤ 6s p95) — Playwright synthetic: trigger MT5 state change, measure time-to-DOM.
- **NFR-004** (audit completeness, 100%) — daily orphan-detection cron query returns 0; ALSO catches R4 step (d) "audit UPDATE failed" edge AND R3-followup Tx B failure edge (orphan in `success=null` state surfaces here).
- **NFR-005** (no `ANTHROPIC_API_KEY` anywhere) — `make audit-no-api-key` exits 0; gitleaks no findings; lefthook + CI.
- **NFR-006** (token budget ≤80% Max 20x weekly) — read from Anthropic `/usage` (or scrape per ADR-008) at end of 24h soak; FR-001 AC-001-4 spike + ongoing weekly cron post-FR-021.
- **NFR-007** (override atomicity) — Playwright fault-injection at **4 distinct boundaries** (R4): MT5 read fail, audit insert fail, MT5 write fail, audit update fail. Each asserts the exact recovery state per the 7-step flow.
- **NFR-008** (TZ correctness) — DST-day test passes (frozen at March 30, 2026 + October 26, 2026).
- **NFR-009** (auth on every dashboard route) — Playwright route-enumeration test hits every route un-authed; all return 401/redirect.
- **NFR-010** (constitution compliance) — `/harness:analyze` constitutional-coverage check.

---

## Setup required (operator manual steps before BUILD can run)

These external-system setup steps cannot be automated by the Generator and MUST be completed by the operator before BUILD begins. The Generator's `bash .harness/init.sh` will check each and exit non-zero with explicit guidance if anything is missing. Place actual values in `.env.local` (gitignored); the Generator will produce `.env.example` with `REPLACE_ME` placeholders and instructions in `implementation-report.md`.

### 1. Tailscale account + tailnet
- Create a Tailscale account if you don't have one (https://login.tailscale.com).
- Create a tailnet for the deployment (or reuse an existing one).
- Obtain a **Tailscale auth key** with `--ephemeral=false --reusable=false --tags=tag:caishen-vps` (issued from the admin console: Settings → Keys → Generate auth key).
- Enable **Funnel** for your tailnet (Settings → Funnel → enable, then approve the `tag:caishen-vps` tag).
- Reserve the public hostname (e.g., `caishen-vps.<your-tailnet>.ts.net`) — the Generator's `infra/vps/setup.sh` will register this with `tailscale funnel`.
- Env vars to populate: `TAILSCALE_AUTH_KEY`, `TAILSCALE_FUNNEL_HOSTNAME`.

### 2. Telegram bot creation
- Open Telegram and message **@BotFather**.
- Send `/newbot`; pick a name (e.g., `财神爷 Trading Assistant`) and a unique username ending in `bot` (e.g., `caishen_trader_bot`).
- BotFather returns the **bot token** — copy it.
- Send `/setprivacy` to BotFather, choose your bot, set privacy mode to `Disable` so the bot can read all messages in groups (only matters if you'll use a group; default DM works either way).
- (Optional) Set a profile photo via `/setuserpic`.
- Get your own **Telegram user ID** by messaging `@userinfobot` — record this number for the allowlist.
- Env vars to populate: `TELEGRAM_BOT_TOKEN`, `ALLOWED_TELEGRAM_USER_IDS` (JSON array of integers, e.g., `[123456789]`).
- Optional debug-channel ID for the synthetic-ping fallback: create a private channel, add the bot as admin, capture its chat ID via `getUpdates`. Env var: `TELEGRAM_DEBUG_CHANNEL_ID`.

### 3. Vercel account + project
- Create a Vercel account (https://vercel.com) if you don't have one.
- Create a new Vercel project linked to this repo (the Generator will run `vercel link` during BUILD; you only need the account to exist).
- Issue a **Vercel API token** (Account Settings → Tokens → Create) — only needed if you want CI to deploy automatically; otherwise BUILD will use `vercel deploy` interactively.
- Add a **Vercel Postgres** integration (Marketplace → Postgres → Neon) OR provision your own Postgres 16 — the Generator needs `DATABASE_URL` either way.
- Provision **Vercel Blob** storage (Marketplace → Blob) for executor reports — the Generator needs `BLOB_READ_WRITE_TOKEN`.
- Generate a **CRON_SECRET** (any high-entropy random string ≥ 32 bytes hex) for the cron route handlers.
- Env vars to populate (Vercel project): `VERCEL_TOKEN` (optional CI-only), `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, `CRON_SECRET`.
- **Vercel plan**: Hobby (free) is sufficient. The two sub-daily crons (5-min `channels-health` and 30-min `synthetic-ping`) are NOT on Vercel — they are fired by GitHub Actions cron per AC-005-2 amendment, because Hobby plan blocks sub-daily Vercel crons. Daily crons (`orphan-detect`, `audit-archive`, `cap-rollup`, conditional `usage-reconcile`) DO run on Vercel and are Hobby-compatible.

#### 3a. GitHub repo Secrets (NEW — required by AC-005-2 amendment)
- The same `CRON_SECRET` value generated above MUST also be added as a GitHub repo Secret so the GitHub Actions cron workflows can authorize against the Vercel handlers: GitHub repo → Settings → Secrets and variables → Actions → New repository secret → name `CRON_SECRET`, value = same string as in Vercel env.
- Optionally add `VERCEL_DEPLOYMENT_URL` as a second secret (e.g., `https://caishen-v2.vercel.app`) so the workflow YAML doesn't hardcode the URL; otherwise the workflow YAML hardcodes it.
- **Jitter acknowledgement**: GitHub Actions cron has documented up-to-15-min scheduling jitter (high-load Actions queues can delay scheduled workflows). The 10-min unhealthy threshold for AC-005-2 absorbs this for `channels-health`; the 30-min synthetic-ping cadence with the ~45-min freshness window in AC-005-1 absorbs it for `synthetic-ping`. No additional mitigation needed.

### 4. Anthropic Routines + Channels access
- Confirm your Anthropic Console plan includes **Routines (beta)** and **Channels** access. If not, request access (https://www.anthropic.com/console).
- In the console, create a project named `caishen` (or similar) — this is the project that will own the Routines and Channels session.
- For each routine the Generator will create (`caishen-planner`, `caishen-executor-{pair}`, `caishen-spike-noop` for FR-001 Spike 3), capture the **routine_id** and **routine bearer token** AFTER the Generator creates them — these are not pre-create operator steps, but you must be available during BUILD step M2-13/14 to copy these from the Anthropic console into `.env.local`.
- Pin the beta header: `ROUTINE_BETA_HEADER=experimental-cc-routine-2026-04-01` (the Generator will codify this in `.env.example`).
- Confirm Channels session can be deployed to your VPS via `claude channels start` — this requires the Claude Code CLI logged into your Anthropic account (no API key per FR-010; subscription auth only).
- Env vars to populate (post-routine-creation, mid-BUILD): `PLANNER_ROUTINE_ID`, `PLANNER_ROUTINE_BEARER`, `EXECUTOR_ROUTINE_IDS` (JSON map), `EXECUTOR_ROUTINE_BEARERS` (JSON map keyed same as the IDs map), `ROUTINE_BETA_HEADER`.

### 5. MT5 + ForexFactory connectivity
- Confirm the operator's existing MT5 REST endpoint is reachable on the VPS (the Generator's `init.sh` will smoke-test).
- Generate a **bearer token** for the nginx bearer-proxy that fronts MT5 REST (any high-entropy random string ≥ 32 bytes hex).
- Confirm ForexFactory MCP credentials are available (existing connector — reuse from n8n workflow).
- Env vars to populate: `MT5_BASE_URL` (Tailscale Funnel URL once set up), `MT5_BEARER_TOKEN`, `FFCAL_*` (existing).

### 6. Auth.js + dashboard
- Generate **AUTH_SECRET** (random string ≥ 32 bytes hex) for Auth.js cookie encryption AND for the R6 CSRF HMAC key.
- Generate **INITIAL_REGISTRATION_TOKEN** (one-time, high-entropy random string) for the first passkey enrollment.
- Env vars to populate: `AUTH_SECRET`, `INITIAL_REGISTRATION_TOKEN`, `AUTH_URL` (Vercel preview URL once first deploy completes).

### 7. Claude Design bundle (for FR-006 Product Depth)
- Run the Claude Design tool to produce a dashboard design bundle (the operator's separate creative session — outside this BUILD).
- Export the bundle to `design/dashboard-bundle/` in the repo root.
- If the bundle is large, the Generator will gitignore the binary asset directories but commit the JSON/CSS spec files.
- If this is missing at BUILD time, the Generator scaffolds the dashboard with default shadcn styling and `implementation-report.md` flags Product Depth as degraded; the `impeccable` audit pass surfaces the gap. Operator can re-run BUILD after exporting the bundle, or accept the degraded result.

### 8. Local dev prerequisites
- **Node 20+** installed (the Generator uses Bun, but some tooling fallbacks need Node).
- **Bun** installed (`curl -fsSL https://bun.sh/install | bash`); pinned version will appear in `package.json → packageManager`.
- **Docker** for local Postgres (used by `infra/local/docker-compose.yml`).
- **Git** ≥ 2.40 with `git worktree` support.

The Generator's `bash .harness/init.sh` (after FR-020 completes) will check each of the above and exit non-zero with copy-paste install/setup commands for whatever is missing. **Do not start BUILD with anything unresolved** — the LOUD failure mode (per AC-020-3) is intentional.

---

## Definition of Done

- All ACs above pass via the relevant test surface (vitest for unit, Playwright for E2E, manual or scripted for VPS-side).
- All ECs above either have a coded response that's been exercised OR are explicitly marked NOT REACHABLE in this build (with a written reason in `implementation-report.md`).
- All NFRs measured and documented in `implementation-report.md` with evidence.
- All 17 constitution principles respected — Code Quality 8/10 threshold means each principle has a concrete code/test guard, not just a doc rule.
- Test Coverage 7/10 means TDD evidence in git log (RED → GREEN → REFACTOR commits per FR), every FR has a vitest test, every UJ has a Playwright test, no `.skip`/`.todo` left in scope.
- Functionality 8/10 means the three LOAD-BEARING ASSUMPTIONS were verified and any failure produced a coded fallback per the FR-001 ECs — no "TODO verify" in committed code. (The original fourth assumption — cap-exempt `/schedule`-from-inside-a-routine — was DROPPED in v1.1 per ADR-002 revised, since no programmatic `claude /schedule` API exists.)
- Product Depth 7/10 means `frontend-design` consumed the `design/dashboard-bundle/` (or, if the operator hasn't exported it, the build is explicitly degraded with a callout in `implementation-report.md`), `impeccable` audit ran and findings addressed, the dashboard does not look like a default shadcn template, the Telegram session feels like a senior trader's assistant.
- All builds pass `bash .harness/init.sh` (constitution §15 — pre-flight cleanness, exit 0).
- Pre-commit hook actually rejects a commit containing literal `ANTHROPIC_API_KEY` (negative test in CI).
- The deployed Vercel preview is reachable; Auth.js login flow works end-to-end.
- The Channels session on the operator's VPS is `active (running)` and responds to a synthetic `/status` Telegram message within 3s.
- Audit trail spot-check: pick one routine run from the spike, navigate from Postgres → `claude_code_session_url` → see the full session.
- `implementation-report.md` documents: which spike outcomes (FR-001 AC-001-2 through AC-001-4) were PASS vs PARTIAL vs FAIL (AC-001-1 dropped in v1.1 per ADR-002 revised), what fallback path was taken in each PARTIAL/FAIL case, every silent-default override the operator made between PLAN and BUILD, AND for the new ACs (AC-002-1-b, AC-003-1-b): whether Tier 2 deployed-side prompt-preservation is RUNNING (Spike 3 found endpoint) or SKIPPED (operator pre-deploy checklist used instead).
