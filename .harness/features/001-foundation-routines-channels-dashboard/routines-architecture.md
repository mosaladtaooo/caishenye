# Routines Architecture under Vercel-Proxy Pattern (ADR-012)

**Status**: Authoritative design for the Path B implementation chosen in ADR-012.
**Audience**: future Generators, Evaluators, the operator, and Claude itself when running inside a Routine.
**Cross-references**: ADR-012 (the choice), `contract.md` D10/D11/D6/D9 (deliverables), `operator-instructions-routines.md` (operator setup), `.harness/spec/preserve/{planner,spartan}-systemprompt.md` (constitution §2 verbatim prompts), `.harness/spec/preserve/{planner,spartan}-systemprompt-vercel-proxy.md` (proxy-pattern overlays — same prompts plus a "Tools available" appendix).

---

## 1. Why this document exists

Sessions 1-4 of the Generator built `packages/routines/src/{planner,executor,spike}/*.ts` assuming each Routine would run those TS files inside the Anthropic Routine sandbox with full env-var access. Session 5d's UI inspection of the actual Routine product invalidated that assumption (ADR-012). This document is the authoritative replacement narrative — it describes what the Planner Routine and the Executor Routine actually do, end to end, under the Vercel-proxy pattern.

The TS modules in `packages/routines/src/` remain useful as: (a) reference implementations the future Generator can port logic from, (b) targets for offline unit tests that exercise the pure functions, (c) one-shot scripts the operator could `bun run` locally for ad-hoc testing. They are NOT executed by the Routines at runtime under Path B.

---

## 2. The proxy pattern in one diagram

```
┌──────────────────────────────────────────┐
│  Anthropic Routine sandbox               │
│                                          │
│  Claude (Sonnet 4.6 / Opus 4.7-1m)       │
│  ├─ system prompt = preserve/*-vercel    │
│  │      -proxy.md                        │
│  ├─ user message = trigger payload       │
│  ├─ env: { INTERNAL_API_TOKEN,           │
│  │         VERCEL_BASE_URL,              │
│  │         DEFAULT_TENANT_ID }           │
│  └─ tools: Bash + (optional connectors)  │
│                                          │
│       │ Bash + curl with Bearer          │
│       ▼                                  │
└──────────────────────────────────────────┘
              HTTPS
              │
              ▼
┌──────────────────────────────────────────┐
│  Vercel function (caishen-v2.app)        │
│  /api/internal/* — proxy gateway         │
│  ┌────────────────────────────────────┐  │
│  │ validateInternalAuth(req)          │  │
│  │   ↳ Bearer check (timing-safe)     │  │
│  │   ↳ INTERNAL_API_TOKEN env         │  │
│  └────────────────────────────────────┘  │
│                                          │
│  Real env vars live HERE, in Vercel:     │
│    DATABASE_URL, MT5_BASE_URL,           │
│    MT5_BEARER_TOKEN, FFCAL_BASE_URL,     │
│    FFCAL_BEARER_TOKEN, BLOB_READ_WRITE,  │
│    TELEGRAM_BOT_TOKEN, PLANNER_ROUTINE_  │
│    *, EXECUTOR_ROUTINE_*, etc.           │
└──────────────────────────────────────────┘
              │ HTTPS / pg / etc
              ▼
   Postgres (Neon)   MT5 REST (Tailscale)   FFCal MCP   Telegram   Anthropic /fire
```

**The single new credential is `INTERNAL_API_TOKEN`**, a 32-byte random hex string the operator generates locally and provisions in three places:
1. `.env.local` at project root (developer tooling — never chat-pasted).
2. Vercel project env at `production` scope (so route handlers see it).
3. Each Routine's Cloud Env env-vars section (so Claude in the Routine can include it as the Bearer in curl calls).

Defense in depth: a Routine session never sees `DATABASE_URL`, `MT5_BEARER_TOKEN`, `FFCAL_BEARER_TOKEN`, `TELEGRAM_BOT_TOKEN`, etc. Compromising the Routine's session log only leaks `INTERNAL_API_TOKEN`, which authorises the proxy gateway and nothing else. Rotation is a single env edit.

---

## 3. Authentication contract

All `/api/internal/*` routes share one auth shape, mirroring `cron-auth.ts`:

```
Authorization: Bearer ${INTERNAL_API_TOKEN}
```

