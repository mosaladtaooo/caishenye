# Edit Patches — features/001-foundation-routines-channels-dashboard

**Generated**: 2026-05-04
**Marker**: EDIT REQUEST
**Request**: Pivot from "Planner creates one-off scheduled Executor routines per pair-session via `claude /schedule` Bash OR `/fire` API per ADR" to "Planner persists `pair_schedules` rows in `status='scheduled'` with `planner_run_id` FK; an every-minute cron tick at `/api/cron/fire-due-executors` fires them via `/fire` API when `start_time_gmt` is reached and writes back `scheduled_one_off_id` + `status='fired'`." Cascade across PRD, architecture, and the negotiated contract for v1.1 corrective spec sync. Driver: discovery that Anthropic has no programmatic `/schedule` API.

---

## Interpretation

The user is pivoting the Executor scheduling mechanism from a Planner-side direct-schedule call (which assumed a non-existent `claude /schedule` API) to a Vercel Postgres-backed pull model: the Planner becomes a pure writer of intent (rows in `pair_schedules`), and a stateless cron tick polls the table and fires per-pair Executor routines via the existing `/fire` API. Every Executor fire is now cap-counted (no cap-exempt pretense). This collapses two pre-existing FR-001 spike outcomes (cap-exempt path + `/fire`-only fallback) into a single deterministic path: **cron tick → `/fire`**.

Direct consequences I am cascading even though not explicitly enumerated by the user:
- **PRD AC-021-4** has a "PASS/FAIL of FR-001 AC-001-1" branching that no longer exists — must be re-anchored to the unconditional "every fire is cap-counted" model.
- **architecture.md ADR-004**'s "`claude /run` fallback for `/replan`" parallels RISK-003 mitigation; the user explicitly removed `/run` from RISK-003, so ADR-004 must align.
- **contract.md** packaging artifacts referenced by the dropped AC-001-1 (`schedule-fire.ts`, `ac-001-1-cap-exempt.ts`, M2 step 13 selector wording, FR-001/FR-002 mapping rows, D1 deliverable, Test Criteria flat list, Definition of Done line) — all need to drop AC-001-1 + the schedule-fire selector concept.

The "renumber remaining ACs" instruction in the user's request creates a cross-document cascade I judge unsafe without confirmation (AC-001-1 is referenced by 6+ downstream specs). I patch by **dropping AC-001-1 + EC-001-1** and **leaving AC-001-2 / AC-001-3 / AC-001-4 numbered as-is**. The FR-001 title and intro re-anchor on "the three" (was "the four"). I flag this interpretation in UNCLEAR; if the user confirms they want a true renumber, that's a follow-up edit.

The vercel.json crons section ships only daily entries; the every-minute `/api/cron/fire-due-executors` is sub-daily and Hobby-plan-blocked from Vercel cron. The contract already routes `channels-health` (5-min) and `synthetic-ping` (30-min) to GitHub Actions. I propose the same pattern for `fire-due-executors` but flag in UNCLEAR whether the operator already chose a different runtime (e.g., Vercel Pro upgrade) for this cron.

## Impact summary

**Modifies (4 files patched)**:
- `.harness/spec/prd.md` — 21 patches (Patches 0, 0a, 0b, 1-18): FR-003 title (Patch 0), Functional Requirements preamble (0a), Hindsight finding F1 (0b), line-13 differentiator (1), UJ-001 step 5 (2), UJ-001 failure mode (b) (3), UJ-004 failure mode (b) (4), FR-001 title + user-story (5) + AC-001-1 (drop, 6) + EC-001-1 (drop, 7), FR-002 AC-002-2 substep (h) (8), FR-002 EC-002-3 (9), FR-003 AC-003-1 (10), FR-003 AC-003-2 (11), FR-017 AC-017-3 (12), FR-018 AC-018-2 cascade (13), FR-018 EC-018-1 (14), FR-021 AC-021-4 cascade (15), RISK-001 mitigation (16), RISK-003 mitigation (17), SD-006 (18)
- `.harness/spec/architecture.md` — 5 patches (Patches 19-23): Stack-table Trading-agent runtime Rationale, Architectural Style paragraph, NFR-001 feasibility check, ADR-002 (full replacement), ADR-004 (cascade — drop `/run` fallback for `/replan`)
- `.harness/evaluator/criteria.md` — 2 patches (Patches 23a, 23b): § How to test (Evaluator) FR-001 spike-artefact bullet — drop AC-001-1 verification step; § What failing work looks like — re-anchor cap-exempt-assumption anti-pattern on the new model
- `.harness/features/001-foundation-routines-channels-dashboard/contract.md` — 9 patches (Patches 23c, 24-31, 31a): packages/routines prose description (drop "four spike modules" + "schedule-fire selector" cascade, 23c), directory structure (drop `schedule-fire.ts` + `ac-001-1-cap-exempt.ts`, 24), FR → Implementation Mapping FR-001 row (25), FR-002 row (26), D1 deliverable (drop AC-001-1 + EC-001-1) (27), Test Criteria flat list (drop AC-001-1 + EC-001-1) (28), M2 build-order step 13 (drop selector) (29), Definition of Done "four" → "three" (30), Definition of Done implementation-report.md line (31a), vercel.json crons section editorial note for the new cron endpoint (31)

**Unclear (1 item flagged below)**:
- The "renumber remaining ACs" instruction — I patch by dropping AC-001-1 only and leaving AC-001-2/3/4 numbered as-is. User confirms or requests true renumber as a follow-up edit.

**Out of scope (2 items flagged below)**:
- The runtime choice for the every-minute cron (Vercel cron vs GitHub Actions cron vs other) — I propose GH Actions for Hobby-plan parity, but the operator's actual deployed runtime may differ. If different, follow-up edit needed.
- `.harness/progress/decisions.md` line 11 — `## ADR-002 — Cap-handling strategy contingent on FR-001 AC-001-1 outcome` — `progress/decisions.md` is append-only by harness convention; the right move is to append a new ADR-002 entry rather than edit the historical record. Outside this EDIT's scope; recommend `/harness:retrospective` (or a manual append) to log the v1.1 ADR-002 revision in decisions.md as a new dated entry referencing this edit.

**No-op verifications (3 items the user enumerated as "unchanged" or that I confirmed unchanged in the source)**:
- RISK-002 mitigation — User said "unchanged"; verified — current text contains no `/schedule` reference.
- SD-009 — User said "manual /fire is the operator-driven retry, unchanged"; verified — current text already says manual `/fire`.
- The constitution at `.harness/spec/constitution.md` — NEVER patch from EDIT marker per CONSTRAINTS; verified the change does not require constitutional adjustment (no principle here governs the cron-tick pivot).

---

## Patches

### File: `.harness/spec/prd.md`

#### Patch 0 — FR-003 title (drop "(one-off, cap-exempt — assumed PASS in FR-001 AC-001-1)")

**File**: `.harness/spec/prd.md`
**Location**: § Functional Requirements → FR-003 § title (line 124)

```diff
-### FR-003: Per-pair Executor Routines (one-off, cap-exempt — assumed PASS in FR-001 AC-001-1)
+### FR-003: Per-pair Executor Routines (one-off, fired by the cron tick at `/api/cron/fire-due-executors` via `/fire` API; cap-counted)
```

**Reasoning**: Cascade — the FR-003 title parenthetical referenced the dropped AC-001-1 and the dropped cap-exempt claim. Replaced with the new firing-and-cap-counted reality. User did not enumerate this title explicitly but it's a direct cascade.

---

#### Patch 0a — PRD § Functional Requirements preamble (line 93)

**File**: `.harness/spec/prd.md`
**Location**: § Functional Requirements, the blockquote preamble

```diff
-> Build order is logical: FR-001 is the spike that decides whether the cap-exempt architecture works. Everything downstream depends on its outcome.
+> Build order is logical: FR-001 spikes verify the routine duration limit, the `/fire` API beta-header pinning, and the Channels-session 24h token soak. (The original fourth spike — cap-exempt `/schedule`-from-inside-a-routine — was DROPPED in v1.1 per ADR-002 revised, since no programmatic `claude /schedule` API exists.) Everything downstream depends on the surviving three spike outcomes.
```

