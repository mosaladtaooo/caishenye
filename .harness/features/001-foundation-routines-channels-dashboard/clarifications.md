# Clarifications — features/001-foundation-routines-channels-dashboard

**Generated**: 2026-05-01
**Round**: 1
**Status**: RESOLVED
**Resolved**: 2026-05-02 (all 10 answers collected, 30+7 patches applied, ADR-010 logged)

These ten questions are the highest-blast-radius ambiguities in the current spec. They are derived from the PRD's `## Silent Defaults` section (SD-001 through SD-014) and the LOAD-BEARING-ASSUMPTION-adjacent areas of FR-001/FR-005/FR-009/FR-021. Each question targets a Planner choice that, if wrong, would force re-architecture rather than a simple code patch — so we need the operator to confirm or override BEFORE the negotiation phase locks the contract.

The remaining silent defaults (SD-002 storage split, SD-003 Auth.js choice, SD-004 Recharts, SD-005 SWR-at-5s, SD-006 routine prompt shape, SD-007 pair config in DB, SD-014 outbound-Telegram via Bot API) were judged lower-impact: each is either already congruent with the operator's brainstorm choices or trivially reversible during the build (e.g., swap charting lib in one component). They are NOT surfaced here to avoid drowning the operator in low-stakes decisions.

The four LOAD-BEARING ASSUMPTIONS in FR-001 (one-off cap exemption, routine duration limit, `/fire` API beta header, Channels token quota) are NOT asked here — those are spike outcomes, not user decisions, and FR-001 is structured to verify them before any other FR can build.

---

## Q1 — Telegram allowlist: which Telegram user IDs may interact with the Channels session?

**Target**: FR-004 (AC-004-6)
**Location**: `spec/prd.md` § Functional Requirements § FR-004 — and `features/001-.../contract.md` D19
**Question**: AC-004-6 says "Allowlist of permitted Telegram user IDs is enforced at the session level — only Tao's user ID can elicit responses." We do not yet know:
  (a) Tao's actual Telegram user ID(s) — primary device only? backup device?
  (b) Whether the allowlist is hard-coded in the subagent system prompt, stored in `tenants.allowed_telegram_user_ids` JSON column, or read from a VPS env var.
  (c) What happens when an off-allowlist user messages the bot — silent drop, polite refusal (audited), or block-and-alert?
**Context**: The PRD says "polite refusal logged" (AC-004-6 EC), but the user IDs themselves are nowhere in the spec. The Generator cannot deliver this AC without a concrete ID list, and the storage choice affects the multi-tenant migration story (DB column is the future-proof path; env var is the simpler v1 path).
**Suggested default**: Storage = `tenants.allowed_telegram_user_ids` JSON column (multi-tenant-clean from day one, matches the "DB shape supports multi-tenant" principle in the executive summary). Behavior on off-allowlist = polite refusal + `telegram_interactions` audit row with `from_user_id` and `command_parsed='REJECTED_NOT_ALLOWED'`. Operator provides actual IDs in a follow-up env-var override during VPS setup.
**Why it matters**: Without an actual user ID, the Channels session will either accept everyone (security hole — anyone who finds the bot can `/closeall`) or accept no one (bot is dead on arrival). This is a P0-functionality blocker. The storage choice is harder to reverse later — DB column = clean migration; hardcoded prompt = permanent code change every time IDs rotate.

**User answer**: DB column + polite refusal + audit row (Recommended) — I'll provide actual IDs at VPS setup

---

## Q2 — Cloudflare domain: what hostname pattern do `mt5.{domain}` and `ff.{domain}` resolve to, and is the operator's Cloudflare account already linked to a domain we can use?

**Target**: FR-009 (AC-009-1)
**Location**: `spec/prd.md` § Functional Requirements § FR-009 — and `architecture.md` ADR-005 — and `features/001-.../contract.md` D6
**Question**: AC-009-1 says "exposing the MT5 REST port at a stable hostname like `mt5.{operator-domain}` and `ff.{operator-domain}`." We do not know:
  (a) the actual operator-domain (e.g., `tao-trading.com`?)
  (b) whether that domain is already nameservers-pointed at Cloudflare (a hard prerequisite for Tunnel to work)
  (c) whether the operator wants to use an existing domain or register a new one for this purpose
