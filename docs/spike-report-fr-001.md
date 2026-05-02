# FR-001 Architecture Spike Report

> **Status**: PRE-RUN TEMPLATE — populated by operator after the live spikes execute.
>
> **Source of truth**: `.harness/data/spike-fr-001-outcomes.json` is the machine-readable outcome file consumed by downstream tests (notably Tier 2 prompt-preservation gating in AC-002-1-b / AC-003-1-b). This Markdown report is the human-readable summary committed alongside.

**Feature**: 001-foundation-routines-channels-dashboard
**Spec version**: 1
**Created**: 2026-05-03
**Last updated**: 2026-05-03 (template only — no live runs yet)

---

## Why this report exists

FR-001 verifies four LOAD-BEARING UNVERIFIED ASSUMPTIONS that the rest of the build depends on. From the PRD:

> The four assumptions are: (1) one-off scheduling from inside a routine is cap-exempt; (2) the Executor's typical run fits within the routine duration limit AND Opus 4.7 1M's math fidelity matches a Python reference; (3) the `/fire` API works with the pinned beta header; (4) combined Routines + Channels token use stays ≤ 80% of Max 20x weekly cap.

Each spike below produces a verdict (PASS / PARTIAL / FAIL) and a fallback path if the assumption breaks. The decisions made here cascade into ADR-002 (cap-handling), ADR-003 (Executor LLM), ADR-004 (beta-header pinning), ADR-008 (cap-monitoring source), and the FR-013 SKIP/BUILD decision.

---

## Pre-requisites the operator must complete before live runs

Per the contract's "Setup required" section, the spikes need:

1. **Anthropic Console — Routines beta access.** Confirm your plan includes Routines + Channels.
2. **No-op spike routine.** In the Anthropic console, create a routine named `财神爷-spike-noop` with body `echo "OK" > /tmp/spike1.flag` and capture its `routine_id` + bearer.
3. **Planner routine** (`财神爷-planner`) created with the SPARTAN system prompt — capture `routine_id` + bearer.
4. **`.env.local`** populated with `SPIKE_NOOP_ROUTINE_ID`, `SPIKE_NOOP_ROUTINE_BEARER`, `PLANNER_ROUTINE_ID`, `PLANNER_ROUTINE_BEARER`, `ROUTINE_BETA_HEADER` (default `experimental-cc-routine-2026-04-01`).
5. **Python reference environment** for Spike 2's math-fidelity comparison: `python3.12 + numpy + pandas + ta-lib` (used to compute the ground-truth ATR + structure-key SL prices for the 958-bar OHLC fixture in `tests/fixtures/spike/`).
6. **24-48h elapsed time** for Spike 1 (12-min wait between schedule + flag check) and Spike 4 (24h token-soak window).

If any of these is missing, `bash .harness/init.sh` should exit non-zero with copy-paste instructions per FR-020 AC-020-3.

---

## Spike 1 — Cap-exempt one-off scheduling (AC-001-1)

**Code**: `packages/routines/src/spike/ac-001-1-cap-exempt.ts`
**Tests**: `packages/routines/tests/spike/ac-001-1-cap-exempt.test.ts`

### Procedure

1. Inside the spike routine's Bash step:
   - `bun run packages/routines/src/cap-counter.ts --kind=spike_pre`
   - `claude /schedule "in 10 minutes, run a no-op shell command (echo OK > /tmp/spike1.flag)"`
   - Capture stdout (one-off ID + scheduled time)
   - Exit
2. Wait 12 minutes (or run as two routine fires).
3. Post-condition checks:
   - `/tmp/spike1.flag` exists on the routine's filesystem? (proves one-off ran)
   - `/usage` delta = 0? (proves cap-exempt)

### Verdict mapping

| Outcome                              | Status   | ADR action                                                         |
| ------------------------------------ | -------- | ------------------------------------------------------------------ |
| flag exists AND delta = 0            | PASS     | Default ADR-002 path (a) holds — Planner schedules via `/schedule` |
| flag exists AND delta ≥ 1            | PARTIAL  | Switch ADR-002 to fallback (b) `/fire` API + saved routines        |
| flag missing                         | FAIL     | Re-evaluate ADR-002 entirely; escalate to operator                 |

### Live run: PENDING

Operator: append a row to the table below after the live run.

| Run date | flag exists | /usage before | /usage after | Delta | Status | Notes |
| -------- | ----------- | ------------- | ------------ | ----- | ------ | ----- |
| _pending_ | _pending_  | _pending_     | _pending_    | _pending_ | _PENDING_ | _pending_ |

---

## Spike 2 — Executor duration + math fidelity (AC-001-2)

**Code**: `packages/routines/src/spike/ac-001-2-duration-and-math.ts`
**Tests**: `packages/routines/tests/spike/ac-001-2-duration-and-math.test.ts`

### Procedure

1. Prepare frozen 958-bar OHLC fixture for EUR/USD (`tests/fixtures/spike/`).
2. Inside the spike routine, run the Executor with the SPARTAN system prompt and the 958-bar fixture; record T0 and T1.
3. Parse LLM output for: ATR(14) on 1H, structure-key SL price, position-size at 5% risk.
4. Run Python reference (ta-lib ATR + SPARTAN SL formula); compute `max_relative_error` over the three numbers.
5. Repeat for a second consecutive run (duration must hold across two runs).

### Verdict mapping

| duration_ok | math_ok (< 1e-3) | Status   | FR-013 | ADR action                                                  |
| ----------- | ---------------- | -------- | ------ | ----------------------------------------------------------- |
| ✓           | ✓                | PASS     | SKIP   | No architecture change                                       |
| ✓           | ✗                | PARTIAL  | BUILD  | FR-013 builds with Vercel Sandbox compute_python MCP        |
| ✗           | ✓                | PARTIAL  | SKIP   | ADR-003 fallback: Sonnet 4.6 OR split-Executor              |
| ✗           | ✗                | FAIL     | —      | Escalate to operator                                         |

