# Analysis Report — 001 Foundation: Routines + Channels + Dashboard + Audit

**Generated**: 2026-05-02
**Source files analyzed**: spec/prd.md (489 lines), spec/architecture.md (128 lines), spec/constitution.md (63 lines), features/001-…/contract.md (254 lines), spec/preserve/spartan-systemprompt.md, spec/preserve/planner-systemprompt.md
**Method**: cross-referenced PRD's 21 FRs + 78 ACs + ~33 ECs + 10 NFRs + 5 UJs against architecture's stack table + 9 ADRs + NFR Feasibility Check, against constitution's 17 principles, against contract's 22 deliverables + flat AC/EC test list + NFR measurement plan, and against the brainstorm's hard exclusions (TradingView, backtesting, multi-account, GBP/JPY).

## FR Coverage Matrix

| FR | Title (short) | In Architecture? | In Contract? (deliverable) | Milestone | Finding |
|---|---|---|---|---|---|
| FR-001 | Architecture spike (4 load-bearing assumptions) | yes (ADR-002, ADR-003, ADR-004 reference this FR's outcomes) | yes (D1) | M0 | — |
| FR-002 | Daily Planner Routine | yes (Stack: Sonnet 4.6, Routines; ADR-002 conditional behavior) | yes (D10) | M2 | — |
| FR-003 | Per-pair Executor Routines | yes (Stack: Opus 4.7 1M, Routines; ADR-003) | yes (D11) | M2 | — |
| FR-004 | Always-on Channels session | yes (Stack: Channels Telegram plugin; ADR-001) | yes (D19) | M4 | — |
| FR-005 | Channels-session health check + crash recovery | yes (ADR-009 daily restart; constitution §15 partial) | yes (D20) | M4 | — |
| FR-006 | Mission-control dashboard | yes (Stack: Next.js 16, shadcn, Recharts, Auth.js; NFR-003 feasibility) | yes (D14, D16 closes AC-006-4, D18 closes AC-006-5) | M3 | W3 |
| FR-007 | Audit trail across the system | yes (constitution §3, §11; ADR-006 retention) | yes (D9) | M1 | — |
| FR-008 | Postgres schema with multi-tenant tenant_id | yes (Stack: Vercel Postgres + Drizzle; constitution §4, §12) | yes (D3) | M1 | — |
| FR-009 | VPS-to-cloud authenticated tunnel | yes (Stack: Cloudflare Tunnel + Access; ADR-005) | yes (D6) | M1 | — |
| FR-010 | Subscription-only auth (no ANTHROPIC_API_KEY) | yes (constitution §1, §13, §14; Stack: husky+gitleaks+make audit-no-api-key) | yes (D2 — first M1 deliverable) | M1 | — |
| FR-011 | Pair config (DB-driven) | partial (Deferred-to-Negotiation lists ORM; no specific ADR) | yes (D5) | M1 | W4 |
| FR-012 | V1 pair list seed (7 pairs, no GBP/JPY) | partial (no specific ADR; seed is data not arch) | yes (D4) | M1 | — |
| FR-013 | compute_python MCP for Executor | yes (Stack: Vercel Sandbox `compute_python` MCP) | yes (D12) | M2 | — |
| FR-014 | News fetch + markdown rendering port | partial (no specific ADR; it's a port, not a new arch decision) | yes (D8) | M1 | W4 |
| FR-015 | Trade history + report archive | yes (Stack: Vercel Blob) | yes (D15) | M3 | — |
| FR-016 | Override actions (close/edit-SL-TP) | yes (NFR-007 atomicity feasibility) | yes (D16) | M4 | — |
| FR-017 | Pause / resume agent | partial (no specific ADR; covered by override-pattern from FR-016) | yes (D17) | M4 | W4 |
| FR-018 | Force re-plan | yes (ADR-004 `/fire` API + fallback) | yes (D18) | M4 | — |
| FR-019 | Telegram report messages (preserve) | yes (ADR-007 direct Bot API) | yes (D13) | M2 | — |
| FR-020 | Initial setup script | yes (constitution §15; Stack: systemd, husky) | yes (D7) | M1 | — |
| FR-021 | Daily cap monitoring + alerts | yes (ADR-008 data-source priority) | yes (D21) | M5 | — |

**FR coverage: 21/21 mapped. 17 with full architectural treatment, 4 with partial (FR-011, FR-012, FR-014, FR-017 lack dedicated ADRs but are covered by stack choices and the constitution — see W4).**

## AC Coverage Matrix (sample of 20 — full coverage verified against contract's flat list at lines 184-225)

| AC | From FR | Test strategy in contract? | Testable? | Finding |
|---|---|---|---|---|
| AC-001-1 | FR-001 | yes (spike code exercises `claude /schedule` from inside routine) | yes | — |
| AC-001-2 | FR-001 | yes (12-min ceiling test in spike) | yes | — |
| AC-001-3 | FR-001 | yes (spike + CI smoke per ADR-004) | yes | — |
| AC-001-4 | FR-001 | yes (24h soak, target ≤80% Max 20x) | yes | — |
| AC-002-1 to 4 | FR-002 | yes (vitest + integration) | yes | — |
| AC-003-1 to 5 | FR-003 | yes (vitest + XAU/USD symbol-cleaning hard test) | yes | — |
| AC-004-1 to 6 | FR-004 | yes (record-replay + integration on staging Channels session) | yes | — |
| AC-005-1 to 3 | FR-005 | yes (Vercel cron + healthcheck endpoint test) | yes | — |
| AC-006-1 to 3 | FR-006 | yes (Playwright dashboard tests) | yes | — |
| AC-006-4 | FR-006 | yes (closed by D16 per contract line 142+152) | yes | — |
| AC-006-5 | FR-006 | yes (closed by D18 per contract line 142+161) | yes | — |
| AC-007-1 to 5 | FR-007 | yes (audit-or-abort vitest + orphan-detection cron query) | yes | — |
| AC-008-1 to 3 | FR-008 | yes (migration tests + tenant_id linter) | yes | — |
| AC-009-1 to 4 | FR-009 | yes (init.sh smoke test + tunnel reachability test) | yes | — |
| AC-010-1 to 5 | FR-010 | yes (negative test: commit ANTHROPIC_API_KEY → pre-commit hook rejects) | yes | — |
| AC-011-1 to 3 | FR-011 | yes (vitest read-path tests) | yes | — |
| AC-012-1 to 3 | FR-012 | yes (seed migration + 7-pair assertion + GBP/JPY-absent assertion) | yes | — |
| AC-013-1 to 2 | FR-013 | yes (MCP tool integration test) | yes | — |
| AC-014-1 to 3 | FR-014 | yes (snapshot tests vs n8n golden output) | yes | — |
| AC-015-1 to 2 | FR-015 | yes (Vercel Blob upload + signed URL minting test) | yes | — |
| AC-016-1 to 4 | FR-016 | yes (NFR-007 fault-injection test) | yes | — |
| AC-017-1 to 4 | FR-017 | yes (vitest + Playwright pause-state) | yes | — |
| AC-018-1 to 3 | FR-018 | yes (`/fire` integration + cap-confirmation UI test) | yes | — |
| AC-019-1 to 3 | FR-019 | yes (record-replay against Telegram Bot API) | yes | — |
| AC-020-1 to 3 | FR-020 | yes (init.sh CI run + VPS setup.sh dry-run) | yes | — |
| AC-021-1 to 4 | FR-021 | yes (mock cap data + alert threshold test) | yes | — |

**AC coverage (full count from contract flat list): 78 ACs + 33 ECs = 111 testable items, all enumerated in contract.md lines 184-225 with explicit per-FR test surface assignment.**

## NFR Coverage Matrix

| NFR | Title | In Architecture's Feasibility Check? | Measurement plan in contract? | Finding |
|---|---|---|---|---|
| NFR-001 | Trading-loop reliability ≥99.5% | yes | yes (M0 staging spike + 5×1-min stub) | — |
| NFR-002 | Telegram p95 ≤3s | yes | yes (`telegram_interactions` columns, 24h soak) | — |
| NFR-003 | Dashboard live ≤6s p95 | yes | yes (Playwright synthetic state-change) | — |
| NFR-004 | Audit completeness 100% | yes | yes (daily orphan-detection cron returns 0) | — |
| NFR-005 | No `ANTHROPIC_API_KEY` anywhere | yes | yes (`make audit-no-api-key` + gitleaks) | — |
| NFR-006 | Token budget ≤80% Max 20x weekly | yes | yes (read from Anthropic /usage at 24h soak) | — |
| NFR-007 | Override action atomicity | yes | yes (fault-injection test simulating MT5 mid-failure) | — |
| NFR-008 | TZ correctness across system | yes | yes (DST-day test, Mar 30 + Oct 26 2026) | — |
| NFR-009 | Auth on every dashboard route | yes | yes (Playwright route-enumeration test) | — |
| NFR-010 | Constitution compliance | meta (each principle is its own check) | yes (`/harness:analyze` constitutional-coverage = this report) | — |

**NFR coverage: 10/10 with both feasibility analysis and measurement plan.**

## Constitution Compliance Audit

Each principle traced to its enforcement mechanism in spec + contract:

| § | Principle | Enforcement |
|---|---|---|
| §1 | NO `ANTHROPIC_API_KEY` ANYWHERE | FR-010 (D2, M1-first) — pre-commit hook + CI lint + `make audit-no-api-key` + gitleaks. NFR-005 measurement. ✓ |
| §2 | SPARTAN + Planner prompts preserved verbatim | spec/preserve/{spartan,planner}-systemprompt.md exist (extracted from n8n); FR-002 + FR-003 reference them; CI test diffs deployed routine prompt vs file (implied in contract D10/D11). ✓ |
| §3 | AUDIT-OR-ABORT | FR-007 AC-007-1 codifies start-row-before-tool-call; ADR-006 retention; D9 deliverable. ✓ |
| §4 | Multi-tenant tenant_id from day one | FR-008 (D3) + Drizzle ORM with type-safe per-tenant filter (Stack table). ✓ |
| §5 | Timezones GMT/UTC always | NFR-008 + DST test in CI; contract Definition of Done line 236. ✓ |
| §6 | NO Google Calendar anywhere | Stack table omits Google Calendar entirely; constitution explicit; brainstorm-rejected. ✓ |
| §7 | NO n8n at runtime | Architecture explicit ("zero ongoing dependency on the tool we're replacing"). Constitution explicit. ✓ |
| §8 | TDD contract (RED→GREEN→REFACTOR) | Harness pipeline-enforced via Generator BUILD mode + git-log archaeology. Contract Definition of Done line 247. ✓ |
| §9 | vitest + Playwright | Stack table fixes; constitution explicit. ✓ |
| §10 | NO secrets in source | Stack: husky+gitleaks; constitution explicit ("specifically forbids carrying [TwelveData] pattern over"). ✓ |
| §11 | Every override writes audit row | FR-016 + NFR-007 + constitution §3 generalized. ✓ |
| §12 | NO all-tenants queries | Drizzle ORM helpers + linter rule (Stack table mentions). ✓ |
| §13 | Forbidden dependencies | Constitution explicit list (`googleapis`, `n8n-*`, `openrouter-*`, Anthropic SDKs). CI lint enforces. ✓ |
| §14 | Routines + Channels-session are the ONLY LLM callers | Architecture explicit; ADR-007 outbound Telegram is direct Bot API (zero LLM). ✓ |
| §15 | Pre-flight cleanness | FR-020 init.sh + Definition of Done line 250. ✓ |
| §16 | Naming conventions | Constitution explicit; Code Quality criterion in evaluator/criteria.md will check. ✓ |
| §17 | Forbidden patterns (no `any`, no console.log, no commented-out code, no silent catches) | Constitution explicit; Code Quality criterion will check; eslint config implied. ✓ |

**Constitution compliance: 17/17 principles have a stated enforcement mechanism. No violations detected.**

## Scope Consistency Audit

Brainstorm's hard exclusions cross-referenced:

| Excluded item | In PRD? | In Architecture? | In Contract? | Status |
|---|---|---|---|---|
| TradingView chart integration | NO | NO | NO | ✓ excluded |
| Backtesting / strategy editor UI | NO | NO | NO | ✓ excluded |
| Multi-account / multi-broker | NO (single account assumed; tenant_id default 1) | NO (single Cloudflare Tunnel to one MT5) | NO | ✓ excluded |
| GBP/JPY pair | NO (FR-012 seed: 7 pairs, GBP/JPY explicitly omitted; AC-012-3 asserts it) | NO | NO (contract item M1 #4 explicit) | ✓ excluded |

**Scope consistency: clean. All 4 brainstorm exclusions honored across all 4 spec/contract surfaces.**

## Subscription-Only Auth Gate (project hard rule)

| Check | Status |
|---|---|
| Constitution forbids `ANTHROPIC_API_KEY` | ✓ §1 |
| Constitution forbids Anthropic SDKs (would imply API key) | ✓ §13 |
| Constitution restricts LLM-callers to Routines + Channels session | ✓ §14 |
| Architecture chooses subscription-billed paths only | ✓ Stack table — Claude Code Routines + Channels, no Anthropic SDK row |
| Contract has FR-010 as M1-first deliverable | ✓ contract line 56 + D2 |
| No deliverable requires Anthropic API key billing | ✓ verified across all 22 deliverables |
| Pre-commit + CI lint + gitleaks layered | ✓ Stack table + AC-010-1..5 |

**Subscription-only auth: PASS. Layered enforcement, no escape hatch.**

## Load-Bearing Assumption Treatment Audit

| # | Assumption | Verification step | Fallback design | Architecture acknowledgment | Status |
|---|---|---|---|---|---|
| 1 | Programmatic one-off routine creation works inside a routine | AC-001-1 (spike code exercises `claude /schedule` Bash) | EC-001-1 + ADR-002 conditional (default to one-off, fall back to `/fire` cap-counted) | ADR-002 | ✓ all 3 elements present, M0 first FR |
| 2 | Routine execution duration limit fits per-pair runs (~5-15 min) | AC-001-2 (12-min ceiling test in spike) | EC-001-2 + ADR-003 (split-Executor or downgrade to Sonnet 4.6) | ADR-003 | ✓ all 3 elements present |
| 3 | `/fire` API stability under experimental beta header | AC-001-3 (spike + CI smoke) | EC-001-3 + ADR-004 (`claude /run` Bash fallback for Telegram /replan) | ADR-004 | ✓ all 3 elements present, header pinned via env var |
| 4 | Channels session token quota under Max 20x | AC-001-4 (24h soak, target ≤80% weekly) | EC-001-4 + (implicit NFR-006 + ADR-001 — degrade Channels to slash-only via Vercel Functions) | NFR-006 + ADR-001 | ✓ all 3 elements present |

**Load-bearing treatment: 4/4 assumptions have verification + fallback + ADR. M0 spike (FR-001) is the FIRST FR in build order, gating all others.**

## Tech-Stack Conflict Audit

Cross-referenced architecture stack table against PRD FR mentions and contract deliverables. No conflicts found.

Notable items deferred to negotiation phase (per architecture lines 113-128) that the Generator will choose during NEGOTIATE:
- Workspace layout (apps/packages monorepo vs single Next.js project)
- ORM (Drizzle vs Prisma — both qualify under §4)
- Date library (date-fns vs Luxon vs Day.js)
- Package manager (pnpm vs bun vs npm)

These are intentional Generator-domain decisions, not gaps.

## Dependency Ordering Audit

Build order in contract (M0 → M1 → M2 → M3 → M4 → M5) cross-checked against logical dependencies:

- ✓ M0 (FR-001 spike) precedes everything
- ✓ FR-010 (no-API-key enforcement) is M1's first item — gates every subsequent commit
- ✓ FR-008 (Postgres schema) before any FR that reads/writes rows
- ✓ FR-009 (Cloudflare Tunnel) before any FR needing MT5 access
- ✓ FR-007 (audit infrastructure) before any agent runs
- ✓ FR-002/FR-003 (routines) before FR-018 (force re-plan, which fires Planner)
- ✓ FR-004 (Channels session) before FR-005 (its health check)
- ✓ FR-021 (cap monitoring) at M5, last — depends on baseline established by all prior runs

**Dependency ordering: clean.**

## Summary

```
═══════════════════════════════
  Harness — Cross-Artifact Analysis
═══════════════════════════════
Requirement coverage:   21/21 FRs mapped       ✓
AC coverage:            78/78 ACs + 33/33 ECs in contract test list  ✓
NFR alignment:          10/10 NFRs in feasibility check  ✓
Constitution:           0 violations            ✓
Dependency ordering:    0 issues                ✓
Scope consistency:      4/4 exclusions honored  ✓
Subscription-only auth: pass                    ✓
Load-bearing treatment: 4/4                     ✓

CRITICAL findings:
  (none)

WARNINGS:
  W1: PRD mentions specific tech (Vercel Postgres, Cloudflare Tunnel, Auth.js, Next.js 16,
      shadcn/ui, SWR, systemd) — Planner self-validation flagged this as a documented V4
      exception ("operator pre-locked architecture in brainstorm"). Acceptable for a
      migration project where the brainstorm explicitly negotiated the stack, but the
      Evaluator should NOT use these PRD mentions as evidence of "architecture leakage" —
      they're transcribed user requirements.

  W2: Contract is 21 FRs / 22 deliverables in a single feature folder. Pass-2 size gate
      flagged this as advisory-oversized (>10 FRs, multi-stratum, 50+ files). The contract
      surfaces a recommended 001a/001b/001c split at top. The operator's brainstorm
      explicitly chose "ship as one big v1" with M1-M5 internal milestones. Decision
      deferred to user at this gate (see human-gate prompt).

  W3: D22 (Generator runs `impeccable` audit on dashboard, addresses findings) is process
      not product — it has no specific FR. Acceptable as a "Generator-managed final pass"
      but worth knowing the Evaluator will grade this under Product Depth criterion, not as
      a discrete FR completion.

  W4: 4 FRs (FR-011, FR-012, FR-014, FR-017) lack a dedicated ADR. They're covered by
      stack choices, constitution principles, or sibling FR patterns, but the absence of
      explicit architectural treatment means the Generator will make the design decisions
      during NEGOTIATE without ADR-level guardrails. Low risk; just track.

  W5: Operator MUST export the Claude Design bundle to design/dashboard-bundle/ BEFORE M3
      (FR-006) build starts, otherwise dashboard quality degrades to default-shadcn-template
      level (per contract line 72 + Definition of Done line 248). Manual prerequisite not
      handled by init.sh. Worth surfacing at human gate so operator knows.

  W6: PRD documented 14 silent defaults (SD-001 through SD-014). Per sprint.md auto-suggest
      rule (≥3 silent defaults), `/harness:clarify` is recommended at the human gate. The
      operator can also proceed without clarify if they accept Planner's defaults; the SDs
      will be visible in the spec for retrospective review.

Remediation (optional):
  - Address W2: at the human gate, decide single-folder vs 001a/001b/001c split.
  - Address W5: export Claude Design bundle to design/dashboard-bundle/ before M3 starts
    (can happen in parallel with M0–M2 build).
  - Address W6: consider /harness:clarify before approving, especially for the SDs that
    affect cost/security (anything in SD-001..SD-014 around tunnel transport, retention,
    or Channels token caps).

The plan is internally consistent and ready for the human approval gate.
═══════════════════════════════
```