**Context**: The Generator cannot complete `infra/cloudflared/config.yml` without the actual hostnames, and `init.sh` AC-009-3/AC-009-4 smoke tests cannot run without them. SD-001 picked Cloudflare Tunnel without confirming the domain prerequisite. The brainstorm record says "operator confirmed VPS access" but does NOT confirm a Cloudflare-managed domain.
**Suggested default**: Operator owns and Cloudflare-manages a domain `{operator-domain}` (placeholder, surfaced as `CLOUDFLARE_DOMAIN` env var in `init.sh`). Hostnames: `mt5.{operator-domain}` for MT5 REST, `ffcal.{operator-domain}` for ForexFactory MCP, `health.{operator-domain}` for the FR-005 healthcheck endpoint. If the operator does NOT have a Cloudflare-managed domain, FR-009 hard-stops in init.sh (FR-020 AC-020-3 unfixable-warning behavior) and `decisions.md` records the "register a domain or migrate DNS to Cloudflare" prerequisite.
**Why it matters**: This is the single most concrete prerequisite the operator must complete OUTSIDE the codebase before init.sh can pass. If we ship without a real domain pinned down, FR-009 fails on first run. Worse, if the operator's existing domain is on a different DNS provider (Route53, Namecheap nameservers, etc.), there's a 24h+ DNS-propagation delay to switch to Cloudflare nameservers — a launch blocker the operator must know about NOW, not at build time.

**User answer**: REVISED — User asked "can't use vercel production link?" Clarified that Vercel link is dashboard-hosting only; tunnel needs separate public hostname for VPS. After re-asking with corrected options, user picked: **Tailscale Funnel** — free, *.ts.net auto-hostname, no domain needed (Recommended for now). ARCHITECTURE CHANGE: ADR-005 swaps Cloudflare Tunnel for Tailscale Funnel; init.sh installs Tailscale instead. When user gets a custom domain later, /harness:edit can swap back to Cloudflare Tunnel.

---

## Q3 — Auth.js login mechanism for the dashboard (single-user)

**Target**: FR-006 (AC-006-1), SD-003
**Location**: `spec/prd.md` § Functional Requirements § FR-006, `## Silent Defaults` SD-003 — and `architecture.md` Stack table row "Auth (dashboard)"
**Question**: SD-003 picked Auth.js with email-magic-link, but Auth.js v5 also supports: GitHub OAuth, Google OAuth, credentials-with-password, WebAuthn/passkeys. For a single-user-on-his-own-laptop-and-phone v1, which login flow does the operator actually want?
**Context**: Email magic link assumes the operator has an email inbox he checks fast on every device. Single-user with passkey is the most modern + phone-friendly. GitHub/Google OAuth assumes the operator has and trusts those identity providers for trade-system access. Choice affects: (a) the Auth.js provider config, (b) what env vars need to be set in Vercel (SMTP creds for magic link vs. OAuth client IDs vs. nothing for passkey), (c) the Playwright NFR-009 test fixture shape.
**Suggested default**: WebAuthn/passkeys with the operator's `tao@belcort.com` as the registered credential (per CLAUDE.md userEmail). Rationale: zero shared-secret surface (no password, no inbox-bouncing magic link), works trivially across phone + laptop with platform authenticators (Touch ID / Windows Hello), Auth.js v5 has first-party passkey support. Fallback: if passkey is too clunky, switch to email magic link with the operator's email; this is a one-screen Auth.js config change.
**Why it matters**: Auth gates EVERY dashboard route per NFR-009 — if the chosen flow is awkward (e.g., magic link when the operator's on a flaky network and the email's slow), the operator will be locked out at the worst moment. Picking once now > swapping after build. Also: SMTP setup for magic link adds one more Vercel-env-var that needs to be documented in init.sh; passkey adds zero infra dependency.

**User answer**: WebAuthn / passkeys with tao@belcort.com (Recommended)

---

## Q4 — Channels session: 24/7 hot OR scheduled-restart-and-cold-on-startup?

