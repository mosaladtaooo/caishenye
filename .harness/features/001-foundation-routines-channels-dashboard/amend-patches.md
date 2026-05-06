# Amendment Patches — features/001-foundation-routines-channels-dashboard

**Generated**: 2026-05-04
**Marker**: AMENDMENT REQUEST
**Request**: Pivot AC-002-2 (and any related ACs/architecture sections) from "planner programmatically schedules executors via Anthropic /api/internal/anthropic/schedule" to "planner persists pair_schedules rows with status=scheduled; a Vercel-cron-+-GitHub-Actions-every-minute polling tick fires the per-pair executor via /api/internal/anthropic/fire when start_time_gmt is reached, then writes the returned session_id back as scheduled_one_off_id". Reason: Anthropic has NO programmatic /schedule API per their official docs at docs.code.claude.com/routines — the only public HTTP API on routines is /fire; the /schedule sub-path doesn't exist (verified via the existing route 502'ing with Anthropic upstream 404, and via web research). The polling pattern is already proven in this project for synthetic-ping (.github/workflows/cron-synthetic-ping.yml + /api/cron/synthetic-ping). Architecture pivot also implies: deprecate /api/internal/anthropic/schedule route to 501 (mirror ffcal/today deprecation pattern), remove planner system-prompt steps 8 (call /schedule) and 9 (persist binding) since cron handles both, add new cron route + new GH Actions workflow.