**Reasoning**: Cascade — the section preamble described FR-001 as deciding "whether the cap-exempt architecture works", which is no longer the framing. Re-anchored on the surviving three spike concerns and explicitly notes the v1.1 drop.

---

#### Patch 0b — PRD § Elicitation Results / Hindsight 20/20 finding F1 (line 476)

**File**: `.harness/spec/prd.md`
**Location**: § Elicitation Results, "Hindsight 20/20" findings, F1 bullet

```diff
-- **F1: We launched, the cap-exempt assumption was wrong, and within a week the system was hitting 15/15 by 14:00 GMT and skipping NY-session trades.** → Addressed by FR-001 (verify the assumption FIRST, before any production routine is created) + FR-021 (daily cap monitoring with hard-stop alert).
+- **F1: We launched, the cap-exempt assumption was wrong, and within a week the system was hitting 15/15 by 14:00 GMT and skipping NY-session trades.** → Discovered DURING v1 build (no programmatic `claude /schedule` API exists); addressed by ADR-002 revised (every fire `/fire`-API-driven and cap-counted; cap-exhaustion fallback = cron-tick skips lowest-priority pair-sessions per Planner output) + FR-021 (daily cap monitoring with hard-stop alert at 14/15).
```

**Reasoning**: Cascade — the F1 finding originally pointed at FR-001 as the verification point; with AC-001-1 dropped, the F1 mitigation path moves to ADR-002 revised. Preserves the original failure-mode framing for audit history but updates the addressed-by clause.

---

#### Patch 1 — Differentiator line: code-defined schedule

**File**: `.harness/spec/prd.md`
**Location**: § Vision & Differentiators, third bullet of "Differentiators vs. the n8n status quo"

```diff
-- **Code-defined schedule replaces calendar polling**: the daily Planner writes its session decisions to Postgres and programmatically schedules per-pair executors as one-off Claude Code routine runs (cap-exempt). No Google Calendar, no every-minute pollers, no OAuth churn.
+- **Code-defined schedule + every-minute cron tick replaces calendar polling**: the daily Planner writes its session decisions to Postgres `pair_schedules` rows; an every-minute Vercel-Postgres-backed cron tick at `/api/cron/fire-due-executors` reads due rows and fires per-pair Executors via the `/fire` API. No Google Calendar, no OAuth churn — scheduling is internal-DB-driven and the every-minute tick is a local Postgres SELECT, not an external poller.
```

**Reasoning**: User-enumerated change to the headline differentiator; "(cap-exempt)" claim removed because every fire is now `/fire`-API-driven and cap-counted; "no every-minute pollers" reworded so it accurately describes the new tick (internal DB read, not external OAuth poll).

---

#### Patch 2 — UJ-001 step 5

**File**: `.harness/spec/prd.md`
**Location**: § User Journeys → UJ-001: Daily trade cycle (autonomous), step 5

```diff
-5. Planner programmatically schedules per-pair Executor Routine runs as one-off scheduled routines (cap-exempt) — one per pair-session per day.
+5. Planner inserts one `pair_schedules` row per approved pair-session in `status='scheduled'` with `planner_run_id` FK back to the Planner's audit row. The every-minute cron tick at `/api/cron/fire-due-executors` reads due rows (`start_time_gmt <= now() AND status='scheduled'`) and fires the per-pair Executor via the `/fire` API; on fire it writes back `scheduled_one_off_id` and `status='fired'`. Cap usage is counted on every fire (the cap-exempt-`/schedule` path was discovered to not exist).
```

**Reasoning**: User-enumerated; replaces the Planner-direct-schedule action with the Postgres-write + cron-tick model; removes "cap-exempt" claim.

---

#### Patch 3 — UJ-001 failure mode (b)

**File**: `.harness/spec/prd.md`
**Location**: § User Journeys → UJ-001 § Failure modes, item (b)

```diff
-**Failure modes**: (a) MT5 REST unreachable → Executor records failure in audit, sends Telegram alert via Channels session, no retry within the same fire (one-off can't re-schedule itself reliably); (b) Routine cap exhausted → falls back to `/fire` API path; (c) Tool call to ForexFactory MCP fails → Executor proceeds with empty calendar context (degraded but valid); (d) The 5-15min Executor exceeds Anthropic's undocumented routine duration limit → Executor's last action persisted, manual investigation triggered via Telegram alert. **Mitigation for (d) is FR-001's load-bearing checkpoint**.
+**Failure modes**: (a) MT5 REST unreachable → Executor records failure in audit, sends Telegram alert via Channels session, no retry within the same fire (one-off can't re-schedule itself reliably); (b) Routine cap exhausted → cron tick skips lowest-priority pair-sessions per Planner-output ranking; the audit row marks the skip and Telegram alerts the operator; (c) Tool call to ForexFactory MCP fails → Executor proceeds with empty calendar context (degraded but valid); (d) The 5-15min Executor exceeds Anthropic's undocumented routine duration limit → Executor's last action persisted, manual investigation triggered via Telegram alert. **Mitigation for (d) is FR-001's load-bearing checkpoint**.
```

**Reasoning**: User mapped cap-exhaustion fallback in ADR-002 to "skip lowest-priority pair-sessions per Planner output". UJ-001 (b) was the old fallback statement; it must reflect the same new behaviour for consistency. Not explicitly enumerated by the user but a direct cascade dependency from the ADR-002 patch.

---

#### Patch 4 — UJ-004 failure mode (b)

**File**: `.harness/spec/prd.md`
**Location**: § User Journeys → UJ-004 § Failure modes, item (b)

```diff
-**Failure modes**: (a) Daily cap exhausted → operator gets a clear "Cannot replan: cap remaining 0/15 today, resets at HH:MM GMT" reply. (b) `/fire` API beta-header version bumped → fallback to spawning a new one-off via `claude /schedule "now, run planner"` from the Channels session as a Bash command.
+**Failure modes**: (a) Daily cap exhausted → operator gets a clear "Cannot replan: cap remaining 0/15 today, resets at HH:MM GMT" reply. (b) `/fire` API beta-header version bumped → operator must roll the pinned `ROUTINE_BETA_HEADER` env to the new value and redeploy; there is no `claude /schedule` fallback because no programmatic `/schedule` API exists. The dashboard's "Force re-plan" button surfaces a clear error pointing at the beta-header pinning ADR.
```

**Reasoning**: User-enumerated. Replaces the non-existent `/schedule` Bash fallback with the operator-driven beta-header bump path; aligns with the corrected RISK-003 mitigation.

---

#### Patch 5 — FR-001 title + user story (drop "/schedule from inside a routine"; "four" → "three")

**File**: `.harness/spec/prd.md`
**Location**: § Functional Requirements → FR-001 (title and user story)

```diff
-### FR-001: Architecture-spike verification of LOAD-BEARING ASSUMPTIONS — `/schedule` from inside a routine, routine duration limit, `/fire` API, channels token quota
-- **Journey**: UJ-001 (every routine in the system depends on this)
-- **Priority**: P0
-- **User Story**: As Tao, I want the architecture's four undocumented assumptions verified BEFORE we lock the design, so that we don't ship a system that depends on a broken substrate.
+### FR-001: Architecture-spike verification of LOAD-BEARING ASSUMPTIONS — routine duration limit, `/fire` API, channels token quota
+- **Journey**: UJ-001 (every routine in the system depends on this)
+- **Priority**: P0
+- **User Story**: As Tao, I want the architecture's three undocumented assumptions verified BEFORE we lock the design, so that we don't ship a system that depends on a broken substrate.
```

**Reasoning**: User-enumerated; the `/schedule` path no longer exists, so its verification spike is dropped. AC-001-1 (the corresponding criterion) is dropped in Patch 6.

---

#### Patch 6 — FR-001 AC-001-1 (drop entirely)

**File**: `.harness/spec/prd.md`
**Location**: § Functional Requirements → FR-001 § Acceptance Criteria, the AC-001-1 line