### Live run: PENDING

Operator: append a row after the live run.

| Run date | T1-T0 (run 1) | T1-T0 (run 2) | maxRelErr | Status | FR-013 | Notes |
| -------- | ------------- | ------------- | --------- | ------ | ------ | ----- |
| _pending_ | _pending_    | _pending_     | _pending_ | _PENDING_ | _pending_ | _pending_ |

---

## Spike 3 — /fire API + deployed-prompt READ probe (AC-001-3)

**Code**: `packages/routines/src/spike/ac-001-3-fire-api.ts`
**Tests**: `packages/routines/tests/spike/ac-001-3-fire-api.test.ts`

### Procedure

1. Pre-create the no-op routine (`财神爷-spike-noop`) in the Anthropic console.
2. From the dev laptop:
   ```bash
   bun run --cwd packages/routines spike:3
   ```
   Spike 3 module: posts `/fire`, asserts response shape; THEN probes two GET endpoints to discover deployed-prompt READ availability.
3. Spike 3 also pins the beta header: failure here → Telegram alert per ADR-004.

### Live run: PENDING

| Run date | /fire status | session_id captured? | session_url reachable? | deployed_prompt_endpoint | Tier 2 enabled? | Notes |
| -------- | ------------ | -------------------- | ---------------------- | ------------------------ | ---------------- | ----- |
| _pending_ | _pending_    | _pending_           | _pending_              | _pending_                | _pending_        | _pending_ |

### R1 — Tier 2 prompt-preservation gate

If `deployed_prompt_endpoint != null` after Spike 3:
- **Tier 2 ENABLED**: `prompt-preserve-deployed.test.ts` runs in CI on every push.
- The endpoint URL pattern is recorded in `.harness/data/spike-fr-001-outcomes.json`.

If `deployed_prompt_endpoint == null`:
- **Tier 2 SKIPPED**: vitest test calls `test.skip(...)`.
- `implementation-report.md` flags constitution §2 verification as Tier 1 (file-side) only.
- `docs/operator-pre-deploy-checklist.md` (this repo) gains a manual screenshot+diff step before any prompt deployment.

---

## Spike 4 — 24h Routines + Channels token soak (AC-001-4)

**Code**: `packages/routines/src/spike/ac-001-4-token-soak.ts`
**Tests**: `packages/routines/tests/spike/ac-001-4-token-soak.test.ts`

### Procedure

1. Take screenshot of `/usage` at T0.
2. Over 24h:
   - 14 Executor-shaped fires spaced 1h apart
   - 1 daily Planner fire
   - 50 synthetic Telegram messages (mix of slash commands + 3-turn free-text)
3. Take screenshot of `/usage` at T0+24h.
4. `delta_pct = post_pct - pre_pct`; `projected_weekly = delta_pct × 7 / 0.71` (oversampling adjustment).
5. ALSO probe `https://api.anthropic.com/v1/usage` to see if the endpoint is exposed (drives ADR-008 reconciliation-cron decision).

### Verdict mapping

| Projected weekly pct | Status  | Action                                                                 |
| -------------------- | ------- | ---------------------------------------------------------------------- |
| ≤ 80%                | PASS    | No architecture change                                                 |
| 80–95%               | PARTIAL | FR-021 hard-stop alert at 12/15 daily AND record in architecture.md     |
| > 95%                | FAIL    | Degrade Channels session to slash-only + cap free-text Q&A at 1K out   |

### Live run: PENDING

| Run window | pre_pct | post_pct | Δ | Projected weekly | Status | /v1/usage exposed? | Notes |
| ---------- | ------- | -------- | -- | ---------------- | ------ | ------------------ | ----- |
| _pending_  | _pending_ | _pending_ | _pending_ | _pending_ | _PENDING_ | _pending_ | _pending_ |

---

## ADR updates triggered by this spike

After all four spikes complete, the following ADRs may need updates:

- **ADR-002** (cap-handling) — Spike 1 result picks default vs fallback path.
- **ADR-003** (Executor LLM) — Spike 2 duration result triggers Sonnet/split fallback if needed.
- **ADR-004** (beta-header pinning) — Spike 3 failure triggers Telegram alert + manual upgrade path.
- **ADR-008** (cap-monitoring source) — Spike 4 step 5 picks v1 path: local-counters-only OR add reconciliation cron.
- **FR-013** (compute_python MCP) — Spike 2 math-fidelity verdict picks SKIP vs BUILD.
- **AC-002-1-b / AC-003-1-b** (Tier 2 prompt-preservation) — Spike 3 step 6 picks ENABLE vs SKIP.

The spike runner reports each verdict + the recommended ADR delta. Operator applies the deltas via `/harness:edit` or `/harness:amend` if needed before the build proceeds past M0.

---

## Implementation status (code-side)

| Spike | Module | Tests | Live run |
| ----- | ------ | ----- | -------- |
| 1 (AC-001-1) | ✓ committed | ✓ 10 cases pass | PENDING (operator) |
| 2 (AC-001-2) | ✓ committed (helper + verdict only) | ✓ 11 cases pass | PENDING (operator) |
| 3 (AC-001-3) | ✓ committed (full HTTP path + R1 probe) | ✓ 14 cases pass | PENDING (operator) |
| 4 (AC-001-4) | ✓ committed (projection + verdict only) | ✓ 4 cases pass | PENDING (operator) |

The CODE is testable and committed. The LIVE RUNS are operator-gated until the Anthropic Routine bearers + deployed routines exist.