**This file overwrites the prior amend-patches.md** (which covered the GH-Actions-cron move for FR-005's `channels-health` and `synthetic-ping`). That prior amendment has already been applied and its content is preserved in `progress/changelog.md` plus the contract.md sections it produced; this file now carries the post-build AC-002-2 pivot.

---

## Interpretation

The user is converting the Planner's responsibility from "actively scheduling per-pair Executors via a (now-confirmed-nonexistent) Anthropic `/schedule` HTTP API" to a passive "write `pair_schedules` rows in `status=scheduled`" model, with a new cron polling tick (every-minute via GitHub Actions hitting a Vercel route) responsible for actually firing the per-pair Executor via the documented `/fire` API once `start_time_gmt` is reached. The cron tick ALSO writes the returned `session_id` back as `pair_schedules.scheduled_one_off_id`, closing the binding loop. This pivot is fully consistent with the existing synthetic-ping pattern proven in the project (per the prior AMENDMENT that moved sub-daily crons to GitHub Actions for Vercel-Hobby-plan compatibility), and with the Round 3 split-transaction pattern already in use for FR-018 force re-plan (`/fire` POST OUTSIDE any tx, audit row settled in a second tx).

The change is constrained to AC-002-2 (substep h) plus a tightly-coupled supporting cluster: a new every-minute cron route + GH Actions workflow, an update to `pair_schedules.scheduled_one_off_id` semantics, deprecation of the obsolete `schedule-fire.ts` selector in the directory tree, and a new sub-AC (AC-002-2-b) covering the cron tick's fire+settle behavior. The existing FR-018 split-transaction flow already handles the same orchestration shape, so the Round 3 cap-handling hardening transfers cleanly to the daily Planner→cron→Executor path.

The cascade explicitly listed in the user's request — deprecating `/api/internal/anthropic/schedule` to 501 and removing planner system-prompt steps 8 and 9 — is implementation/Generator work that follows once the spec changes; not all of it touches `contract.md`. The PRD and architecture cascades (UJ-001 step 5, FR-001 AC-001-1 spike framing, ADR-002 cap-handling strategy, RISK-001/002/003 mitigations, SD-006/SD-009 silent defaults) MUST be patched separately via `/harness:edit` so the spec stays internally consistent. AMENDMENT mode is single-file scope, and the primary patch (AC-002-2 itself) lives in `prd.md` not `contract.md`, so the truly load-bearing change is OUT-OF-SCOPE here and listed explicitly below.

---

## Impact summary

**Modifies (in-scope contract.md patches below — 11 patches)**:
- Negotiation summary — note the post-build `/schedule`-API-discovery amendment
- Module breakdown — `packages/routines/` description (drop `schedule-fire.ts` selector reference; add cron route note)
- Directory structure — replace `schedule-fire.ts` with `pair-schedules-writer.ts` (Planner side)
- Directory structure — add `dashboard/app/api/cron/fire-due-executors/route.ts`
- Data model — `pair_schedules.scheduled_one_off_id` semantics + new `fire_failed` status enum value + new index
- API surface — add `/api/cron/fire-due-executors` row
- Vercel cron config note — extend the existing GH-Actions-fired sub-daily explanation to cover the new cron
- GitHub Actions cron workflows section — add `cron-fire-due-executors.yml` to the workflow list
- FR → Implementation mapping — FR-002 row update
- Build Order — M2 step 13 description + new sub-step 13a covering the cron route
- Test Criteria — add **AC-002-2-b** (NEW — cron-tick fire-and-settle behavior)

**Unclear**: None. The pivot is well-scoped by the user's request and the existing synthetic-ping pattern provides the implementation precedent.

**Out of scope** (flagged below — recommend `/harness:edit`):
- The PRIMARY patch — AC-002-2 substep h pivot in `.harness/spec/prd.md` (line 116). AMENDMENT marker is single-file scope and the AC text lives in prd.md, not contract.md. ALL contract.md patches below depend on this prd.md patch landing first.
- `.harness/spec/prd.md` cascade (UJ-001 step 5; UJ-004 failure mode (b); FR-001 AC-001-1 framing & EC-001-1; AC-003-1 "only fired as a one-off by the Planner" wording; AC-003-2 "/schedule invocation" reference; EC-002-3 cancellation-via-cron path; FR-017 AC-017-3 cancel-pending-one-offs path; FR-018 EC-018-1 in-flight semantics; RISK-001 / RISK-002 / RISK-003 mitigations; SD-006 / SD-009 silent defaults; line-13 "Code-defined schedule replaces calendar polling" differentiator)
- `.harness/spec/architecture.md` cascade (Stack table "Trading-agent runtime" Rationale on line 12; ADR-002 cap-handling strategy entirely; "Architectural Style" paragraph on line 33; NFR-001 feasibility check on line 37)
- `.harness/spec/preserve/planner-systemprompt-vercel-proxy.md` — operator-authored "Tools-available appendix" + numbered-call-flow steps 8 and 9 (NOT the BEGIN VERBATIM/END VERBATIM original; that stays untouched per constitution §2)
- Code-side route deprecation (`/api/internal/anthropic/schedule` → 501) — implementation work, follows from the spec change
- `/harness:retrospective` cycle — recommended after the cascade lands to reconcile post-build spec-vs-code drift

---

## Patches

### Patch 1 — Negotiation summary: add post-build amendment note
**File**: `.harness/features/001-foundation-routines-channels-dashboard/contract.md`
**Location**: after line 14 (the existing negotiation-summary closing paragraph), before the "The negotiated **Build Order**" line on line 16

```diff
 ## Negotiation summary

 This contract reflects the merged agreement between Generator and Evaluator after three rounds of negotiation. Round 3 closed three items the Round 2 review surfaced: the R6 cryptographic primitive (CSRF moved to a self-issued HMAC-SHA256 cookie via `GET /api/csrf`, decoupled from Auth.js v5 internals); R3-followup (re-plan handler split into two short transactions bridged by a `success=null` in-flight marker, with the external `/fire` POST outside both txs); R5-followup (documentary tightening of why synthetic-ping rows do not artificially inflate `MAX(replied_at)` — Postgres ignores NULL).

+**Post-build amendment (2026-05-04)**: AC-002-2 substep h was pivoted from "Planner programmatically schedules per-pair Executors via Anthropic `/api/internal/anthropic/schedule`" to "Planner persists `pair_schedules` rows in `status=scheduled`; an every-minute GitHub-Actions-fired cron at `/api/cron/fire-due-executors` POSTs `/api/internal/anthropic/fire` for each row whose `start_time_gmt` has been reached and whose `status='scheduled'`, then writes the returned `session_id` back as `scheduled_one_off_id` and updates `status='fired'`". Reason: Anthropic has NO programmatic `/schedule` HTTP API per their official docs at docs.code.claude.com/routines — the only public HTTP API on routines is `/fire` (verified via the existing route 502'ing with Anthropic upstream 404 and via web research). The pivot mirrors the existing GH-Actions-cron + Vercel-route polling pattern proven by the synthetic-ping flow (prior AC-005-2 amendment). The pivot adds AC-002-2-b (NEW) covering the cron tick's fire-and-settle behavior; updates `pair_schedules.scheduled_one_off_id` semantics; deprecates the obsolete `schedule-fire.ts` selector; adds `/api/cron/fire-due-executors` route + `.github/workflows/cron-fire-due-executors.yml`. The existing FR-018 split-transaction flow (Tx A → external `/fire` OUTSIDE any tx → Tx B) is the orchestration template the cron tick follows. PRD and architecture cascades land separately via `/harness:edit` (see OOS-1 / OOS-2 in `amend-patches.md`).
+
 The negotiated **Build Order** below replaces the draft contract's "Suggested Build Order" with the Generator's technical-dependency order, including the Q1 reorder that pulls **FR-010 forward to M0 step 2** so every spike commit must already pass the no-API-key gate (Evaluator endorsed in Round 1).
```

**Reasoning**: documents the post-build amendment in the same section that documents the original three-round negotiation, so future readers see both decision points side-by-side and the chain of cause (route 502 → Anthropic 404 verified → spec corrected).

---

### Patch 2 — Module breakdown: drop `schedule-fire selector` reference; add cron route note
**File**: `.harness/features/001-foundation-routines-channels-dashboard/contract.md`
**Location**: line 61 — `packages/routines/` bullet in the Component/Module Breakdown section

```diff
-- **`packages/routines/`** — Trading core. Planner + Executor TS body code (run inside Anthropic Routines as Bash steps), four spike modules (FR-001), news-fetch port (FR-014), prompt-loader (constitution §2 byte-identity), MT5 REST client, Telegram Bot API client (FR-019), schedule-fire selector (Spike 1 outcome → `claude /schedule` Bash vs `/fire` API).
+- **`packages/routines/`** — Trading core. Planner + Executor TS body code (run inside Anthropic Routines as Bash steps), four spike modules (FR-001), news-fetch port (FR-014), prompt-loader (constitution §2 byte-identity), MT5 REST client, Telegram Bot API client (FR-019), `pair-schedules-writer.ts` (Planner persists rows in `status='scheduled'` per AC-002-2 amended). Note: the original `schedule-fire.ts` selector (Spike 1 outcome → `claude /schedule` Bash vs `/fire` API) was removed during the post-build AC-002-2 amendment (2026-05-04) because Anthropic has no `/schedule` HTTP API; the cron tick at `/api/cron/fire-due-executors` (in `packages/dashboard/`) is now the single firing path.
```

**Reasoning**: replaces the now-obsolete selector with the new responsibility (write rows in `status='scheduled'`); cross-references the new cron route file so the module map stays accurate as a dependency-walking aid.

---

### Patch 3 — Directory tree: replace `schedule-fire.ts` with `pair-schedules-writer.ts`
**File**: `.harness/features/001-foundation-routines-channels-dashboard/contract.md`
**Location**: line 143 — directory tree under `packages/routines/src/`

```diff
 │   │   │   ├── routine-runs.ts                            # withAuditOrAbort wrapper
-│   │   │   ├── schedule-fire.ts                           # claude /schedule vs /fire selector
+│   │   │   ├── pair-schedules-writer.ts                   # AC-002-2 amended: Planner writes pair_schedules rows in status='scheduled'
 │   │   │   └── compute-python-mcp/                        # CONDITIONAL — only if FR-013 builds
```

**Reasoning**: the file is renamed semantically because its responsibility shifted from "select between two firing paths" to "write the rows that the cron tick will later fire from".

---

### Patch 4 — Directory tree: add `cron/fire-due-executors/route.ts`
**File**: `.harness/features/001-foundation-routines-channels-dashboard/contract.md`
**Location**: lines 223-224 — directory tree under `packages/dashboard/app/api/cron/`, after `synthetic-ping` and before `usage-reconcile`

```diff
 │       │           ├── synthetic-ping/route.ts            # AC-005-1 fallback (every 30 min)
+│       │           ├── fire-due-executors/route.ts        # AC-002-2 amended: every minute, polls pair_schedules and fires due executors via /fire
 │       │           └── usage-reconcile/route.ts           # CONDITIONAL on FR-001 Spike 4
```

**Reasoning**: introduces the new cron route in the file tree where every other cron route lives, mirroring synthetic-ping's location and naming convention.

---

### Patch 5 — Data model: `pair_schedules` row update (semantics + new status enum value + new index)
**File**: `.harness/features/001-foundation-routines-channels-dashboard/contract.md`
**Location**: line 260 — `pair_schedules` row in the data-model table

```diff
-| `pair_schedules` | `id`, `tenant_id`, `date`, `pair_code`, `session_name`, `start_time_gmt` (nullable), `end_time_gmt` (nullable), `planner_run_id` (FK), `scheduled_one_off_id` (text), `status` enum: `scheduled` `cancelled` `fired` `skipped_no_window`, `created_at` | FR-002 AC-002-2g, FR-018 AC-018-2 + AC-018-2-b | (`tenant_id`, `date`); (`tenant_id`, `pair_code`, `date`) |
+| `pair_schedules` | `id`, `tenant_id`, `date`, `pair_code`, `session_name`, `start_time_gmt` (nullable), `end_time_gmt` (nullable), `planner_run_id` (FK), `scheduled_one_off_id` (text, **nullable** — set by `/api/cron/fire-due-executors` after `/fire` returns the session_id; AC-002-2 amended), `status` enum: `scheduled` `cancelled` `fired` `skipped_no_window` **`fire_failed`** (NEW per AC-002-2 amendment — cron tick saw `/fire` return non-2xx; orphan-detect cron picks these up alongside `routine_runs` orphans), `failure_reason` (text, nullable — populated when `status='fire_failed'`), `created_at` | FR-002 AC-002-2g + AC-002-2-b, FR-018 AC-018-2 + AC-018-2-b | (`tenant_id`, `date`); (`tenant_id`, `pair_code`, `date`); **(`tenant_id`, `status`, `start_time_gmt`)** — NEW index for cron `WHERE status='scheduled' AND start_time_gmt <= now()` query |
```

**Reasoning**: `scheduled_one_off_id` was implicit-non-null in the original (set by Planner during the never-existed `/schedule` call); under the amended model it is set by the cron tick after `/fire` returns, so it MUST be nullable. The `status` enum gains `fire_failed` for the case where `/fire` returns non-2xx. The new index supports the cron tick's `WHERE status='scheduled' AND start_time_gmt <= now()` query without table-scanning. `failure_reason` text is added because we need to capture WHICH HTTP code/upstream message caused the failure, so orphan-detect can write a useful Telegram alert.

---

### Patch 6 — API surface: add `/api/cron/fire-due-executors` row
**File**: `.harness/features/001-foundation-routines-channels-dashboard/contract.md`
**Location**: between line 305 (`synthetic-ping`) and line 306 (blank line before "### Cron schedule") — API surface table, end of the `/api/cron/*` cluster

```diff
 | `/api/cron/synthetic-ping` | GET | fired every 30 min by GitHub Actions cron (`.github/workflows/cron-synthetic-ping.yml`); POSTs synthetic TG ping for R5 fallback signal; Hobby-plan-compatible | CRON_SECRET (verified in both Vercel env AND GitHub repo Secrets) | n/a (cron) | FR-005 AC-005-1 fallback |
+| `/api/cron/fire-due-executors` | GET | fired every 1 min by GitHub Actions cron (`.github/workflows/cron-fire-due-executors.yml`); polls `pair_schedules WHERE tenant_id=$1 AND status='scheduled' AND start_time_gmt <= now() AND start_time_gmt > now() - interval '60 minutes'` and POSTs `/api/internal/anthropic/fire` for each row, then writes back `scheduled_one_off_id` from the response and sets `status='fired'` (or `status='fire_failed', failure_reason=<short reason>` on non-2xx); idempotent via the `WHERE status='scheduled'` guard; Hobby-plan-compatible | CRON_SECRET (verified in both Vercel env AND GitHub repo Secrets) | n/a (cron) | FR-002 AC-002-2 amended + AC-002-2-b |

 ### Cron schedule (`packages/dashboard/vercel.json`)
```

**Reasoning**: documents the new cron route's behavior, auth, and which AC it serves. Inserted at the end of the `/api/cron/*` cluster (after `synthetic-ping`, immediately before the "### Cron schedule" subsection break) to keep similar-cadence sub-daily crons grouped together. Mirrors the format of the existing `synthetic-ping` row. The 60-min look-back window is documented inline so future readers don't have to dig — it absorbs GH-Actions jitter without re-firing rows that orphan-detect would have already caught.

---

### Patch 7 — Vercel cron config note: extend AC-005-2-amendment paragraph
**File**: `.harness/features/001-foundation-routines-channels-dashboard/contract.md`
**Location**: line 309 — explanatory paragraph immediately before the `crons[]` JSON block

```diff
-The two sub-daily crons (`channels-health` 5-min, `synthetic-ping` 30-min) MOVED to GitHub Actions per AC-005-2 amendment (Vercel Hobby plan blocks sub-daily). Vercel cron config is reduced to daily-only. The corresponding `.github/workflows/cron-{channels-health,synthetic-ping}.yml` files invoke the same Next.js handlers via `curl -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}"`.
+Three sub-daily crons (`channels-health` 5-min, `synthetic-ping` 30-min, **`fire-due-executors` 1-min** — NEW per AC-002-2 amendment, 2026-05-04) are on GitHub Actions, not Vercel (Vercel Hobby plan blocks sub-daily). Vercel cron config is reduced to daily-only. The corresponding `.github/workflows/cron-{channels-health,synthetic-ping,fire-due-executors}.yml` files invoke the same Next.js handlers via `curl -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}"`.
```

**Reasoning**: extends the existing AC-005-2-amendment paragraph to cover the third sub-daily cron without changing its meaning. The same Hobby-plan reasoning applies.

---

### Patch 8 — GitHub Actions cron workflows section: add `cron-fire-due-executors.yml`
**File**: `.harness/features/001-foundation-routines-channels-dashboard/contract.md`
**Location**: lines 322-328 — "GitHub Actions cron workflows" section

```diff
 ### GitHub Actions cron workflows (NEW — per AC-005-2 amendment)