```diff
-  - [ ] AC-001-1: A test "spike" routine is created in the Anthropic console (recurring nightly, runs once for verification, can be deleted afterwards). Its body runs `claude /schedule "in 10 minutes, run a noop"` as a Bash command from inside the routine session, then exits. After it completes, the operator verifies in the routines list that a one-off was created and has fired. **PASS** = one-off appears AND fires AND does not increment the daily cap counter (verified via the `/usage` view BEFORE and AFTER the one-off fires). **FAIL** = system falls back to the `/fire`-only architecture (FR-001a contract decision).
-  - [ ] AC-001-2: A second test routine measures Executor duration. It runs a representative MSCP-shaped workload: a synthetic Bash step that pulls 250+180+240+288 = 958 candle bars from MT5 REST, runs a single Opus 4.7 reasoning turn, and writes a stub report. Wall-clock ≤ 12 minutes for 2 consecutive runs is **PASS**. > 12 min is **PARTIAL** (architecture splits the Executor into two phases: phase-1 = data fetch + reasoning + decision; phase-2 = order placement, run as a chained one-off if needed).
+  - [ ] AC-001-2: A second test routine measures Executor duration. It runs a representative MSCP-shaped workload: a synthetic Bash step that pulls 250+180+240+288 = 958 candle bars from MT5 REST, runs a single Opus 4.7 reasoning turn, and writes a stub report. Wall-clock ≤ 12 minutes for 2 consecutive runs is **PASS**. > 12 min is **PARTIAL** (architecture splits the Executor into two phases: phase-1 = data fetch + reasoning + decision; phase-2 = order placement, run as a chained one-off if needed).
```

**Reasoning**: User-enumerated; AC-001-1 dropped because the `claude /schedule` API doesn't exist. AC-001-2 line preserved as-is (anchor for the diff). The remaining AC-001-2 / AC-001-3 / AC-001-4 keep their numbering; see UNCLEAR § for the renumber question.

---

#### Patch 7 — FR-001 EC-001-1 (drop entirely)

**File**: `.harness/spec/prd.md`
**Location**: § Functional Requirements → FR-001 § Edge Cases, the EC-001-1 line

```diff
-  - EC-001-1: AC-001-1 returns "one-off created BUT incremented cap counter" — partial success. Architecture commits to `/fire`-only path with 14/15 daily fires + 1 buffer, no fallback room. Documented in `architecture.md` ADR-002.
-  - EC-001-2: AC-001-2 fails (run > 12min consistently) AND splitting the Executor introduces too much complexity — fallback escalation: switch Executor LLM to Sonnet 4.6 (faster, less context, but enough for MSCP based on n8n's GPT-5.4 baseline). Recorded in ADR-003.
+  - EC-001-2: AC-001-2 fails (run > 12min consistently) AND splitting the Executor introduces too much complexity — fallback escalation: switch Executor LLM to Sonnet 4.6 (faster, less context, but enough for MSCP based on n8n's GPT-5.4 baseline). Recorded in ADR-003.
```

**Reasoning**: User-enumerated; EC-001-1 dropped because AC-001-1 is dropped. EC-001-2 line preserved as anchor.

---

#### Patch 8 — FR-002 AC-002-2 substep (h)

**File**: `.harness/spec/prd.md`
**Location**: § Functional Requirements → FR-002 § Acceptance Criteria, AC-002-2