**Target**: FR-004 + FR-005, ADR-009
**Location**: `architecture.md` ADR-009 ("Periodic Channels-session restart at 03:00 GMT") + `prd.md` § FR-005 + RISK-004
**Question**: ADR-009 silently picked daily 03:00 GMT restart "to remove uncertainty from context bloat." But this means:
  (a) The session is COLD at 03:00 — first message after restart pays the systemd start-up + Claude Code session-init cost (could be 5-10s, blowing past the NFR-002 p95 ≤ 3s target if Tao messages within seconds of restart).
  (b) Any in-flight conversation context is lost daily — fine for a stateless "run my command" use case, but breaks "earlier in this conversation you said X" continuity.
  (c) The restart is a PLANNED outage but it's not coordinated with Vercel-cron healthcheck — the cron will see "down" for 10-30s during restart and may emit a false-alarm Telegram.
**Question concretely**: should we (i) keep ADR-009's daily 03:00 restart and gracefully suppress the cron alarm during the restart window, (ii) drop the daily restart entirely and rely on systemd `Restart=always` only on actual crash, (iii) restart only when the session has been idle for >N hours AND it's outside trading hours, (iv) restart-on-symptom (only when Channels-session memory > threshold)?
**Context**: The PRD never confirms with the operator whether daily-restart-with-context-loss is acceptable. SPARTAN-discipline trader workflows often span days ("yesterday at the NY open you closed EUR/USD because of CPI; what's your current view?") — a daily wipe breaks this. RISK-004 says "long-lived LLM session, possible memory pressure" but doesn't measure it, just guesses.
**Suggested default**: Option (iii) — restart-on-idle: if the session has handled no messages in the past 4h AND we are outside both Euro and NY sessions (currently 22:00-06:00 GMT), trigger a restart, mute the Vercel-cron alarm for 90s. Combined with: explicit "Yesterday's chat history is in `telegram_interactions` table; you can read it with `mcp__postgres_query`" hint in the subagent system prompt so context loss is recoverable on demand. This balances NFR-002 (no cold-start during trading hours) with RISK-004 (eventual restart) without dictating a daily wipe the operator may not want.
**Why it matters**: This decides whether the Channels session is a "always-fresh stateless slash-command runner" or a "long-running trading assistant with memory of yesterday." That's the entire UX shape of the Telegram surface. Pick wrong now = either constant context loss frustration OR memory-bloat outage at the worst moment. Also affects the systemd unit shipped in AC-004-1 and the cron-healthcheck logic in AC-005-2.

**User answer**: Restart-on-idle (4h idle + outside trading hours, mute alarm 90s) (Recommended). Combined with the system-prompt hint that yesterday's chat history is in telegram_interactions table.

---

## Q5 — Cap monitoring: which usage data source is canonical, and what's the latency tolerance?