-Two workflow files in `.github/workflows/`:
+Three workflow files in `.github/workflows/` (third added per AC-002-2 amendment, 2026-05-04):

 - `cron-channels-health.yml` — schedule `*/5 * * * *` (best-effort; GH Actions cron has documented up-to-15-min jitter); single `curl` step hits `https://${VERCEL_DEPLOYMENT_URL}/api/cron/channels-health` with `Authorization: Bearer ${{ secrets.CRON_SECRET }}` and `--fail-with-body`. Job fails if curl exits non-zero.
 - `cron-synthetic-ping.yml` — schedule `*/30 * * * *` (same jitter caveat); same shape; hits `/api/cron/synthetic-ping`.
+- `cron-fire-due-executors.yml` — schedule `* * * * *` (every minute, best-effort; GH Actions cron has documented up-to-15-min jitter — accepted because the daily Planner writes rows hours in advance and the 60-min look-back window in the route's WHERE clause absorbs jitter); same shape; hits `/api/cron/fire-due-executors`. Per AC-002-2-b, the route is idempotent: re-firing the same row is impossible because the first successful fire transitions `status` to `fired` and the WHERE clause excludes it.

-Both workflows require two GitHub repo Secrets: `CRON_SECRET` (matching the Vercel env value) and `VERCEL_DEPLOYMENT_URL` (or hardcoded base URL in the workflow YAML; operator chooses).
+All three workflows require two GitHub repo Secrets: `CRON_SECRET` (matching the Vercel env value) and `VERCEL_DEPLOYMENT_URL` (or hardcoded base URL in the workflow YAML; operator chooses).
```

**Reasoning**: keeps the section's structure (paragraph + bullet list + secrets note), adds the third workflow with the same level of detail, documents the idempotency guarantee that makes the every-minute jitter acceptable, and updates the trailing summary line ("Both" → "All three").

---

### Patch 9 — FR → Implementation Mapping: FR-002 row update
**File**: `.harness/features/001-foundation-routines-channels-dashboard/contract.md`
**Location**: line 338 — FR-002 row in the implementation-mapping table

```diff
-| FR-002 | routines/planner.ts + db | `packages/routines/src/planner.ts`, `news.ts`, `schedule-fire.ts`, `prompt-loader.ts` | vitest with mocked deps + `replan-cleanup.test.ts` for EC-002-3 ordering (R3) |
+| FR-002 | routines/planner.ts + db + dashboard/api/cron/fire-due-executors | `packages/routines/src/planner.ts`, `news.ts`, `pair-schedules-writer.ts` (was: `schedule-fire.ts`), `prompt-loader.ts`, `packages/dashboard/app/api/cron/fire-due-executors/route.ts` (NEW per AC-002-2 amendment), `.github/workflows/cron-fire-due-executors.yml` (NEW) | vitest with mocked deps + `replan-cleanup.test.ts` for EC-002-3 ordering (R3) + `fire-due-executors.test.ts` for AC-002-2-b (NEW: idempotency + happy path + `/fire` non-2xx → `status='fire_failed'`) |
```

**Reasoning**: keeps the FR-002 mapping consistent with patches 2, 3, 4, 6 — every file mentioned in those patches is enumerated here so the Generator's BUILD pass has the full file list.

---

### Patch 10 — Build Order: M2 step 13 update + new sub-step 13a
**File**: `.harness/features/001-foundation-routines-channels-dashboard/contract.md`
**Location**: line 564 — Build Order M2 step 13

```diff
-13. **FR-002** Planner routine TS body + prompt-loader + schedule-fire selector + (R3) Executor pre-fire stale-check helper used by FR-003.
+13. **FR-002** Planner routine TS body + prompt-loader + `pair-schedules-writer.ts` (Planner persists rows in `status='scheduled'`; AC-002-2 amended) + (R3) Executor pre-fire stale-check helper used by FR-003.
+13a. **FR-002 (cont.)** Cron fire-due-executors route + GH Actions workflow `cron-fire-due-executors.yml` + `fire-due-executors.test.ts` covering AC-002-2-b (idempotency, happy path, `/fire` non-2xx → `status='fire_failed'`). Lands in M2 because the cron route + workflow are the firing path; without them the Planner-written rows never become Executor fires.
```

**Reasoning**: keeps the existing M2 step 13 structure, swaps the now-obsolete `schedule-fire selector` for the new `pair-schedules-writer.ts`, and adds 13a as a sub-step covering the cron route + GH Actions workflow + dedicated test file. Sub-step 13a is in M2 (not M5) because the cron-firing path is on the daily-trade-cycle critical path, not in the hardening/observability milestone.

---

### Patch 11 — Test Criteria: add AC-002-2-b
**File**: `.harness/features/001-foundation-routines-channels-dashboard/contract.md`
**Location**: line 480 — Test Criteria flat list, immediately after `AC-002-2 (FR-002)`

```diff
 - [ ] AC-002-2 (FR-002)
+- [ ] **AC-002-2-b — Cron tick fire-and-settle behavior. The `/api/cron/fire-due-executors` route, fired every minute by GitHub Actions, polls `pair_schedules WHERE tenant_id=$1 AND status='scheduled' AND start_time_gmt <= now() AND start_time_gmt > now() - interval '60 minutes'` (the 60-min look-back window absorbs GH-Actions jitter without re-firing rows that orphan-detect should have already caught). For each row: (a) POSTs `/api/internal/anthropic/fire` with the routine bearer; (b) on 2xx, parses `claude_code_session_id` and updates the row to `status='fired', scheduled_one_off_id=<session_id>` in a single tx; (c) on non-2xx, updates `status='fire_failed', failure_reason=<short reason>` in a single tx. The route is idempotent — re-firing the same row is impossible because the first successful fire transitions `status` to `fired` and the WHERE clause excludes it. Test (`fire-due-executors.test.ts`): three vitest cases — (1) happy path: row in `status='scheduled'` becomes `status='fired'` with `scheduled_one_off_id` populated; (2) idempotency: cron called twice in succession on the same row; second call sees zero matching rows; (3) `/fire` non-2xx: row becomes `status='fire_failed'` with `failure_reason` populated, no `scheduled_one_off_id`. Tier 2: GH Actions workflow YAML asserted to be `* * * * *` schedule via vitest reading the YAML.** (NEW per post-build AC-002-2 amendment, 2026-05-04)
 - [ ] AC-002-3 (FR-002)
```

**Reasoning**: AC-002-2-b is a NEW negotiated AC covering the cron tick's responsibility — symmetrical to AC-018-2-b (which covers the FR-018 split-tx race window). The wording mirrors AC-018-2-b's structure (concrete WHERE clauses, concrete state transitions, three vitest cases, Tier 2 YAML assertion).

---

## Unclear items

None. The user's request is fully specified by the existing synthetic-ping pattern (which provides the implementation precedent) plus the existing FR-018 split-tx flow (which provides the orchestration template). All decision points (look-back window, status enum extension, idempotency guarantee, test cases) are direct ports from those two existing patterns.

---

## Out-of-scope items

The user's request, as written, requires changes to multiple files beyond `contract.md`. AMENDMENT mode is single-file scope; the cascade below MUST be patched via `/harness:edit` (or, where noted, manually outside the harness).

### OOS-1 — `.harness/spec/prd.md` AC-002-2 substep h pivot (the PRIMARY patch — load-bearing for everything in this file)

**Original quote** (`prd.md` line 116, AC-002-2 substep h):

> (h) creates one-off scheduled Executor routines per pair-session (using `claude /schedule "..."` shell call OR `/fire` API per ADR), (i) writes audit row to `routine_runs` with session_id, session_url, start/end timestamps, input, output.

**Why out of scope**: AMENDMENT marker is single-file. AC-002-2 lives in prd.md, not contract.md. The 11 contract.md patches above are mechanically dependent on this prd.md patch landing first; without it the contract.md and prd.md spec drift apart.

**Suggested resolution**: Run `/harness:edit "Pivot AC-002-2 substep h from 'creates one-off scheduled Executor routines per pair-session (using claude /schedule shell call OR /fire API per ADR)' to 'persists pair_schedules rows in status=scheduled with planner_run_id FK back to this audit row; the cron tick at /api/cron/fire-due-executors fires them via /fire when start_time_gmt is reached and writes back scheduled_one_off_id + status=fired'. Cascade to update: UJ-001 step 5 (Planner writes rows; cron fires them); UJ-004 failure mode (b) (replan failure path now goes through /fire only, no /schedule fallback exists); FR-001 description ('the four LOAD-BEARING ASSUMPTIONS' — drop AC-001-1 /schedule verification entirely, since no /schedule API exists; renumber remaining ACs); EC-001-1 (remove since AC-001-1 itself is dropped); FR-003 AC-003-1 (remove 'only fired as a one-off by the Planner' — now fired by cron tick); FR-003 AC-003-2 (remove '/schedule invocation' — Executor reads the row's input_text from pair_schedules + planner_run_id chain); EC-002-3 (cancellation path now sets pair_schedules.status='cancelled', cron WHERE clause excludes it); FR-017 AC-017-3 (cancel path is a status update, not a routine API call); FR-018 EC-018-1 (in-flight Executor finishes; cancelled rows in status='cancelled' are noop'd by the cron); RISK-001 mitigation (no longer mentions claude /schedule fallback — the corrective action IS this cron pivot); RISK-002 mitigation (Executor split is unchanged); RISK-003 mitigation (manual rollback path is now /api/internal/anthropic/fire only); SD-006 (Planner writes pair_schedules rows; XAU symbol-cleaning hint preserved, route via Vercel proxy); SD-009 (manual /fire is the operator-driven retry, unchanged); line-13 differentiator ('Code-defined schedule replaces calendar polling' becomes 'Code-defined schedule + every-minute cron tick replaces calendar polling'); architecture.md Stack-table 'Trading-agent runtime' Rationale (drop the 'Programmatic creation via claude /schedule Bash' sentence — replace with 'cron tick at /api/cron/fire-due-executors fires per-pair Executors via /fire API'); ADR-002 cap-handling strategy entirely (the cap-exempt /schedule path never existed; replace with: every Executor fire is /fire-API-driven and cap-counted; daily cap budget = 1 Planner + N Executors per pair-session approved by Planner; cap-exhaustion fallback is to skip lowest-priority pair-sessions per Planner output); architecture.md 'Architectural Style' paragraph (replace 'subscription-billed cron+one-off Claude Code Routines' with 'subscription-billed Routines fired via /fire API by the dashboard's cron tick'); architecture.md NFR-001 feasibility check (drop the 'Cap-exempt one-offs (verified in FR-001) keep scheduling within budget' sentence — Routines are NOT cap-exempt; the cap accounting moves to NFR-006)."` — the existing `/harness:edit` cascade-aware path will identify all affected files and produce one coordinated patch set.

### OOS-2 — `.harness/spec/architecture.md` cascade (covered by the same `/harness:edit` invocation)

**Original quotes**:
- Line 12 (Stack table "Trading-agent runtime" Rationale): "Subscription-billed (§1). One-off scheduling is cap-exempt per docs (FR-001 verifies). Programmatic creation via `claude /schedule` Bash works inside any Claude Code session including a routine."
- Lines 56-61 (ADR-002 entirely): "Cap-handling strategy is contingent on FR-001 AC-001-1 outcome…"
- Line 33 ("Architectural Style" paragraph): "Trading core is a set of cron+one-off Claude Code Routines on Anthropic's cloud, all subscription-billed."
- Line 37 (NFR-001 feasibility check): "Cap-exempt one-offs (verified in FR-001) keep scheduling within budget."

**Why out of scope**: Same — AMENDMENT is single-file; these live in architecture.md. The OOS-1 `/harness:edit` invocation already enumerates these as cascade targets.

**Suggested resolution**: Covered by the same `/harness:edit` from OOS-1 (it cascades into architecture.md automatically).

### OOS-3 — `.harness/spec/preserve/planner-systemprompt-vercel-proxy.md` steps 8 and 9 removal

**Original quote** (`planner-systemprompt-vercel-proxy.md`, the operator-authored "Tools-available appendix" + numbered call-flow — NOT the verbatim BEGIN VERBATIM/END VERBATIM original):

> Step 8: call `/api/internal/anthropic/schedule` for each pair-session row. Step 9: persist returned `scheduled_one_off_id` back to `pair_schedules` row.

**Why out of scope**: This is a `-vercel-proxy.md` overlay file. The "Tools-available appendix" / numbered-call-flow section is operator-authored (NOT IP-preserved per constitution §2 — only the verbatim original `planner-systemprompt.md` is IP-preserved). The operator-authored portion CAN be edited, but the AMENDMENT marker's allowlist covers spec/ + contract.md, NOT the preserve/ overlay files.

**Suggested resolution**: After OOS-1's `/harness:edit` lands, run a follow-up edit specifically scoped to the overlay file's call-flow section: `/harness:edit "In .harness/spec/preserve/planner-systemprompt-vercel-proxy.md, remove the numbered-call-flow steps 8 (call /schedule) and 9 (persist scheduled_one_off_id binding); the Planner now ends at step 7 (insert pair_schedules rows in status=scheduled). Renumber the audit-settle step (was step 11) to step 9. The Tools-available endpoint table loses the /api/internal/anthropic/schedule row. The verbatim BEGIN VERBATIM/END VERBATIM section of the original planner-systemprompt.md is NOT touched (constitution §2)."` — this scopes the edit to the operator-authored overlay portion only and leaves the verbatim original prompt intact.

### OOS-4 — Code-side deprecation of `/api/internal/anthropic/schedule` route to 501

**Original quote** (user's request): "deprecate /api/internal/anthropic/schedule route to 501 (mirror ffcal/today deprecation pattern)"

**Why out of scope**: This is implementation work (Generator BUILD), not a spec change. The spec change (AC-002-2 substep h pivot) implicitly authorizes this; the Generator carries it out during the next BUILD pass.

**Suggested resolution**: After OOS-1, OOS-2, OOS-3 land, the Generator's next BUILD or a `/harness:retrospective` cycle picks up the route deprecation as a coded follow-up. No `/harness:*` invocation needed at the spec level.

### OOS-5 — Post-build state requires `/harness:retrospective` reconciliation

**Why this matters**: The dispatch notes "this is post-build, pre-retro. The contract was negotiated 2026-05-03 and the build is complete-for-v1. This amendment reflects reality: v1.1 fix #1 discovered the /schedule API doesn't exist upstream." So the contract.md patches above are LANDING ON TOP of an already-shipped v1, not on a draft. The pre-existing task list also has `#29. [pending] v1.1 #1: anthropic/schedule 502 — investigate Anthropic API` — this amendment IS the resolution to that pending task.

**Suggested resolution**: queue `/harness:retrospective` after the OOS-1 / OOS-2 / OOS-3 cascade lands. The retrospective reconciles spec-vs-code drift (the v1 build correctly identified the upstream `/schedule` 404 and the cron pivot is the corrective action; the retrospective documents that the spec now reflects the corrected reality). Mark task #29 completed when the retrospective lands.

---

## Recommendation to the orchestrator

Because the PRIMARY patch (AC-002-2 substep h) is OUT-OF-SCOPE for AMENDMENT mode, and because the 11 in-scope contract.md patches above are mechanically dependent on that primary patch landing, the cleanest path is:

1. Reject the AMENDMENT framing and re-run as `/harness:edit` with the OOS-1 prompt (which is already drafted above). The cascade-aware Planner will produce a coordinated patch set across `prd.md`, `architecture.md`, AND `contract.md` in a single dispatch — no orphan patches.
2. After OOS-1 lands, run the OOS-3 `/harness:edit` invocation for `planner-systemprompt-vercel-proxy.md`.
3. After OOS-3 lands, queue `/harness:retrospective` to reconcile post-build state and close task #29.
4. The Generator's next BUILD or a manual implementation pass deprecates `/api/internal/anthropic/schedule` to 501 (OOS-4).

Alternative: if the user prefers to keep the AMENDMENT framing (single-file contract.md), the 11 patches above can be applied directly, but the spec will be temporarily inconsistent (contract.md updated, prd.md and architecture.md still referencing `/schedule`) until OOS-1 / OOS-2 also land. This is a workable but suboptimal state — the harness will surface the inconsistency at the next `/harness:analyze` gate.

The recommendation is path (1) — `/harness:edit` from the start, treating this as a cross-file spec correction rather than a single-file amendment.