Behaviour matrix (every internal route):

| Condition | HTTP | Body |
|---|---|---|
| `INTERNAL_API_TOKEN` env missing or empty | 500 | `{"error":"server misconfigured: INTERNAL_API_TOKEN missing"}` |
| `Authorization` header missing | 401 | `{"error":"unauthorized: missing bearer"}` |
| Bearer length differs from expected | 401 | `{"error":"unauthorized: bearer length mismatch"}` |
| Bearer differs (timing-safe) | 401 | `{"error":"unauthorized: bearer mismatch"}` |
| Bearer matches | 200 | route-specific body |

The 500-on-missing-env follows constitution §15 LOUD-failure (operator must SEE the misconfiguration; silently returning 401 would mask the gap).

---

## 4. Endpoints catalogue

All routes live under `packages/dashboard/app/api/internal/`. Each route file is small (under 80 lines), exports `GET` or `POST` (or both where the operation requires it), and calls `validateInternalAuth(req)` as its first step. Endpoint surface area is intentionally minimal — only what the Planner and Executor system prompts need.

### 4.1 `POST /api/internal/postgres/query`

The most security-critical route. Exposes a tightly-scoped allow-list of named queries rather than raw SQL — this prevents Routine prompt-injection from issuing destructive statements (`DROP`, `TRUNCATE`, `DELETE` without a tenant filter, etc.).

**Request body**:
```json
{
  "name": "insert_pair_schedule" | "select_pair_schedules_today" | ...,
  "params": { ... query-specific named parameters ... }
}
```

**Allow-list (initial set; expand only when contract requires)**:
| `name` | What it does |
|---|---|
| `select_active_pairs` | Read `pair_configs WHERE active_bool=true AND tenant_id=$1`. Replaces the planner's direct `getActivePairs()` call. |
| `select_pair_schedules_today` | Read `pair_schedules WHERE date = CURRENT_DATE GMT AND tenant_id=$1`. Used by Planner to detect re-plan, by Executor to read its own row. |
| `insert_pair_schedule` | Insert one `pair_schedules` row (Planner uses 2N times — N pairs × 2 sessions). All FKs validated; `tenant_id` injected from the request, never from the body. |
| `cancel_pair_schedules_today` | `UPDATE pair_schedules SET status='cancelled' WHERE date = CURRENT_DATE AND status='scheduled' AND tenant_id=$1`. Used during re-plan cleanup. |
| `update_pair_schedule_one_off_id` | After Planner's nested /fire of an Executor, capture the returned `one_off_id` on the schedule row. |
| `select_open_orders_for_pair` | Read `orders WHERE pair_code=$1 AND status='open' AND tenant_id=$2`. Executor pre-fire stale-check + position sizing. |
| `insert_executor_report` | Write `executor_reports` row at end of Executor session (FR-015). |
| `select_recent_telegram_interactions` | Channels session "what did I say yesterday?" lookup (clarify Q4). Read-only; bounded by `LIMIT 50` server-side. |

**Each named query is implemented by a small Drizzle wrapper inside `lib/internal-postgres-queries.ts`.** No raw SQL accepted from the body. If a future Routine needs a query not in the allow-list, the Generator adds it to the allow-list explicitly — that's a proper amendment, not a free-form escape hatch.

**Tenant scoping**: every query reads `tenant_id` from the request body's `tenantId` field. The route layer enforces `tenantId === DEFAULT_TENANT_ID` (i.e., `1` for v1) before dispatching. Once we onboard tenant 2+, the route layer does the multi-tenant resolution from the operator-issued `INTERNAL_API_TOKEN` (token-per-tenant model), but for v1 it's simpler to hard-pin to tenant 1.

**Response**: `{ "rows": [...] }` for SELECT; `{ "rowsAffected": N, "returning": [...] }` for INSERT/UPDATE.

### 4.2 `GET /api/internal/mt5/account`

Forwards to `${MT5_BASE_URL}/account` with `Authorization: Bearer ${MT5_BEARER_TOKEN}`. Re-uses `mt5-server.ts` `mt5Get('/account')`. Returns the upstream JSON verbatim.

### 4.3 `GET /api/internal/mt5/positions`

Forwards to `${MT5_BASE_URL}/positions`. Same pattern.

### 4.4 `POST /api/internal/mt5/orders`