**Target**: FR-021 (AC-021-1), SD-010, ADR-008
**Location**: `prd.md` § FR-021, `## Silent Defaults` SD-010 — `architecture.md` ADR-008
**Question**: ADR-008 picked a priority order — Anthropic `/v1/usage` API → headless-browser scrape → local counters — but does NOT confirm:
  (a) Whether Anthropic actually exposes a `/v1/usage` HTTP endpoint that the Channels session OR a Vercel cron can call (the brainstorm noted this is "documented for the slash command, may have programmatic counterpart" — wishful thinking until verified).
  (b) Whether the operator is OK with a headless-browser scrape of his own `claude.ai/usage` page from a Vercel cron (this requires storing the operator's claude.ai login cookies/session in Vercel env, which is a significant secret-rotation problem and a Cloudflare-bot-detection risk).
  (c) Whether local-counters-only (NEVER scrape, NEVER call API — just count what we send) is acceptable as the v1 default, with first-party data added later if/when Anthropic ships it.
**Context**: Cap monitoring drives FR-021 alerts (12/15 warning, 14/15 hard), the dashboard Overview cap-progress-bar, and indirectly the Planner's pre-flight "should I re-plan?" decision. If the data source is wrong or stale, alerts fire late or don't fire — silent cap exhaustion = exactly the failure mode F1 in the Hindsight-20/20 list.
**Suggested default**: V1 ships **local-counters-only** (instrument every `claude /schedule`, every `/fire` HTTP call, every Channels-session message-handle to insert a row in `cap_usage_local`). FR-001 spike checks whether `/v1/usage` is exposed; if YES, FR-021 follow-on adds the API call as a daily reconciliation cron (compare local vs. Anthropic, alert on drift > 1 slot). Headless-browser scrape is **dropped from v1** — credential storage + bot-detection risk outweighs the operational benefit at single-tenant scale.
**Why it matters**: The wrong choice here either leaks credentials (scrape path with cookies in Vercel env) or under-counts cap usage (local-only when something escapes our counter, like a `/replan` from the operator's laptop terminal that bypasses the dashboard). At single-tenant scale, local counters are good enough IF every cap-burning code path is instrumented; that's a much smaller surface than "make web scraping work reliably." This also affects FR-021 EC-021-1 ("Anthropic cap counters lag") — if we use local-only, there's no lag, only "we may have missed an out-of-band fire."

**User answer**: Local counters only in v1 + spike checks /v1/usage availability (Recommended). Headless scrape DROPPED entirely. If FR-001 spike confirms /v1/usage exists, FR-021 follow-on adds daily reconciliation cron (compare local vs Anthropic, alert on drift > 1 slot).

---

## Q6 — Audit retention: 90 days hot is silent — confirm the period, and confirm Vercel Blob "cold archive" prefix, and confirm GDPR/financial-record-keeping posture

**Target**: FR-007 EC-007-2, SD-013, ADR-006
**Location**: `prd.md` § FR-007 EC-007-2, `## Silent Defaults` SD-013 — `architecture.md` ADR-006
**Question**: ADR-006 picked "90-day hot in Postgres + cold archive in Vercel Blob, indexed by date." This is silent on:
  (a) Is 90 days the retention the operator wants? UK/EU financial-record-keeping rules typically demand 5-7 years for executed-trade records — does that apply to a personal trading bot? Does the operator want longer retention for "I want to study my trades from 6 months ago"?
  (b) After "cold archive," how is data retrieved? Manual Blob fetch + replay into Postgres? On-demand dashboard "show me 2025-12-01"? Never re-read?
  (c) Does the operator want PII (Telegram user IDs, message text) handled differently from trading data (orders, audit rows)?
**Context**: Financial trading systems usually treat trade audit records as immutable forever. The PRD's 90-day hot + cold-Blob-archive is a reasonable storage-cost-vs-recall trade-off for a single-user system but it MUST be the operator's deliberate choice, not the Planner's silent default. Cold-archive without a recall path is "data is gone" in practice — most operators will not write a one-off Bun script to fetch a Blob URL when they want to look at last quarter's trades.
**Suggested default**: Hot retention = 365 days in Postgres (covers a full trading year for "compare this year's NFP behavior to last year"); cold archive after 365 days to Vercel Blob `archive/{tenant_id}/{YYYY-MM}/`; dashboard "History" page transparently fetches from cold archive when the operator filters to a date >365 days back (signed-URL fetch + render, with a "loading from archive…" spinner). PII (Telegram user IDs, message text) NOT separated in v1 — single-user system, the operator IS the only PII subject. Retention configurable via `AUDIT_HOT_DAYS` env var (default 365). This raises Postgres storage cost slightly (Neon's free tier is 0.5 GB; 365 days of audit at single-user scale fits comfortably) and gives the operator real recall.
**Why it matters**: 90 days is a silent default that pretends to be reasonable but breaks the "I want to replay yesterday's reasoning" promise once "yesterday" becomes "3 months ago." Operator-trader workflows often look back at "last quarter" for performance review. Also: getting retention wrong post-launch is hard — once data is archived to cold-only, recall is operationally awkward; once data is purged, it's gone. Pick the longer-retention default now; the operator can set `AUDIT_HOT_DAYS=90` via env var if storage cost becomes an issue.

**User answer**: 365 days hot in Postgres + cold archive in Blob, configurable via env var (Recommended). Default AUDIT_HOT_DAYS=365. Dashboard transparently fetches cold archive when filtering >365d (signed-URL fetch + render with "loading from archive…" spinner). PII not separated in v1 (single user).

---

## Q7 — Claude Design bundle: when (and where) does the operator hand it off?

**Target**: FR-006 (AC-006-2), SD-011
**Location**: `prd.md` § FR-006 AC-006-2, `## Silent Defaults` SD-011 — and `features/001-.../contract.md` D14 (M3 dependency)
**Question**: SD-011 says "Operator must export the bundle BEFORE the Generator runs BUILD; until then, the Generator will create scaffold-only screens and the build will fail evaluation on Product Depth." But:
  (a) Has the operator actually run a Claude Design session for this dashboard yet? If not, when?
  (b) Where exactly should the bundle land — `design/dashboard-bundle/` (current SD-011 default) or somewhere else? Does this folder need to be in git or in `.gitignore` (the bundle may be large, but if it's not committed the Generator can't reproduce builds)?
  (c) If the operator has NOT done a design session, does the Generator (i) hard-stop M3 with a clear "operator: please run Claude Design first," (ii) ship a default shadcn template build and let `impeccable` audit catch the gap, or (iii) consult `frontend-design` skill to generate an opinionated design from the PRD wireframe descriptions?
**Context**: D14's "MUST have exported the Claude Design bundle to `design/dashboard-bundle/` before this FR can deliver Product Depth" is a hard prerequisite stated as if it's already done. If it's not done, the entire M3 milestone is blocked or degraded. This affects build sequencing, the Evaluator's Product Depth scoring (criteria.md threshold 7/10), and the operator's expectation of when the dashboard will be reviewable.
**Suggested default**: Pre-flight check in init.sh: if `design/dashboard-bundle/index.html` does NOT exist, init.sh prints an "operator action required" warning (FR-020 AC-020-3 style) explaining: (1) what Claude Design is, (2) what to export, (3) where to put it. The Generator BUILDs the dashboard regardless: if the bundle exists, `frontend-design` skill consumes it; if NOT, the Generator invokes `frontend-design` skill on the PRD's wireframe descriptions (the AC-006-2 list of five screens) to generate a design from text alone. This degrades Product Depth scoring but does NOT block the build. The implementation report flags "design generated from text, not Claude Design bundle" so the operator knows to run the design pass and re-iterate.
**Why it matters**: If we hard-block on the bundle being present, M3 stalls until the operator does a design session — could be days. If we silently ship a default-shadcn build, the operator gets a cookie-cutter dashboard and the Evaluator scores it at floor on Product Depth, triggering a retry cycle. Picking a clear pre-flight-check + degraded-build-with-flag gives the operator both: a working scaffold to evaluate AND a clear callout that polish is pending. Also: locking the folder location now means everyone (operator, Generator, Evaluator) knows where the bundle lives.

**User answer**: init.sh warns + Generator falls back to text-based design from PRD wireframes (Recommended). If `design/dashboard-bundle/index.html` does not exist, init.sh prints an "operator action required" warning. Generator builds anyway: invokes frontend-design skill on PRD wireframe descriptions. Implementation report flags "design generated from text, not Claude Design bundle" so operator knows to iterate.

---

## Q8 — Compute_python MCP: ship in v1 or defer to v2 after measuring whether Opus actually needs it?

**Target**: FR-013, SD-008
**Location**: `prd.md` § FR-013, `## Silent Defaults` SD-008 — and `features/001-.../contract.md` D12 (M2)
**Question**: FR-013 is P1, the Hindsight scope-challenge section says "Opus's native math may be sufficient; if it is, this connector is decoration. v1 ships it as a safety net but operator may detach." But:
  (a) Building `compute_python` is a non-trivial MCP server (Vercel Sandbox plumbing, tool-call schema, error handling, security review of Python execution) — ~½ day of work.
  (b) If the FR-001 spike's AC-001-2 routine-duration test runs Opus 4.7 against real MSCP data and confirms Opus does the ATR/position-size math correctly, FR-013 is dead weight in v1.
  (c) Conversely, if the spike reveals Opus is mathematically slightly off on edge-case ATR computations, FR-013 is critical and shipping it post-launch via a follow-up PR is operator-pain.
**Question concretely**: Build FR-013 IN v1 unconditionally (current contract D12), OR build it conditionally based on FR-001 spike outcome (if spike shows Opus's math is reliable, skip; if it shows drift, build), OR defer to v2 entirely (out-of-scope this build, accept the post-launch PR if ATR drift is observed)?
**Context**: SD-008 silently kept FR-013 in scope. The contract Build Order has it at step #12 in M2, requiring Vercel Sandbox provisioning + MCP server scaffolding + tool-allowlist plumbing on the Executor. That's real engineering work — and it's done speculatively because we don't know if Opus needs it.
**Suggested default**: Conditional build keyed to FR-001 spike output. FR-001 AC-001-2 runs the Executor on a real MSCP-shaped workload; the spike report includes a "Math fidelity check" — synthetic ATR computation on a known-answer dataset, comparing Opus's output to a Python reference. If max relative error < 1e-3, FR-013 is moved to "out of scope v1, ticket for v2." If error ≥ 1e-3 OR Opus refuses to compute (rare), FR-013 builds per current D12. Either decision is recorded in `decisions.md`. This avoids speculative work AND avoids a post-launch surprise.
**Why it matters**: Building FR-013 unconditionally costs ~½ day + ongoing Vercel Sandbox cost + an additional MCP attack surface — for what may be zero functional gain. Skipping unconditionally risks the operator discovering ATR drift in production. The conditional path uses the spike (which we're building anyway) as the decider. Also: if FR-013 ships, it's the only non-Anthropic code execution surface in the system; that's a security review surface worth paying for ONLY if needed.

**User answer**: Conditional: build only if FR-001 spike shows ATR drift in Opus's math (Recommended). FR-001 AC-001-2 includes a "Math fidelity check" — synthetic ATR computation comparing Opus output to Python reference. If max relative error < 1e-3, FR-013 moves to v2 backlog. If ≥1e-3 OR Opus refuses, FR-013 builds per current D12. Decision recorded in decisions.md.

---

## Q9 — What is the ORM choice — Drizzle or Prisma — and is it locked here or genuinely deferred to negotiation?

**Target**: Architecture Stack table, FR-008 (AC-008-1), Deferred-to-Negotiation list
**Location**: `architecture.md` Stack row "ORM/migrations" (says "Drizzle ORM + Drizzle Kit" but qualifies "(Generator may pick Prisma instead during negotiation; both qualify)") and `architecture.md` § Deferred to Negotiation Phase ("ORM choice — Drizzle vs. Prisma — both qualify under §4 multi-tenant requirement")
**Question**: The architecture says BOTH "Drizzle is the choice" AND "actually it's deferred to Generator negotiation." Which is it?
  (a) Drizzle is locked in the Stack table — Generator must use Drizzle.
  (b) Choice is genuinely open — Generator picks one in negotiation, justifies in implementation report.
  (c) Operator has a preference based on prior projects — please state.
**Context**: This is the only field in the Stack table that contradicts itself. The contract D3 (FR-008) refers to Drizzle Kit migrations explicitly. If the Generator picks Prisma during negotiation, the contract's wording ("Drizzle Kit migrations") becomes outdated immediately. Either lock the choice now (cleaner contract) or genuinely defer (delete the contradictory Stack-table entry).
**Suggested default**: Lock to Drizzle in the Stack table; remove the "or Prisma" caveat. Rationale: (a) Drizzle's type-safe `WHERE tenant_id = $1` enforcement is more obvious in code review than Prisma's middleware-based row-level filter, which matters for the multi-tenant requirement (NFR / constitution multi-tenant principle); (b) Drizzle's smaller runtime + edge-friendly pattern is better fit for Vercel Functions; (c) Drizzle Kit migrations are simpler to author by hand for a small schema like this v1; (d) the Generator+Evaluator negotiation phase should be about file structure and component boundaries, not core ORM choice (which is foundational to FR-008 and shouldn't be re-litigated). Operator can override with "actually use Prisma" as a one-line answer here.
**Why it matters**: ORM choice cascades into every data-access file in the system. If the contract draft says Drizzle and the negotiated contract says Prisma, every existing example and migration tooling reference goes stale. Re-deciding mid-build is a refactor cost. Architectural foundations should be locked at planning time; only IMPLEMENTATION DETAILS belong in negotiation.

**User answer**: Lock to Drizzle ORM — remove the 'or Prisma' contradiction (Recommended). Stack table updated to "Drizzle ORM + Drizzle Kit" without the "(Generator may pick Prisma instead during negotiation)" caveat. Architecture's Deferred-to-Negotiation list updated to remove the ORM bullet.

---

## Q10 — Package manager: pnpm OR Bun OR npm?

**Target**: Architecture § Deferred to Negotiation, FR-020 (AC-020-1)
**Location**: `architecture.md` § Deferred to Negotiation ("pnpm vs npm vs bun for the project's package manager (Bun is on the VPS already; pnpm is Vercel-friendly; choose one)") + `prd.md` § FR-020 AC-020-1 (mentions Bun + pnpm interchangeably)
**Question**: AC-020-1 mentions both "Bun installed (or installs it)" AND "`pnpm install`" in the same sentence. The architecture says "choose one." Which package manager is canonical for this project?
**Context**: This affects `package.json` scripts shape, lockfile format (`bun.lock` vs `pnpm-lock.yaml`), Vercel build settings, and init.sh expected commands. Mixing them = lockfile drift. Concretely: the operator's VPS has Bun (per the brainstorm); Vercel supports both pnpm and Bun first-class; npm works everywhere but is the slowest install on Vercel cold-builds.
**Suggested default**: **Bun**, used everywhere — local dev, Vercel build, VPS scripts. Single tool across all surfaces, fastest install (matters for Vercel cold-builds + init.sh's repeated runs), the operator already uses it on the VPS. `package.json` scripts run via `bun run <script>`. Lockfile committed: `bun.lock`. Vercel project setting: install command = `bun install`, build command = `bun run build`. Fallback if Bun has a Next.js-16 incompatibility surfaced during FR-001 spike: switch to pnpm with the same workspace-monorepo shape (one-line `package.json` engine pin + Vercel setting change).
**Why it matters**: Mixed package managers = lockfile chaos. Picking now = one source of truth across dev/Vercel/VPS. Picking wrong (e.g., locking to npm and finding it's painfully slow on Vercel) is a single-day swap; picking inconsistently (npm in some places, Bun in others) is a permanent drag on every install. The operator's VPS-Bun preference is the strongest signal here; aligning the rest of the system to that is the lowest-friction path.

**User answer**: Bun everywhere (VPS already has it) (Recommended). Used local dev, Vercel build, VPS scripts. package.json scripts run via `bun run <script>`. Lockfile committed: `bun.lock`. Vercel project settings: install command = `bun install`, build command = `bun run build`. Architecture's Deferred-to-Negotiation list updated to remove the package-manager bullet.

---

**Status**: ANSWERED — all 10 questions have user answers. Ready for EDIT-mode Planner dispatch.

---

## Notes for the Orchestrator

- Counts: 10 questions, ordered roughly highest-blast-radius (Q1 security/functional blocker → Q10 ergonomic preference). If the operator triages and answers only the top 5, the project is still buildable; the bottom 5 have safer Planner defaults and can be punted to a second clarify round if needed.
- Skipped (judged lower-impact): SD-002 (storage split), SD-003-styled-as-confirmed-already (Auth.js library, but the FLOW is asked in Q3), SD-004 (Recharts), SD-005 (SWR-at-5s), SD-006 (routine prompt shape), SD-007 (pair config in DB), SD-009 (Executor failure path = no auto-retry), SD-014 (outbound-Telegram via Bot API — already an ADR, not silent).
- The four LOAD-BEARING ASSUMPTIONS in FR-001 are NOT here — they are spike outcomes (the spike runs as the very first build step), not user decisions. The operator will see the spike report and the chosen fallback path before downstream FRs build.
- If user answers contradict any architecture ADR, the orchestrator should also invoke `/harness:edit` (cascade-aware) rather than `/harness:amend` (single-file).