```diff
-  - [ ] AC-002-2: The routine's body Bash step runs a TypeScript module (`packages/routines/src/planner.ts`) that: (a) GETs `https://investinglive.com/feed/` RSS, (b) filters items in last 24h, (c) renders the markdown summary using the same helper as the existing n8n `Code in JavaScript5` node (port verbatim), (d) injects `Time Now`, `News count`, `markdown` into the user message, (e) calls Claude with the user message, (f) parses the structured `sessions[]` output, (g) writes today's schedule to Postgres `pair_schedules`, (h) creates one-off scheduled Executor routines per pair-session (using `claude /schedule "..."` shell call OR `/fire` API per ADR), (i) writes audit row to `routine_runs` with session_id, session_url, start/end timestamps, input, output.
+  - [ ] AC-002-2: The routine's body Bash step runs a TypeScript module (`packages/routines/src/planner.ts`) that: (a) GETs `https://investinglive.com/feed/` RSS, (b) filters items in last 24h, (c) renders the markdown summary using the same helper as the existing n8n `Code in JavaScript5` node (port verbatim), (d) injects `Time Now`, `News count`, `markdown` into the user message, (e) calls Claude with the user message, (f) parses the structured `sessions[]` output, (g) writes today's schedule to Postgres `pair_schedules`, (h) persists `pair_schedules` rows in `status='scheduled'` with `planner_run_id` FK back to this audit row; the cron tick at `/api/cron/fire-due-executors` fires them via `/fire` when `start_time_gmt` is reached and writes back `scheduled_one_off_id` + `status='fired'`, (i) writes audit row to `routine_runs` with session_id, session_url, start/end timestamps, input, output.
```

**Reasoning**: User-enumerated; verbatim substitution per the EDIT request. (Substep (g) "writes today's schedule to Postgres `pair_schedules`" is preserved because the user's substep (h) text presupposes those rows already exist; (g) and (h) together describe the full write — (g) creates the per-session rows, (h) is the meta about what `status` they're in and how the cron fires them.)

---

#### Patch 9 — FR-002 EC-002-3 (cancellation path)

**File**: `.harness/spec/prd.md`
**Location**: § Functional Requirements → FR-002 § Edge Cases, EC-002-3

```diff
-  - EC-002-3: `pair_schedules` already has rows for today (re-plan was triggered earlier) → routine deletes today's rows for this `tenant_id` first, then writes new ones, then cancels stale one-offs.
+  - EC-002-3: `pair_schedules` already has rows for today (re-plan was triggered earlier) → routine UPDATEs today's `status='scheduled'` rows to `status='cancelled'` for this `tenant_id` first, then writes new `status='scheduled'` rows. The cron tick's WHERE clause excludes `status='cancelled'` rows, so cancelled rows are never fired. Already-fired rows (`status='fired'`) are left untouched (the in-flight Executor's session continues to completion).
```

**Reasoning**: User-enumerated; replaces "delete + cancel stale one-offs" with "UPDATE status to cancelled + cron-tick filters them out". The "delete" semantics also softened to UPDATE so the audit history is preserved.

---

#### Patch 10 — FR-003 AC-003-1

**File**: `.harness/spec/prd.md`
**Location**: § Functional Requirements → FR-003 § Acceptance Criteria, AC-003-1

```diff
-  - [ ] AC-003-1: A SINGLE Claude Code routine is created in the Anthropic console with: name `财神爷-executor`, NO recurring schedule (it's only fired as a one-off by the Planner), model Opus 4.7 (1M context), system prompt = the verbatim contents of `.harness/spec/preserve/spartan-systemprompt.md`, ForexFactory MCP + MT5 REST attached as connectors, the MT5 REST URL pointing through the Tailscale Funnel with bearer auth (FR-009).
+  - [ ] AC-003-1: A SINGLE Claude Code routine is created in the Anthropic console with: name `财神爷-executor`, NO recurring schedule (it's fired as a one-off by the cron tick at `/api/cron/fire-due-executors` via the `/fire` API when a `pair_schedules` row's `start_time_gmt` is reached), model Opus 4.7 (1M context), system prompt = the verbatim contents of `.harness/spec/preserve/spartan-systemprompt.md`, ForexFactory MCP + MT5 REST attached as connectors, the MT5 REST URL pointing through the Tailscale Funnel with bearer auth (FR-009).
```

**Reasoning**: User-enumerated; replaces "fired as a one-off by the Planner" with "fired by the cron tick".

---

#### Patch 11 — FR-003 AC-003-2

**File**: `.harness/spec/prd.md`
**Location**: § Functional Requirements → FR-003 § Acceptance Criteria, AC-003-2

```diff
-  - [ ] AC-003-2: The Executor accepts a `text` input shaped exactly as the existing n8n template: `LET'S START\nCurrent Analysis Pair :\n{PAIR}\n\n{XAU_BLOCK_IF_APPLICABLE}\n\nTime Now: {NOW_GMT}`. The Planner writes that text into the `/schedule` invocation; the Executor reads it as the user message.
+  - [ ] AC-003-2: The Executor accepts a `text` input shaped exactly as the existing n8n template: `LET'S START\nCurrent Analysis Pair :\n{PAIR}\n\n{XAU_BLOCK_IF_APPLICABLE}\n\nTime Now: {NOW_GMT}`. The cron tick reads the row's `input_text` (rendered by the Planner at write time and persisted on the `pair_schedules` row, joined back via `planner_run_id`) and passes it as the `/fire` request's input; the Executor reads it as the user message.
```

**Reasoning**: User-enumerated; replaces "/schedule invocation" with "Executor reads the row's input_text from pair_schedules + planner_run_id chain", expressed in the AC's vocabulary.

---

#### Patch 12 — FR-017 AC-017-3

**File**: `.harness/spec/prd.md`
**Location**: § Functional Requirements → FR-017 § Acceptance Criteria, AC-017-3

```diff
-  - [ ] AC-017-3: `/pause` from Telegram OR dashboard "Pause" button → updates row, attempts to cancel today's not-yet-fired one-offs (best-effort; if the cancel API isn't available, the audit notes it and the in-flight one-offs will fire but see `paused=true` and noop).
+  - [ ] AC-017-3: `/pause` from Telegram OR dashboard "Pause" button → updates `agent_state.paused_bool=true`, then UPDATEs all today's `pair_schedules` rows in `status='scheduled'` to `status='cancelled'` (a status update, not a routine-API call — the cron tick's WHERE clause excludes `status='cancelled'` so they will never fire). Already-fired rows (`status='fired'`) are left alone; the in-flight Executor's pre-fire stale-check sees `paused=true` and noops.
```

**Reasoning**: User-enumerated; replaces "best-effort cancel API" wording with the new status-update model.

---

#### Patch 13 — FR-018 AC-018-2

**File**: `.harness/spec/prd.md`
**Location**: § Functional Requirements → FR-018 § Acceptance Criteria, AC-018-2

```diff
-  - [ ] AC-018-2: After re-plan: today's stale one-offs are best-effort cancelled; new ones scheduled. Old `pair_schedules` rows for today are deleted; new rows written. Dashboard schedule view live-updates.
+  - [ ] AC-018-2: After re-plan: today's `pair_schedules` rows in `status='scheduled'` for this `tenant_id` are UPDATEd to `status='cancelled'` (best-effort; cron tick's WHERE clause excludes them); new `status='scheduled'` rows written. Already-fired rows (`status='fired'`) are left untouched. Dashboard schedule view live-updates.
```

**Reasoning**: Cascade dependency the user may have missed — AC-018-2 had the same "deleted + best-effort cancel" wording as EC-002-3 and EC-018-1. Brought into consistency with the user's enumerated EC-018-1 patch (Patch 14 below).

---

#### Patch 14 — FR-018 EC-018-1

**File**: `.harness/spec/prd.md`
**Location**: § Functional Requirements → FR-018 § Edge Cases, EC-018-1

```diff
-  - EC-018-1: Re-plan fires while an Executor is in-flight → in-flight Executor finishes (it has its own session); the re-plan replaces only the not-yet-fired schedule slots.
+  - EC-018-1: Re-plan fires while an Executor is in-flight → in-flight Executor finishes (it has its own session, status already `fired`); cancelled rows in `status='cancelled'` are noop'd by the cron tick (its WHERE clause excludes them); only `status='scheduled'` rows are replaced.
```

**Reasoning**: User-enumerated; rewrites EC-018-1 around the new status-driven cron behaviour.

---

#### Patch 15 — FR-021 AC-021-4 (cap-handling cascade)

**File**: `.harness/spec/prd.md`
**Location**: § Functional Requirements → FR-021 § Acceptance Criteria, AC-021-4

```diff
-  - [ ] AC-021-4: Cap-usage interpretation is contingent on FR-001 AC-001-1 outcome: if PASS (one-offs cap-exempt), expected daily usage is ~1/15 (the Planner) plus any `/fire`-driven re-plans, so >5/15 on a normal day flags either heavy operator-driven re-planning or an out-of-band spike worth investigating; if FAIL (one-offs cap-counted per ADR-002 fallback), expected daily usage is up to 14/15 with 1 slot reserved for emergency re-plan, so 14/15 is normal and 15/15 is hard-stop. The dashboard tooltip on the cap-progress-bar reflects the chosen interpretation based on what FR-001 returned (Generator selects the right tooltip text at build time per the spike report's PASS/FAIL outcome).
+  - [ ] AC-021-4: Cap-usage interpretation: every Executor fire is `/fire`-API-driven and cap-counted (no cap-exempt path exists). Daily cap budget = 1 Planner + N Executors per pair-session approved by the Planner (typically up to 13 on a fully-approved day, leaving ≥1 slot for an operator-driven re-plan). Cap-exhaustion fallback: the cron tick skips lowest-priority pair-sessions per the Planner output's ranking and writes `status='skipped_cap_exhausted'` on the corresponding `pair_schedules` rows; Telegram alerts the operator. Dashboard tooltip on the cap-progress-bar describes this unconditional model.
```

**Reasoning**: Cascade — AC-021-4 was anchored on the dropped FR-001 AC-001-1 PASS/FAIL conditional. Re-anchored on the unconditional "every fire is cap-counted" model from the user's ADR-002 patch. The user did not enumerate this AC explicitly, but its dependency on AC-001-1 is direct.

NOTE: Adds a new `pair_schedules.status` enum value `skipped_cap_exhausted` (currently `scheduled` `cancelled` `fired` `skipped_no_window`). I flag this as a schema-side micro-cascade but do NOT patch contract.md's data-model row — the status field is documented as an enum and adding a value is a non-breaking schema change the operator can make at v1.1 migration time. If the operator prefers to reuse `cancelled` + a separate audit row, that's an alternative.

---

#### Patch 16 — RISK-001 mitigation

**File**: `.harness/spec/prd.md`
**Location**: § Risks → RISK-001 § Mitigation

```diff
-### RISK-001: One-off routines are NOT cap-exempt at runtime (FR-001 AC-001-1 fails)
-- **Likelihood**: Medium (the docs say cap-exempt; the brainstorm flags this as load-bearing because the docs also describe "creating from inside a routine" only conversationally, never via Bash inside a session)
-- **Impact**: High (architecture falls back to 14/15 daily fires with no buffer; one mid-day re-plan exhausts the cap)
-- **Mitigation**: FR-001 spike runs FIRST in the build. If fails, ADR-002 codifies the fallback path: the Planner pre-creates 13 saved routines (1 per pair-session combo), each a thin wrapper around the Executor; the Planner uses `/fire` API on the right ones at the right times. Re-plans cost a cap slot; daily cap monitor (FR-021) hard-blocks at 14/15.
+### RISK-001: One-off routines are NOT cap-exempt at runtime (the assumed `/schedule`-from-inside-a-routine path is non-existent)
+- **Likelihood**: Resolved (discovery during v1 build: Anthropic exposes no programmatic `/schedule` API; the cap-exempt claim was an artefact of stale conversational doc reading)
+- **Impact**: High in the original sense (architecture would have shipped depending on a non-existent substrate); now structurally addressed
+- **Mitigation**: The corrective action IS the v1.1 architecture pivot: Planner persists `pair_schedules` rows in `status='scheduled'`, the every-minute cron tick at `/api/cron/fire-due-executors` reads due rows and fires per-pair Executors via the `/fire` API. Every fire is cap-counted; daily cap budget = 1 Planner + N Executors per pair-session approved by Planner. Cap-exhaustion fallback (per ADR-002 revised) = cron tick skips lowest-priority pair-sessions per the Planner's ranking output. There is no `claude /schedule` fallback because there is no `claude /schedule` API.
```

**Reasoning**: User-enumerated; full RISK-001 rewrite to reflect the corrective pivot.

---

#### Patch 17 — RISK-003 mitigation

**File**: `.harness/spec/prd.md`
**Location**: § Risks → RISK-003 § Mitigation

```diff
-- **Mitigation**: Version-pinning ADR-004; init.sh + CI run a smoke test against the pinned beta header; alert on failure. Manual rollback path: re-plan via Telegram `/replan` which uses `claude /run` instead of HTTP `/fire`.
+- **Mitigation**: Version-pinning ADR-004; init.sh + CI run a smoke test against the pinned beta header; alert on failure. Manual rollback path: operator-driven `/api/internal/anthropic/fire` from the dashboard (the same Vercel-proxied `/fire` endpoint the cron tick uses, exposed under operator auth). There is no `claude /run` Bash fallback in v1.1 because the Channels-session-driven `/replan` path is not the rollback path for `/fire` outages — it would still hit the same `/fire` API under the hood.
```

**Reasoning**: User-enumerated; replaces `claude /run` fallback with `/api/internal/anthropic/fire` operator-driven retry.

---

#### Patch 18 — SD-006 (silent default — Planner writes pair_schedules + XAU symbol-cleaning preserved + Vercel proxy)

**File**: `.harness/spec/prd.md`
**Location**: § Silent Defaults, SD-006

```diff
-- **SD-006**: Routine-prompt design = `text` parameter contains the full user message verbatim (matches existing n8n template). Parsed inside the routine's TS body code (not by Claude). XAU symbol-cleaning hint included in the text per existing template.
+- **SD-006**: Routine-prompt design = the Planner writes `pair_schedules` rows with the full per-pair-session `input_text` rendered at write time (verbatim n8n-template shape including `LET'S START\nCurrent Analysis Pair :\n{PAIR}\n\n{XAU_BLOCK_IF_APPLICABLE}\n\nTime Now: {NOW_GMT}`). The cron tick reads `input_text` from the row at fire time and passes it as the `/fire` API's input parameter, routed via the Vercel proxy at `/api/internal/anthropic/fire` to keep the Anthropic bearer in Vercel-side env (subscription-only auth path; FR-010). Parsed inside the routine's TS body code (not by Claude). XAU symbol-cleaning hint included in the text per existing template.
```

**Reasoning**: User-enumerated; spells out the new write-then-cron-read flow, the Vercel proxy hop, and preserves the XAU symbol-cleaning note verbatim.

---

### File: `.harness/spec/architecture.md`

#### Patch 19 — Stack table: Trading-agent runtime Rationale

**File**: `.harness/spec/architecture.md`
**Location**: § Stack table, "Trading-agent runtime" row, "Rationale" column

```diff
-| Trading-agent runtime | Claude Code Routines | as of `experimental-cc-routine-2026-04-01` | NFR-001 | Subscription-billed (§1). One-off scheduling is cap-exempt per docs (FR-001 verifies). Programmatic creation via `claude /schedule` Bash works inside any Claude Code session including a routine. |
+| Trading-agent runtime | Claude Code Routines | as of `experimental-cc-routine-2026-04-01` | NFR-001 | Subscription-billed (§1). The cron tick at `/api/cron/fire-due-executors` fires per-pair Executors via the `/fire` API when due `pair_schedules` rows are reached (every-minute Postgres SELECT). Every fire is cap-counted (the cap-exempt `/schedule` path was discovered to not exist; no programmatic `/schedule` API is documented). |
```

**Reasoning**: User-enumerated; replaces the "/schedule Bash" sentence with the cron tick description.

---

#### Patch 20 — Architectural Style paragraph

**File**: `.harness/spec/architecture.md`
**Location**: § Architectural Style (the entire paragraph)

```diff
-A three-surface system: (1) **Trading core** is a set of cron+one-off Claude Code Routines on Anthropic's cloud, all subscription-billed. (2) **Telegram** is an always-on Claude Code Channels session running as a systemd service on the operator's VPS. (3) **Dashboard** is a Next.js 16 App Router project on Vercel free tier. All three surfaces share state through a single Vercel Postgres (Neon) database and a Vercel Blob bucket. The MT5 REST API and ForexFactory MCP live on the operator's VPS and are reached by (1) and (3) through a Tailscale Funnel (auto-assigned `*.ts.net` hostname, no domain required at v1 launch) with app-layer bearer-token auth at the gateway; (2) reaches them locally. No Anthropic API SDK is ever loaded; LLM calls only originate from (1) and (2). All time is GMT/UTC; localization happens in the dashboard view layer only.
+A three-surface system: (1) **Trading core** is a set of subscription-billed Routines on Anthropic's cloud, fired via the `/fire` API by the dashboard's every-minute cron tick at `/api/cron/fire-due-executors` (which reads due `pair_schedules` rows). (2) **Telegram** is an always-on Claude Code Channels session running as a systemd service on the operator's VPS. (3) **Dashboard** is a Next.js 16 App Router project on Vercel free tier. All three surfaces share state through a single Vercel Postgres (Neon) database and a Vercel Blob bucket. The MT5 REST API and ForexFactory MCP live on the operator's VPS and are reached by (1) and (3) through a Tailscale Funnel (auto-assigned `*.ts.net` hostname, no domain required at v1 launch) with app-layer bearer-token auth at the gateway; (2) reaches them locally. No Anthropic API SDK is ever loaded; LLM calls only originate from (1) and (2). All time is GMT/UTC; localization happens in the dashboard view layer only.
```

**Reasoning**: User-enumerated; replaces "cron+one-off Routines" framing with the new "fired via `/fire` API by the dashboard's cron tick" framing.

---

#### Patch 21 — NFR-001 feasibility check (drop "Cap-exempt one-offs" sentence)

**File**: `.harness/spec/architecture.md`
**Location**: § NFR Feasibility Check, NFR-001 bullet

```diff
-- **NFR-001 (≥99.5% scheduled fires execute)**: Routines + Postgres + audit-or-abort design (§3) gives observable failure attribution. Cap-exempt one-offs (verified in FR-001) keep scheduling within budget. Tailscale Funnel + app-layer bearer (per ADR-005 revised) gives a stable, free transport with no domain prerequisite — Funnel hostnames are stable per-tailnet-node. Risk concentrated in the long-running Executor; FR-001 AC-001-2 measures and informs split/fallback. Funnel-hostname-drift on VPS re-auth is caught by init.sh smoke (FR-009 AC-009-4) per RISK-005 v1 subnote.
+- **NFR-001 (≥99.5% scheduled fires execute)**: Routines + Postgres + audit-or-abort design (§3) gives observable failure attribution. Tailscale Funnel + app-layer bearer (per ADR-005 revised) gives a stable, free transport with no domain prerequisite — Funnel hostnames are stable per-tailnet-node. Cap accounting is unconditional and tracked under NFR-006 (every fire `/fire`-API-driven and cap-counted). Risk concentrated in the long-running Executor; FR-001 AC-001-2 measures and informs split/fallback. Funnel-hostname-drift on VPS re-auth is caught by init.sh smoke (FR-009 AC-009-4) per RISK-005 v1 subnote.
```

**Reasoning**: User-enumerated; drops the "Cap-exempt one-offs (verified in FR-001) keep scheduling within budget" sentence and reroutes the cap-accounting concern to NFR-006.

---

#### Patch 22 — ADR-002 (full replacement)

**File**: `.harness/spec/architecture.md`
**Location**: § Key Stack Decisions (ADRs) → ADR-002

```diff
-### ADR-002: Cap-handling strategy is contingent on FR-001 AC-001-1 outcome
-- **Context**: Whether one-off scheduling from inside a routine is cap-exempt is the load-bearing assumption for the entire schedule.
-- **Options considered**: (a) one-offs cap-exempt — Planner schedules per-pair Executors via `claude /schedule` Bash inside the routine, daily cap usage stays at 1/15 most days; (b) cap-counted — Planner uses `/fire` API on pre-created saved routines, daily usage tops out at 14/15 with 1 buffer; (c) Pre-create 13 saved routines OR a generic Executor routine and schedule via `/fire`; cap is the ceiling.
-- **Chosen**: Conditional. Default to (a). FR-001 AC-001-1 verifies; if FAIL, fall back to (b) per the contract's deliverable-flow.
-- **Rationale**: The (a) path leaves headroom for re-plans without trading-off productive work; (b) is workable with discipline.
-- **Affects**: NFR-001, NFR-006, FR-001, FR-002, FR-003, FR-018, FR-021.
+### ADR-002: Cap-handling strategy = every Executor fire is `/fire`-API-driven and cap-counted (revised 2026-05-04 — the cap-exempt `/schedule` path never existed)
+- **Context**: The original ADR-002 hinged on the assumption that programmatic `/schedule`-from-inside-a-routine produced cap-exempt one-offs (load-bearing for FR-001 AC-001-1). v1 build discovery: Anthropic exposes no programmatic `/schedule` API at all. The conditional collapses.
+- **Options considered (revised)**: (a) keep-the-conditional, blocked by reality (no `/schedule` API exists); (b) **CHOSEN — every Executor fire is `/fire`-API-driven and cap-counted; daily cap budget = 1 Planner + N Executors per pair-session approved by Planner; cap-exhaustion fallback is to skip lowest-priority pair-sessions per Planner output**.
+- **Chosen**: (b) unconditional `/fire`-API-driven cap-counted model.
+- **Rationale**: There is no architectural-conditional left because there is no `/schedule` API to verify. A 1 + N cap budget where N ≤ 13 on a fully-approved day leaves ≥1 slot for operator-driven re-plans on most days; on heavy-news days where N approaches 14, the cron tick's skip-lowest-priority fallback ensures the system gracefully degrades rather than hard-stopping.
+- **Affects**: NFR-001, NFR-006, FR-001 (AC-001-1 + EC-001-1 dropped, FR-001 retitled to "three" assumptions), FR-002 (AC-002-2 substep h rewritten), FR-003 (AC-003-1, AC-003-2 rewritten), FR-018, FR-021 (AC-021-4 rewritten).
```

**Reasoning**: User-enumerated; full ADR-002 replacement per the EDIT request body. The original ADR-002 § "Affects" line listed FRs that have themselves been rewritten by this same EDIT; updated reflects the final state.

---

#### Patch 23 — ADR-004 (drop `claude /run` fallback for `/replan`)

**File**: `.harness/spec/architecture.md`
**Location**: § Key Stack Decisions (ADRs) → ADR-004

```diff
-### ADR-004: `/fire` API beta-header pinning
-- **Context**: `experimental-cc-routine-2026-04-01` may be bumped with breaking changes per Anthropic's own warning.
-- **Options considered**: Pin to current header in env var, fail loudly on bump; auto-upgrade on each bump (risky); abandon `/fire` for `claude /run` Bash (no HTTP path).
-- **Chosen**: Pin the header in a `ROUTINE_BETA_HEADER` env var; CI smoke-test runs every commit; manual-controlled upgrade. Telegram `/replan` falls through `claude /run` so dashboard `/fire` outage doesn't kill the operator's primary control surface.
-- **Rationale**: Stability with documented upgrade path.
-- **Affects**: NFR-001, FR-018.
+### ADR-004: `/fire` API beta-header pinning (revised 2026-05-04 — drop `claude /run` fallback)
+- **Context**: `experimental-cc-routine-2026-04-01` may be bumped with breaking changes per Anthropic's own warning. v1.1 cascade: under the post-pivot architecture (every Executor fire is `/fire`-API-driven via the cron tick), there is no `/run` Bash path that could meaningfully serve as a `/fire` outage fallback — both paths terminate at the `/fire` API.
+- **Options considered (revised)**: Pin to current header in env var, fail loudly on bump (CHOSEN); auto-upgrade on each bump (risky); abandon `/fire` for `claude /run` Bash — REJECTED at v1.1 because `/run` would still need to drive the same `/fire` to schedule the Executor and adds no rollback value.
+- **Chosen**: Pin the header in a `ROUTINE_BETA_HEADER` env var; CI smoke-test runs every commit; manual-controlled upgrade. The dashboard's `/api/internal/anthropic/fire` route is the operator-driven retry path during a beta-header outage (after rolling the env value).
+- **Rationale**: Stability with documented upgrade path; no false-fallback comfort from `/run`.
+- **Affects**: NFR-001, FR-018, RISK-003.
```

**Reasoning**: Cascade dependency the user may have missed — RISK-003 (which the user explicitly patched) had a parallel `/run` fallback statement in ADR-004. Brought into consistency.

---

### File: `.harness/evaluator/criteria.md`

#### Patch 23a — Evaluator criteria: drop AC-001-1 from spike-artefact verification list

**File**: `.harness/evaluator/criteria.md`
**Location**: § How to test (Evaluator), the FR-001 spike-artefact bullet (line 54)

```diff
-- Verify FR-001 spike artefacts: read the `routine_runs` audit rows for the spike runs; confirm `/usage` was checked before/after AC-001-1; confirm the duration measurement for AC-001-2; confirm the `/fire` smoke test for AC-001-3; confirm the 24h Channels-session token measurement for AC-001-4.
+- Verify FR-001 spike artefacts: read the `routine_runs` audit rows for the spike runs; confirm the duration measurement for AC-001-2; confirm the `/fire` smoke test for AC-001-3; confirm the 24h Channels-session token measurement for AC-001-4. (AC-001-1 cap-exempt verification was DROPPED in v1.1 per ADR-002 revised — no programmatic `claude /schedule` API exists; no spike artefact to verify.)
```

**Reasoning**: Cascade — the Evaluator's testing checklist explicitly looked for AC-001-1's `/usage` before/after evidence. Without this patch, the Evaluator would mark AC-001-1 as failing the artefact-verification check on every future evaluation run. EDIT-mode constraints permit patching `criteria.md`.

---

#### Patch 23b — Evaluator criteria: drop "cap-exempt assumption taken on faith" anti-pattern (now resolved)

**File**: `.harness/evaluator/criteria.md`
**Location**: § What failing work looks like (or the equivalent section header at line 41)

```diff
-- The cap-exempt assumption taken on faith (no FR-001 spike, no spike output committed, no fallback path coded)
+- The cap-accounting model taken on faith without spike or audit-row evidence (was originally framed as the cap-exempt `/schedule` assumption — DROPPED in v1.1 per ADR-002 revised; the new failure mode is missing audit rows in `cap_usage_local` for any cap-burning code path)
```

**Reasoning**: Cascade — the original failure-mode anchored on the dropped cap-exempt assumption. Re-anchored on the v1.1 model: every cap-burning code path must write a `cap_usage_local` row (per FR-021 AC-021-1), and missing rows is the new "taken on faith" failure mode.

---

### File: `.harness/features/001-foundation-routines-channels-dashboard/contract.md`

#### Patch 23c — Component prose description (line 61): drop "four spike modules" + "schedule-fire selector"

**File**: `.harness/features/001-foundation-routines-channels-dashboard/contract.md`
**Location**: § Component/Module Breakdown, the `packages/routines/` bullet

```diff
-- **`packages/routines/`** — Trading core. Planner + Executor TS body code (run inside Anthropic Routines as Bash steps), four spike modules (FR-001), news-fetch port (FR-014), prompt-loader (constitution §2 byte-identity), MT5 REST client, Telegram Bot API client (FR-019), schedule-fire selector (Spike 1 outcome → `claude /schedule` Bash vs `/fire` API).
+- **`packages/routines/`** — Trading core. Planner + Executor TS body code (run inside Anthropic Routines as Bash steps), three spike modules (FR-001 — Spike 1 cap-exempt verification was DROPPED in v1.1 per ADR-002 revised), news-fetch port (FR-014), prompt-loader (constitution §2 byte-identity), MT5 REST client, Telegram Bot API client (FR-019). The cron tick at `/api/cron/fire-due-executors` (in `packages/dashboard/`) is the sole fire path; no schedule-fire selector module exists in v1.1.
```

**Reasoning**: Cascade — the prose description still referenced "four spike modules" and "schedule-fire selector" both of which contradict the directory-structure patch (Patch 24). Brought into consistency.

---

#### Patch 24 — Directory structure: drop schedule-fire.ts + ac-001-1 spike file

**File**: `.harness/features/001-foundation-routines-channels-dashboard/contract.md`
**Location**: § Directory Structure, packages/routines/src/

```diff
 │   │   ├── src/
 │   │   │   ├── planner.ts                                 # FR-002
 │   │   │   ├── executor.ts                                # FR-003 (first 20 lines = pre-fire stale-check)
 │   │   │   ├── spike/
-│   │   │   │   ├── ac-001-1-cap-exempt.ts
 │   │   │   │   ├── ac-001-2-duration-and-math.ts          # combines duration + math fidelity
 │   │   │   │   ├── ac-001-3-fire-api.ts                   # ALSO probes deployed-prompt READ endpoint (R1)
 │   │   │   │   └── ac-001-4-token-soak.ts
 │   │   │   ├── news.ts                                    # FR-014
 │   │   │   ├── ffcal.ts                                   # ForexFactory MCP client
 │   │   │   ├── mt5.ts                                     # MT5 REST client (typed)
 │   │   │   ├── telegram-bot.ts                            # FR-019 direct Bot API
 │   │   │   ├── prompt-loader.ts
 │   │   │   ├── preserve-mirror/                           # byte-identical mirror of .harness/spec/preserve/
 │   │   │   │   ├── spartan-systemprompt.md
 │   │   │   │   └── planner-systemprompt.md
 │   │   │   ├── time.ts                                    # GMT/UTC helpers (constitution §5)
 │   │   │   ├── cap-counter.ts                             # FR-021 AC-021-1
 │   │   │   ├── routine-runs.ts                            # withAuditOrAbort wrapper
-│   │   │   ├── schedule-fire.ts                           # claude /schedule vs /fire selector
 │   │   │   └── compute-python-mcp/                        # CONDITIONAL — only if FR-013 builds
 │   │   │       └── server.ts                              # Vercel Function exposing MCP server
```

**Reasoning**: Cascade — `ac-001-1-cap-exempt.ts` was the spike for the dropped AC-001-1; `schedule-fire.ts` was the selector between `/schedule` Bash and `/fire` API, which is no longer needed since only `/fire` exists. Both files are dead under the new architecture.

---

#### Patch 25 — FR → Implementation Mapping: FR-001 row

**File**: `.harness/features/001-foundation-routines-channels-dashboard/contract.md`
**Location**: § FR → Implementation Mapping, FR-001 row

```diff
-| FR-001 | routines/spike + db/audit | `packages/routines/src/spike/ac-001-{1,2,3,4}.ts`, `docs/spike-report-fr-001.md`, `.harness/data/spike-fr-001-outcomes.json` (NEW — feeds Tier 2 prompt-preserve test) | Each spike writes `routine_runs` row + appends to spike-report; vitest math-fidelity in CI; Spike 3 ALSO probes deployed-prompt READ endpoint (R1) |
+| FR-001 | routines/spike + db/audit | `packages/routines/src/spike/ac-001-{2,3,4}.ts`, `docs/spike-report-fr-001.md`, `.harness/data/spike-fr-001-outcomes.json` (NEW — feeds Tier 2 prompt-preserve test) | Each spike writes `routine_runs` row + appends to spike-report; vitest math-fidelity in CI; Spike 3 ALSO probes deployed-prompt READ endpoint (R1). Spike 1 (AC-001-1 cap-exempt verification) DROPPED in v1.1 — no `claude /schedule` API exists; replaced by ADR-002 revised model. |
+
```

**Reasoning**: Cascade — file glob shrinks `{1,2,3,4}` → `{2,3,4}`; explanatory note added.

---

#### Patch 26 — FR → Implementation Mapping: FR-002 row

**File**: `.harness/features/001-foundation-routines-channels-dashboard/contract.md`
**Location**: § FR → Implementation Mapping, FR-002 row

```diff
-| FR-002 | routines/planner.ts + db | `packages/routines/src/planner.ts`, `news.ts`, `schedule-fire.ts`, `prompt-loader.ts` | vitest with mocked deps + `replan-cleanup.test.ts` for EC-002-3 ordering (R3) |
+| FR-002 | routines/planner.ts + db | `packages/routines/src/planner.ts`, `news.ts`, `prompt-loader.ts` | vitest with mocked deps + `replan-cleanup.test.ts` for EC-002-3 ordering (R3); Planner writes `pair_schedules` rows in `status='scheduled'` only — cron tick at `/api/cron/fire-due-executors` does the firing |
```

**Reasoning**: Cascade — drops `schedule-fire.ts` (file deleted); adds an explanatory note about the new write-then-cron-read flow.

---

#### Patch 27 — Deliverable D1 (FR-001): drop AC-001-1 + EC-001-1

**File**: `.harness/features/001-foundation-routines-channels-dashboard/contract.md`
**Location**: § Deliverables → D1: [FR-001] Architecture-spike verification (M0)

```diff
-### D1: [FR-001] Architecture-spike verification (M0)
-- AC-001-1, AC-001-2, AC-001-3, AC-001-4
-- EC-001-1, EC-001-2, EC-001-3, EC-001-4
-- Output artefact: `docs/spike-report-fr-001.md` committed to repo; ADRs in `.harness/spec/architecture.md` updated if any assumption FAILED; `.harness/data/spike-fr-001-outcomes.json` committed (drives Tier 2 prompt-preserve conditional)
+### D1: [FR-001] Architecture-spike verification (M0)
+- AC-001-2, AC-001-3, AC-001-4
+- EC-001-2, EC-001-3, EC-001-4
+- Output artefact: `docs/spike-report-fr-001.md` committed to repo; ADRs in `.harness/spec/architecture.md` updated if any assumption FAILED; `.harness/data/spike-fr-001-outcomes.json` committed (drives Tier 2 prompt-preserve conditional)
+- **v1.1 retro note**: AC-001-1 (cap-exempt `/schedule` verification) and EC-001-1 (its FAIL-path edge case) DROPPED — no programmatic `claude /schedule` API exists. ADR-002 revised; Planner writes `pair_schedules` rows in `status='scheduled'` and the every-minute cron tick at `/api/cron/fire-due-executors` fires Executors via `/fire` API.
```

**Reasoning**: Cascade — drops AC-001-1 and EC-001-1 from the deliverable; retains the spike-report scaffolding; adds a retro note for the v1.1 pivot.

---

#### Patch 28 — Test Criteria flat list: drop AC-001-1 + EC-001-1 lines

**File**: `.harness/features/001-foundation-routines-channels-dashboard/contract.md`
**Location**: § Test Criteria (flat list for Evaluator in EVALUATE mode), the FR-001 lines

```diff
-- [ ] AC-001-1 through AC-001-4 (FR-001)
-- [ ] EC-001-1 through EC-001-4 (FR-001)
+- [ ] AC-001-2 through AC-001-4 (FR-001) — AC-001-1 DROPPED in v1.1 per ADR-002 revised
+- [ ] EC-001-2 through EC-001-4 (FR-001) — EC-001-1 DROPPED in v1.1 (was the AC-001-1 FAIL-path edge case)
```

**Reasoning**: Cascade — Evaluator reads this list directly; AC-001-1 / EC-001-1 must not appear or the Evaluator will look for them and fail the unmet-criterion check.

---

#### Patch 29 — Build Order M2 step 13: drop schedule-fire selector

**File**: `.harness/features/001-foundation-routines-channels-dashboard/contract.md`
**Location**: § Build Order → M2 step 13

```diff
-13. **FR-002** Planner routine TS body + prompt-loader + schedule-fire selector + (R3) Executor pre-fire stale-check helper used by FR-003.
+13. **FR-002** Planner routine TS body + prompt-loader + (R3) Executor pre-fire stale-check helper used by FR-003. (No schedule-fire selector — the cron tick at `/api/cron/fire-due-executors` is the sole fire path under v1.1 ADR-002 revised.)
```

**Reasoning**: Cascade — drops the dead `schedule-fire selector` reference.

---

#### Patch 30 — Definition of Done: "four LOAD-BEARING ASSUMPTIONS" → "three"

**File**: `.harness/features/001-foundation-routines-channels-dashboard/contract.md`
**Location**: § Definition of Done, the "Functionality 8/10" line

```diff
-- Functionality 8/10 means the four LOAD-BEARING ASSUMPTIONS were verified and any failure produced a coded fallback per the FR-001 ECs — no "TODO verify" in committed code.
+- Functionality 8/10 means the three LOAD-BEARING ASSUMPTIONS were verified and any failure produced a coded fallback per the FR-001 ECs — no "TODO verify" in committed code. (The original fourth assumption — cap-exempt `/schedule`-from-inside-a-routine — was DROPPED in v1.1 per ADR-002 revised, since no programmatic `claude /schedule` API exists.)
```

**Reasoning**: User-enumerated cascade — same "four → three" change as the FR-001 title.

---

#### Patch 31a — Definition of Done implementation-report.md line: drop AC-001-1 reference

**File**: `.harness/features/001-foundation-routines-channels-dashboard/contract.md`
**Location**: § Definition of Done, the `implementation-report.md` documents bullet (line 690)

```diff
-- `implementation-report.md` documents: which spike outcomes (FR-001 AC-001-1 through AC-001-4) were PASS vs PARTIAL vs FAIL, what fallback path was taken in each PARTIAL/FAIL case, every silent-default override the operator made between PLAN and BUILD, AND for the new ACs (AC-002-1-b, AC-003-1-b): whether Tier 2 deployed-side prompt-preservation is RUNNING (Spike 3 found endpoint) or SKIPPED (operator pre-deploy checklist used instead).
+- `implementation-report.md` documents: which spike outcomes (FR-001 AC-001-2 through AC-001-4) were PASS vs PARTIAL vs FAIL (AC-001-1 dropped in v1.1 per ADR-002 revised), what fallback path was taken in each PARTIAL/FAIL case, every silent-default override the operator made between PLAN and BUILD, AND for the new ACs (AC-002-1-b, AC-003-1-b): whether Tier 2 deployed-side prompt-preservation is RUNNING (Spike 3 found endpoint) or SKIPPED (operator pre-deploy checklist used instead).
```

**Reasoning**: Cascade — yet another reference to "AC-001-1 through AC-001-4" that must drop AC-001-1 to be consistent.

---

#### Patch 31 — vercel.json crons section: editorial note for the new cron endpoint

**File**: `.harness/features/001-foundation-routines-channels-dashboard/contract.md`
**Location**: § API Surface § Cron schedule (`packages/dashboard/vercel.json`), the comment block at the bottom

```diff
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

+**v1.1 amendment**: The every-minute cron tick at `/api/cron/fire-due-executors` (Planner-write → cron-fire model per ADR-002 revised) is sub-daily and Hobby-plan-blocked from Vercel cron. It SHOULD live on GitHub Actions in parity with `cron-channels-health.yml` and `cron-synthetic-ping.yml` (per AC-005-2 amendment) — `.github/workflows/cron-fire-due-executors.yml` schedule `* * * * *`. If the operator's deployed v1.1 chose a different runtime (Vercel Pro upgrade, external scheduler, etc.), update this comment in a follow-up `/harness:edit`. See UNCLEAR § in this edit-patches file.
+
```

**Reasoning**: Cascade — surfaces the new every-minute cron endpoint to the contract's Cron-schedule documentation and signals the Hobby-plan routing question. Conservative — adds an editorial note rather than committing to a runtime choice in case the operator chose differently.

---

## Unclear items

### U1 — "renumber remaining ACs" instruction

**Original quote**: "FR-001 description ('the four LOAD-BEARING ASSUMPTIONS' — drop AC-001-1 /schedule verification entirely, since no /schedule API exists; **renumber remaining ACs**); EC-001-1 (remove since AC-001-1 itself is dropped)"

**Why unclear**: The CONSTRAINTS block in the dispatch says "Preserve all IDs (FR-NNN, NFR-NNN, AC-NNN, EC-NNN, RISK-NNN, SD-NNN, ADR-NNN, §-numbers)." The user's "renumber" instruction conflicts with this universal preservation rule. AC-001-1 is referenced from at least 6 downstream specs (PRD AC-021-4 — patched here; PRD RISK-001 — patched here; contract D1 — patched here; contract Test Criteria — patched here; contract `ac-001-{1,2,3,4}.ts` — patched here; PRD line 261 references AC-001-2 by its current number for the math-fidelity gate, which would shift if I renumbered AC-001-2 → AC-001-1).

**Suggested resolution**: Two options for the user to pick:

- **Option A (chosen by these patches)**: Drop AC-001-1 only; leave AC-001-2 / AC-001-3 / AC-001-4 numbered as-is. The FR-001 title and intro re-anchor on "the three" (was "the four"). All downstream cross-references continue to work because the numbers they reference still exist. **Risk**: AC numbering has a one-number gap (1-3, 4 missing? no — 2, 3, 4 with 1 missing). Auditable by `git log` / spec history.

- **Option B (true renumber)**: AC-001-2 → AC-001-1, AC-001-3 → AC-001-2, AC-001-4 → AC-001-3. EC-001-2 → EC-001-1, EC-001-3 → EC-001-2, EC-001-4 → EC-001-3. Plus cascade across PRD line 261 (math-fidelity gate), PRD line 350 (`/v1/usage` exposure check reference), contract D1, contract Test Criteria, contract spike file names (`ac-001-{1,2,3}.ts`), PRD AC-021-4 (already patched but the "FR-001 AC-001-1" text would need to refer to the new "AC-001-1" which is the duration spike). **Risk**: If option B is chosen, request a follow-up `/harness:edit` to do the renumber-cascade safely; doing it inline in this patch set would inflate the diff substantially and risk leaving stale AC-001-N references in still-uncascaded prose.

If the user does not respond, Option A stands.

---

## Out-of-scope items

### OOS1 — Runtime choice for the every-minute cron at `/api/cron/fire-due-executors`

**Original quote**: "the cron tick at /api/cron/fire-due-executors fires them via /fire when start_time_gmt is reached"

**Why out of scope**: The user's request describes the cron tick as a logical concept but does not specify the runtime (Vercel cron vs GitHub Actions cron vs external scheduler). The contract already has a documented Hobby-plan rule (sub-daily crons cannot be Vercel crons; `channels-health` and `synthetic-ping` live on GitHub Actions per AC-005-2 amendment). The every-minute fire-due-executors cron is sub-daily and would inherit the same routing constraint by parity.

**Suggested resolution**:
- If the operator's deployed v1.1 uses GitHub Actions cron at schedule `* * * * *`, the editorial note in Patch 31 stands and a follow-up `/harness:edit` "add `cron-fire-due-executors.yml` workflow file + GitHub Secrets entry" can fully formalize it.
- If the operator chose a different runtime (Vercel Pro upgrade, external service, in-process timer), `/harness:edit "document the actual runtime for the fire-due-executors cron"` to update Patch 31's editorial note.
- Either way, this is a follow-up edit — not blocking the spec-level pivot in this patch set.

---

### OOS2 — `.harness/progress/decisions.md` ADR-002 historical entry

**Original quote**: (implicit — the user enumerated `architecture.md` ADR-002 but `decisions.md` has its own ADR-002 mirror that is append-only)

**Why out of scope**: `.harness/progress/decisions.md` is documented as append-only across all subagents (changelog/decisions live there permanently for audit replay). Editing the historical entry would erase the v1-as-built record. The right move is to append a NEW dated entry ("ADR-002 revised 2026-05-04") referencing this edit-patches.md, rather than rewrite the original.

**Suggested resolution**:
- After the orchestrator applies this edit set, run `/harness:retrospective` — the retrospective skill is designed to log post-build drift findings (which this v1.1 corrective IS) into decisions.md as a new entry.
- Or manually append the ADR-002 revised entry citing edit-patches.md Patch 22 as the source-of-truth.
- Either way, this is post-application housekeeping — not blocking the spec-level pivot in this patch set.

---

## No-op verification items (user said "unchanged" — confirmed unchanged)

- **RISK-002 mitigation** — User said "Executor split is unchanged". Current text reads: "If exceeded, split MSCP into two phases (data-fetch + reasoning, then a chained one-off for order placement). If splitting still doesn't fit, fall back to Sonnet 4.6 for the Executor (faster, less verbose, still covers MSCP). Recorded in ADR-003." Confirmed: no `/schedule` reference in this mitigation; no patch needed.

- **SD-009** — User said "manual /fire is the operator-driven retry, unchanged". Current text reads: "Error path for Executor failures = log audit row, send Telegram alert, NO automatic retry-the-Executor (one-offs can't easily reschedule themselves; manual `/fire` is the operator-driven retry)." Confirmed: already says manual `/fire`; no patch needed. (The "one-offs can't easily reschedule themselves" sub-clause is now slightly off-story under the new model since the cron tick CAN reschedule, but the user explicitly said "unchanged" so I leave it for the next edit cycle.)