**Request body**: `{ symbol, side, volume, sl?, tp?, comment? }`. Forwards to `${MT5_BASE_URL}/orders`. Body schema strict: rejects extra fields (defence against prompt-injection that tries to slip through unknown payload).

### 4.5 `GET /api/internal/mt5/candles`

**Query params**: `?symbol=XAUUSD&timeframe=H4&count=180`. Forwards to `${MT5_BASE_URL}/candles?...`. Validates `count <= 500` server-side (Vercel function has a request-deadline; runaway counts are denied early). Validates `timeframe` against the n8n-canonical list `["M1","M5","M15","M30","H1","H4","D1","W1","MN1"]` — anything else is 400.

**Vercel deadline note**: Hobby's default function timeout is 10 s; a 500-bar fetch from MT5 over Tailscale Funnel can hover near that. If we observe intermittent 504s on `count >= 250`, split into two routes: `/mt5/candles-fast` (count <= 100, sub-second) vs `/mt5/candles-bulk` (count up to 500, with `maxDuration: 60` set in the route config — Hobby allows up to 60 s for individual functions when explicitly requested).

### 4.6 `GET /api/internal/ffcal/today`

Forwards to `${FFCAL_BASE_URL}/today` with `Authorization: Bearer ${FFCAL_BEARER_TOKEN}`. Returns the upstream JSON. Used by Planner.

### 4.7 `POST /api/internal/blob/upload`

**Request body**: `{ filename, html }`. Uses `@vercel/blob` SDK (`put(filename, html, { access: 'public', token: BLOB_READ_WRITE_TOKEN })`). Returns `{ "url": "...vercel-storage.com/..." }`. Used by Executor to upload its session HTML report (FR-015).

`filename` is server-side-prefixed with `executor-reports/${tenantId}/${YYYY-MM-DD}/` — the Routine's body provides only the basename. Prevents path traversal.

### 4.8 `POST /api/internal/telegram/send`

**Request body**: `{ chat_id, text }`. Wraps direct Bot API call to `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`. The route validates `chat_id` is in the operator's allowlist (read from `tenants.allowed_telegram_user_ids`) — defence against a compromised Routine spamming arbitrary chat IDs. Returns `{ "ok": true, "telegramMessageId": N }`.

### 4.9 `POST /api/internal/anthropic/fire`

**Request body**: `{ "routine": "executor", "body": { ... } }`. Looks up the bearer + routine_id from env (`EXECUTOR_ROUTINE_BEARERS` JSON keyed by `routine`, `EXECUTOR_ROUTINE_IDS` likewise). Calls `https://api.anthropic.com/v1/routines/${id}/fire` with the appropriate headers (`anthropic-beta: experimental-cc-routine-2026-04-01`, `anthropic-version: 2023-06-01`). Returns `{ "ok": true, "anthropicOneOffId": "...", "claudeCodeSessionId": "..." }`.

Used by Planner to fire per-pair Executors after building the schedule. Distinct from the existing `firePlannerRoutine` in `replan-flow.ts` which is invoked by the dashboard's `/api/overrides/replan` route — that path stays unchanged.

### 4.10 `POST /api/internal/anthropic/schedule`

**Request body**: `{ "routine": "executor", "fire_at_iso": "2026-05-04T13:30:00Z", "body": { ... } }`. Calls `https://api.anthropic.com/v1/routines/${id}/schedule` instead of /fire — used by Planner to schedule a one-off Executor at a future time (the Step-In moment for a market session). Returns `{ "ok": true, "scheduledOneOffId": "..." }`.

---

## 5. Planner Routine flow (FR-002)

The Planner Routine is a Sonnet 4.6 routine fired once per weekday morning at 04:00 GMT (recurring) and on-demand via the dashboard's "Force re-plan" button (one-off via `/v1/routines/${id}/fire`).

### 5.1 Inputs available inside the routine
- **System prompt**: `.harness/spec/preserve/planner-systemprompt-vercel-proxy.md` (verbatim original prompt + Tools-available appendix).
- **User message**: `Time Now: ${NOW_GMT}\nNews count:${NEWS_COUNT}\n${NEWS_MARKDOWN}` — the planner template from the original n8n workflow. Constructed by the proxy at fire time (the dashboard's `/api/internal/anthropic/fire` route assembles the body before forwarding).
- **Env**: `INTERNAL_API_TOKEN`, `VERCEL_BASE_URL`, `DEFAULT_TENANT_ID=1`.
- **Tools**: Bash (for curl), optionally a ForexFactory MCP connector (see § 7).

### 5.2 Numbered call flow

1. Claude reads its system prompt — the Tools-available appendix tells it the URLs and Bearer.
2. Claude calls `GET ${VERCEL_BASE_URL}/api/internal/ffcal/today` via Bash+curl. Receives the calendar JSON.
3. Claude calls `POST ${VERCEL_BASE_URL}/api/internal/postgres/query` with `{ name: "select_active_pairs", params: { tenantId: 1 } }`. Receives the active pairs.
4. Claude reasons over the calendar + the user-message news and produces the `output.sessions` JSON shape mandated by constitution §2 (see `planner-systemprompt.md` § OUTPUT). For each pair in the active list, Claude has decided: London-session step-in/step-out times (or empty if no-trade), New-York-session step-in/step-out times.
5. For each `(pair, session)` decision, Claude calls `POST ${VERCEL_BASE_URL}/api/internal/postgres/query` with `{ name: "insert_pair_schedule", params: { tenantId: 1, pairCode, date, sessionName, startTimeGmt, endTimeGmt, status: "scheduled" } }`. Captures the returned `id`.
6. For each non-empty schedule (i.e., where `startTimeGmt` is set), Claude calls `POST ${VERCEL_BASE_URL}/api/internal/anthropic/schedule` with `{ routine: pairCode, fire_at_iso: startTimeGmt, body: { pair_schedule_id: id } }`. Captures the returned `scheduledOneOffId`.
7. Claude calls `POST ${VERCEL_BASE_URL}/api/internal/postgres/query` with `{ name: "update_pair_schedule_one_off_id", params: { id, scheduledOneOffId } }`. Persists the binding.
8. Claude calls `POST ${VERCEL_BASE_URL}/api/internal/telegram/send` with the daily digest message (`"Today's plan: 4 pairs × 2 sessions, 6 trade windows scheduled..."`). Goes to every allowed Telegram user.
9. Claude exits 0.

### 5.3 Audit-or-abort discipline

Per constitution §3, the Planner MUST write a `routine_runs` row BEFORE any external tool call. Under Path B, that row is written by the Vercel-side `/api/internal/anthropic/fire` route handler when the Planner is fired (the proxy creates the in-flight audit row, hands the `routine_run_id` to the Routine via the user message, and the Routine settles it via a final `update_routine_run` query at exit). This means:
- The `select_active_pairs` query in step 3 is the FIRST data read (no MT5/FFCal first), but it happens AFTER the Vercel side has already written the in-flight audit row.
- If the Routine never reaches step 8 (e.g., crashes during reasoning), the audit row stays in `running`. The orphan-detect cron picks it up after 5 minutes per ADR-008 / R3-followup.

This adds a new named query to the allow-list: `update_routine_run` (set `status` + `endedAt` + `outputJson`). The Routine's last action before exit is to call this with the success outcome. Symmetric to the Vercel-side cap-rollup pattern.

### 5.4 Failure modes

- **`/api/internal/ffcal/today` 5xx**: Claude SHOULD fall back to a degraded plan (per EC-002-1). The system prompt's Tools-available appendix instructs this explicitly: "If the calendar fetch returns 5xx, log a Telegram warning via /api/internal/telegram/send with text 'CALENDAR DEGRADED — using last-known schedule heuristic' and proceed with conservative defaults (London 08:00–12:00 GMT, NY 13:30–17:00 GMT)."
- **`/api/internal/postgres/query` 5xx**: per constitution §3 audit-or-abort, Claude MUST NOT proceed to step 5 if step 3 failed. The system prompt says: "If postgres returns 5xx, send Telegram alert 'POSTGRES UNREACHABLE — plan generation aborted' and exit 1. Do not insert any pair_schedules rows."
- **`/api/internal/anthropic/schedule` 5xx for a single pair**: Claude continues with the remaining pairs (don't fail the whole plan because one pair couldn't schedule). Records the failure on the `pair_schedules` row via `update_pair_schedule_one_off_id` with `scheduledOneOffId=null` and a note.
- **Internal-auth 401**: indicates the Routine's `INTERNAL_API_TOKEN` is wrong or stale. Claude sends a Telegram alert "INTERNAL_API_TOKEN MISMATCH — operator must rotate" via the only path it has (which would itself fail). The Routine effectively becomes a no-op until the operator fixes the token. The dashboard's daily heartbeat (FR-005) catches this within 5 minutes.

---

## 6. Executor Routine flow (FR-003)

The Executor Routine is a per-pair Opus 4.7 1M routine fired by the Planner via /schedule (one-off scheduled at the Step-In time) or by the dashboard's "Force re-plan" cleanup. The routine runs the SPARTAN/MSCP analysis end to end against live MT5 data.

### 6.1 Inputs available inside the routine
- **System prompt**: `.harness/spec/preserve/spartan-systemprompt-vercel-proxy.md` (verbatim 444-line original + Tools-available appendix).
- **User message**: `pair_schedule_id: ${id}\nrequested_at: ${ISO}` — minimal pointer; Claude looks up the rest from postgres.
- **Env**: same as Planner.
- **Tools**: Bash, optionally a ForexFactory MCP connector for narrative news context (the system prompt SPARTAN/MSCP analysis instructions reference the calendar by name).

### 6.2 Numbered call flow

1. **Pre-fire stale-check (R3 pre-fire-check)**. Claude calls `POST ${VERCEL_BASE_URL}/api/internal/postgres/query` with `{ name: "select_pair_schedules_today", params: { tenantId: 1, pairCode } }`. If no row matches `id = pair_schedule_id` AND `status = 'scheduled'` (i.e., status is `cancelled` OR row not found OR `scheduled_one_off_id` ≠ this routine's `${ANTHROPIC_ONE_OFF_ID}`), Claude calls `update_routine_run` with `outputJson = { reason: "stale-plan-noop" }` and exits 0. **No MT5 call, no Telegram, no order placement.** This satisfies AC-018-2-b.
2. **Account snapshot**. Claude calls `GET ${VERCEL_BASE_URL}/api/internal/mt5/account`. Captures balance, equity, free-margin.
3. **Open positions**. Claude calls `GET ${VERCEL_BASE_URL}/api/internal/mt5/positions`. Captures the current book.
4. **Multi-timeframe candles**. Claude calls `GET ${VERCEL_BASE_URL}/api/internal/mt5/candles?symbol=${pair}&timeframe=H4&count=180`, then `?timeframe=H1&count=200`, then `?timeframe=M15&count=200`. Three sequential calls; each well within Vercel's per-function timeout. (Could be parallelised via Bash backgrounding if desired; the system prompt does not mandate either.)
5. **SPARTAN/MSCP reasoning**. Claude reasons through the 4-stage MSCP framework (per the verbatim prompt) over the candles, the news context, and the account state. Decides: TRADE (with side/volume/SL/TP) or NO-TRADE.
6. **Order placement (if TRADE)**. Claude calls `POST ${VERCEL_BASE_URL}/api/internal/mt5/orders` with `{ symbol, side, volume, sl, tp, comment: "caishen-${pair_schedule_id}" }`. Captures the order id from the response.
7. **HTML report upload**. Claude assembles a self-contained HTML report (chart-data inline, reasoning trace, decision rationale) and calls `POST ${VERCEL_BASE_URL}/api/internal/blob/upload` with `{ filename: "${pair_schedule_id}.html", html: "..." }`. Captures the public URL.
8. **Postgres write — executor_reports**. Claude calls `POST ${VERCEL_BASE_URL}/api/internal/postgres/query` with `{ name: "insert_executor_report", params: { tenantId: 1, pairScheduleId, decision: "TRADE"|"NO_TRADE", orderId, blobUrl, reasoningSummary } }`.
9. **Telegram digest**. Claude calls `POST ${VERCEL_BASE_URL}/api/internal/telegram/send` with the per-trade summary (decision, order id if TRADE, blob URL).
10. **Audit settle**. Claude calls `update_routine_run` with `status='completed'` + `outputJson = { decision, orderId, blobUrl }`. Exits 0.

### 6.3 Audit-or-abort + ordering

The Vercel-side `/api/internal/anthropic/schedule` route writes the in-flight audit row at fire-scheduling time (when the Planner schedules the Executor). The Routine receives the `routine_run_id` in its body. Step 1 (stale-check) MUST come before any other side-effecting call — that's the order encoded in the system prompt's Tools-available appendix and verified by `replan-cleanup.test.ts`.

### 6.4 Failure modes

- **Stale-check returns no matching row**: noop exit 0 with `outputJson = { reason: "stale-plan-noop" }`. Audit row settles to `completed` (the routine succeeded — it correctly noop'd).
- **MT5 5xx on account/positions/candles**: per EC-003-1, the Vercel route already retries 2× with 10 s backoff (mt5-server.ts handles this). If the route still 5xx's, Claude sends Telegram "MT5 UNREACHABLE — pair ${pair} session aborted" and exits 1 (audit settles to `failed`).
- **MT5 5xx on order placement**: same retry, but a final failure is the most operator-visible outcome — Telegram alert "ORDER FAILED — manual intervention required" with the intended trade params surfaced. Operator can manually place via MT5 if needed.
- **Blob upload failure**: warns via Telegram but does not fail the routine — the order has already been placed; the report is supplementary documentation.
- **Postgres failure on executor_reports insert**: warns via Telegram + Vercel-side stderr; orphan-detect cron picks up the unsettled audit row. The trade itself stands (it was placed against live MT5).

---

## 7. ForexFactory MCP — connector path (deprecation of proxy)

**Session 5g revision** (supersedes the prior session-5e position).

ForexFactory was an MCP server in the n8n workflow — Claude reached it via MCP protocol over stdio/SSE, NOT a plain HTTP service. The session-5e attempt to wrap it as `/api/internal/ffcal/today` (forwarding to `${FFCAL_BASE_URL}/today`) failed in live wire-up with HTTP 404, because no such HTTP endpoint exists upstream. The proxy was an architectural mismatch.

The Routine UI offers two ways to expose ForexFactory data to Claude:

(a) **Connector (MCP server)** — a remote URL the Routine adds as a custom connector in the Anthropic Routines UI. Claude's tool list includes the connector's tools natively; no curl needed. Tools appear as `mcp__<connector_name>__<tool>`.
(b) **HTTP wrapper proxy** — would require the operator to stand up a small JSON-over-HTTP wrapper on the VPS that proxies the FFCal MCP per-tool. Not built; deferred.

**v1 chooses (a)**, the MCP connector path. Reasons:
- It matches the n8n production reality (months of working precedent).
- No new VPS-side service to build/maintain.
- No new env var to leak into the Routine session.
- Existing dashboard auth surface unchanged (`INTERNAL_API_TOKEN` keeps its "everything that touches our private side" scope).
- Operator action is one-time UI configuration in the Routine, not code work.

**Operator action** (one-time, per Routine): in `claude.ai/code/routines`, attach the ForexFactory MCP as a custom connector to the `财神爷-planner` Routine (and to the `财神爷-executor` Routine if the operator wants Spartan to consume FF data too — currently optional; the prompt step 4 reads candles, not calendar). The connector is a remote URL + bearer the operator already has on hand from the n8n setup.

**Proxy route disposition**: `/api/internal/ffcal/today` returns `501 Not Implemented` with a body that points at this document. The route file remains in place so any lingering operator system-prompt revisions get a clear pointer rather than a vague 502. If a future v2 needs HTTP-shaped FFCal access (Path Y above), the route can be revived without breaking deployments in between.

**System-prompt impact**: the planner-systemprompt-vercel-proxy.md tools-available appendix no longer lists `/api/internal/ffcal/today`. It documents the MCP-connector path instead, with a note that the connector tool name will appear in Claude's available-tools list at runtime (the operator confirms the exact name when configuring the connector).

---

## 8. Vercel function execution-time constraints

Vercel Hobby plan defaults:
- Per-function timeout: 10 s (configurable up to 60 s via `export const maxDuration = 60` per route).
- Per-month invocation cap: high (we will not approach it).
- Concurrent execution cap: high (sufficient for one operator's Routines).

Routes that may approach 10 s:
- `/api/internal/mt5/candles` with `count >= 250` over Tailscale Funnel — empirically 5–8 s. **Mitigation**: `export const maxDuration = 30;` on this route. Safety margin: 22 s.
- `/api/internal/anthropic/fire` and `/anthropic/schedule` — typically 1–3 s; Anthropic's /fire endpoint is fast.
- `/api/internal/postgres/query` — sub-second for the named queries in scope.
- `/api/internal/blob/upload` — depends on HTML size; typical 200–500 KB report uploads in ~2 s.

Routes with explicit `maxDuration` settings will be documented in each route file's header comment.

---

## 9. Constitution compliance

- **§1 (no ANTHROPIC_API_KEY)**: this design adds no Anthropic SDK; the proxy uses fetch() with bearer headers manually. The `audit-no-api-key` script continues to enforce the rule.
- **§2 (verbatim system prompts)**: the verbatim files at `.harness/spec/preserve/{planner,spartan}-systemprompt.md` are NOT modified. New overlays at `.harness/spec/preserve/{planner,spartan}-systemprompt-vercel-proxy.md` reproduce the original prompts verbatim and append a Tools-available section. The byte-comparison test (AC-002-1, AC-003-1) checks the verbatim file against the Routine's deployed prompt by extracting the verbatim portion from the proxy file (everything before the `## Tools available (proxy pattern)` divider).
- **§3 (audit-or-abort)**: every internal route that mutates state writes an audit row first (cap-burn pattern). The Routine flows in § 5 / § 6 honour the Vercel-side audit-row creation as the §3 trigger.
- **§4 / §12 (multi-tenant)**: every postgres named query injects `tenant_id` from the request body, validated against the tenant-id-lint allowlist. No raw SQL accepted.
- **§5 (GMT/UTC)**: all timestamps in payload bodies are ISO 8601 UTC. The MT5 candles route forwards the upstream's GMT timestamps unchanged.
- **§10 (no secrets in source)**: only `INTERNAL_API_TOKEN` is referenced by name in the Routine's system prompt; the value is supplied via Cloud Env. All other secrets stay in Vercel.
- **§14 (Routines + Channels are the only LLM callers)**: the proxy routes are NOT LLM callers. The Vercel-side handlers are pure HTTP forwarders + Postgres readers/writers. Only the Routines (via Bash+curl) and the dashboard's `/api/overrides/replan` (which fires the Planner) initiate `/v1/routines/*/fire` calls.
- **§15 (LOUD pre-flight)**: every internal route 500s on missing env. `init.sh` adds a check for `INTERNAL_API_TOKEN` presence (FR-020 update).
- **§17 (no any, no console.log)**: Generator code follows the existing patterns.

---

## 10. What the Generator must NOT do

- Do NOT modify `.harness/spec/preserve/planner-systemprompt.md` or `.harness/spec/preserve/spartan-systemprompt.md`. Constitution §2 is verbatim-pinned.
- Do NOT delete or rewrite the existing `packages/routines/src/{planner,executor,spike}/*.ts` modules. They remain as offline reference implementations.
- Do NOT add a generic `POST /api/internal/postgres/query` that accepts raw SQL. The named-query allow-list is the security model.
- Do NOT add the `INTERNAL_API_TOKEN` value to source files, README files, or operator instructions. Reference it as `${INTERNAL_API_TOKEN}` only. Operator pastes it directly into `.env.local` and Vercel env via the operator-instructions document.
- Do NOT route LLM calls through the proxy. The proxy is for tool access (postgres, MT5, FFCal, blob, telegram, anthropic-fire). The Routine itself is where the LLM call happens.

---

## 11. Future evolution (out of scope for session 5e)

- **Path D consideration**: if Anthropic ships generic first-party MCPs (e.g., HTTP connector, Postgres connector), some subset of /api/internal/* could be replaced by a connector. We'd evaluate per route whether the connector adds value (e.g., Anthropic-side caching) over the Vercel proxy.
- **Tenant-2 onboarding**: when a second tenant goes live, replace the hard-pinned `tenantId === 1` check with token-derived multi-tenant resolution (each tenant gets its own `INTERNAL_API_TOKEN`; the route layer maps token→tenantId).
- **Route hardening**: add a per-route rate limiter (e.g., 60 req/min/tenant) using Vercel KV or the Drizzle-backed `rate_limits` table. Not blocking for v1.
- **Custom MCP for compute_python (FR-013)**: if the FR-001 Spike 2 outcome requires `compute_python`, build a connector inside `packages/mcp-compute-python/` rather than a proxy route. Compute-heavy work shouldn't block a Vercel function.
