# Clarify Answers — Spec Patches for features/001-foundation-routines-channels-dashboard

**Generated**: 2026-05-01
**Marker**: CLARIFY ANSWERS
**Source**: `.harness/features/001-foundation-routines-channels-dashboard/clarifications.md` (Round 1, all 10 questions answered)

## Interpretation

The operator answered all ten clarifications, accepting the Recommended default in every case. Most answers tighten ambiguous PRD ACs and remove contradictions in the architecture (Q1, Q3, Q7-Q10). Q2 is an architecture change: Tailscale Funnel replaces Cloudflare Tunnel + Access Service Token end-to-end (ADR-005 rewritten, Stack table updated, NFR Feasibility Check updated, FR-009 ACs/EC reshaped, FR-005 healthcheck reshaped, init.sh smoke-test references updated, RISK-005 updated, SD-001 obsoleted in PRD). Q4 amends ADR-009 (daily 03:00 restart → restart-on-idle with alarm muting). Q5 amends ADR-008 (drop scrape entirely; v1 ships local counters only with conditional reconciliation cron behind FR-001 spike). Q6 amends ADR-006 (90-day → 365-day default + env var override + dashboard cold-archive recall). Q8 amends FR-013 + the contract Build Order to be conditional on FR-001 AC-001-2 math-fidelity outcome. Q9 locks Drizzle in the Stack table and Deferred-list. Q10 locks Bun in the Deferred-list and tightens FR-020 AC-020-1 wording.

Per the constraint block, this run touches only `spec/prd.md`, `spec/architecture.md`, and `features/001-.../contract.md`. evaluator/, progress/, manifest, init.sh, and constitution are not patched — separate paths handle those.

## Impact summary

**Modifies**:
- `.harness/spec/prd.md`: FR-004 AC-004-6 + EC-004-2 (Q1), FR-005 AC-005-1 (Q2), FR-006 AC-006-1 (Q3), FR-006 EC-006-2 + AC-006-2 (Q7), FR-009 ACs + ECs (Q2), FR-013 acceptance behavior (Q8), FR-020 AC-020-1 (Q10), FR-021 AC-021-1 + AC-021-4 (Q5), AC-007-2 (Q1), EC-007-2 (Q6), Risks (RISK-005 — Q2; RISK-004 — Q4), Silent Defaults section (SD-001 obsoleted/replaced; SD-003, SD-008, SD-010, SD-011, SD-013, SD-014 retained but updated where needed)
- `.harness/spec/architecture.md`: Stack table rows "Auth (dashboard)", "ORM/migrations", "Tunnel (VPS → cloud)" (Q3, Q9, Q2); ADR-005 full rewrite (Q2); ADR-006 amendment (Q6); ADR-008 amendment (Q5); ADR-009 amendment (Q4); Architectural Style paragraph (Q2); NFR Feasibility Check NFR-001/NFR-006 rows (Q2, Q5); Deferred-to-Negotiation list (Q9, Q10)
- `.harness/features/001-.../contract.md`: D6 (FR-009 deliverable, retitled), D12 (FR-013 conditional behavior), Build Order step 6 (Q2 — Cloudflare → Tailscale), Build Order step 12 (Q8 conditional), D19 audit-row note for AC-004-6 (Q1)

**Unclear** (none — all 10 answers were unambiguous Recommended picks)

**Out of scope** (none — every answer maps cleanly into one of the three permitted files)

## Patches

### Patch 1 — Q1: PRD FR-004 AC-004-6 — concrete enforcement: DB-column allowlist + polite-refusal + audit row

**File**: `.harness/spec/prd.md`
**Location**: § Functional Requirements § FR-004 § Acceptance Criteria § AC-004-6

```diff
   - [ ] AC-004-5: Free-text message (no leading slash) is handled as a normal Q&A turn — session uses its tools to answer ("why did you skip GBP/USD this morning?" → reads `routine_runs` table, summarises). Reply latency p95 ≤ 3 sec, p99 ≤ 8 sec (SM-004).
-  - [ ] AC-004-6: Allowlist of permitted Telegram user IDs is enforced at the session level — only Tao's user ID can elicit responses. Other users get a polite refusal logged.
+  - [ ] AC-004-6: Allowlist of permitted Telegram user IDs is enforced at the session level — only IDs in the `tenants.allowed_telegram_user_ids` JSON column (per-tenant, JSON array of integer Telegram user IDs) may elicit substantive responses. Operator supplies the actual IDs via VPS env var `ALLOWED_TELEGRAM_USER_IDS` (comma-separated) at setup time; `infra/vps/setup.sh` writes them into the seeded tenant row. Off-allowlist messages get a polite English refusal ("Sorry, this assistant is private — please contact the operator if you believe this is in error.") AND insert a `telegram_interactions` audit row with `from_user_id` populated and `command_parsed='REJECTED_NOT_ALLOWED'`. No tool calls are made for rejected messages.
 - **Edge Cases**:
```

**Reasoning**: Translates Q1's answer (DB column + polite refusal + audit row) into a concrete, testable acceptance criterion. Storage location named (`tenants.allowed_telegram_user_ids` JSON column), refusal copy specified, audit-row shape pinned to the existing `telegram_interactions` schema, env-var pathway noted so the operator can supply IDs without a code change.

---

### Patch 2 — Q1: PRD FR-007 AC-007-2 — extend telegram_interactions schema for the rejection enum

**File**: `.harness/spec/prd.md`
**Location**: § Functional Requirements § FR-007 § Acceptance Criteria § AC-007-2

```diff
-  - [ ] AC-007-2: Every Telegram interaction (slash command OR free-text) inserts a row in `telegram_interactions`: `tenant_id`, `received_at`, `replied_at`, `from_user_id`, `message_text`, `command_parsed`, `tool_calls_made_json`, `reply_text`, `claude_code_session_id`.
+  - [ ] AC-007-2: Every Telegram interaction (slash command OR free-text) inserts a row in `telegram_interactions`: `tenant_id`, `received_at`, `replied_at`, `from_user_id`, `message_text`, `command_parsed`, `tool_calls_made_json`, `reply_text`, `claude_code_session_id`. The `command_parsed` field is one of: a recognised slash command (e.g., `/status`, `/closepair`), `FREE_TEXT` for free-text Q&A, or `REJECTED_NOT_ALLOWED` for messages from off-allowlist user IDs (per AC-004-6). Rejected rows have empty `tool_calls_made_json` and `claude_code_session_id` (no LLM turn was spent).
 - **Acceptance Criteria**:
```

**Reasoning**: Q1's answer requires the audit row for off-allowlist messages — this patch extends the existing AC-007-2 schema description to enumerate the `command_parsed` values so the schema (FR-008 AC-008-1's `telegram_interactions` shape) supports the rejection case without ambiguity. Wait — this patch's `old_string` ends with `- **Acceptance Criteria**:` which appears multiple times; the unique anchor is the AC-007-2 line itself. Let me adjust.

Adjusted unique-anchor version:

```diff
-  - [ ] AC-007-2: Every Telegram interaction (slash command OR free-text) inserts a row in `telegram_interactions`: `tenant_id`, `received_at`, `replied_at`, `from_user_id`, `message_text`, `command_parsed`, `tool_calls_made_json`, `reply_text`, `claude_code_session_id`.
+  - [ ] AC-007-2: Every Telegram interaction (slash command OR free-text OR rejected) inserts a row in `telegram_interactions`: `tenant_id`, `received_at`, `replied_at`, `from_user_id`, `message_text`, `command_parsed`, `tool_calls_made_json`, `reply_text`, `claude_code_session_id`. The `command_parsed` field is one of: a recognised slash command (e.g., `/status`, `/closepair`), `FREE_TEXT` for free-text Q&A, or `REJECTED_NOT_ALLOWED` for messages from off-allowlist user IDs (per AC-004-6). Rejected rows have empty `tool_calls_made_json` and NULL `claude_code_session_id` (no LLM turn was spent).
```

(The Edit tool will use the second version above; the indented `- **Acceptance Criteria**:` line in the first version was a copy/paste artefact, not part of the actual file.)

---

### Patch 3 — Q2: PRD FR-009 — retitle and rewrite for Tailscale Funnel

**File**: `.harness/spec/prd.md`
**Location**: § Functional Requirements § FR-009 (header through Edge Cases inclusive)

```diff
-### FR-009: VPS-to-cloud authenticated tunnel for MT5 REST + ForexFactory MCP
+### FR-009: VPS-to-cloud public tunnel for MT5 REST + ForexFactory MCP (Tailscale Funnel + app-layer bearer)
 - **Journey**: UJ-001, UJ-003
 - **Priority**: P0
-- **User Story**: As Tao, I want my VPS-resident MT5 REST endpoint and ForexFactory MCP reachable from Routines (Anthropic cloud) and Vercel functions (the dashboard's MT5 reads), but locked down to those callers, so that no random internet traffic can hit my MT5.
+- **User Story**: As Tao, I want my VPS-resident MT5 REST endpoint and ForexFactory MCP reachable from Routines (Anthropic cloud) and Vercel functions (the dashboard's MT5 reads), via a free tunnel that doesn't require me to own a domain, so I can ship v1 today and migrate to a custom-domain transport later.
 - **Acceptance Criteria**:
-  - [ ] AC-009-1: A Cloudflare Tunnel is provisioned (`cloudflared tunnel`) on the VPS, exposing the MT5 REST port (and the FF MCP port if it serves HTTP) at a stable hostname like `mt5.{operator-domain}` and `ff.{operator-domain}`.
-  - [ ] AC-009-2: Cloudflare Access is configured in front of the tunnel with a Service Token (CF-Access-Client-Id + CF-Access-Client-Secret). Both Routines (via the routine connector config) and the Vercel dashboard (via env vars) carry the service-token headers on every request.
-  - [ ] AC-009-3: Direct unauthenticated requests to the public hostname return 401 (verified via curl). Confirmed by an init.sh smoke test stage that runs from the dev laptop.
-  - [ ] AC-009-4: init.sh on the dev laptop verifies the operator can reach `mt5.{domain}/get_account_info5` with the service token and gets a JSON response. Failure here is a hard stop — the rest of the system is unbuildable.
+  - [ ] AC-009-1: Tailscale is installed on the VPS, the VPS is joined to the operator's tailnet via `tailscale up`, and `tailscale funnel` is configured (as a systemd service `tailscale-serve.service` so it persists across reboots, OR via `tailscale funnel --bg`) to expose the MT5 REST port and the ForexFactory MCP port (if it serves HTTP) on the auto-assigned `*.ts.net` hostname (e.g., `caishen-vps.tailNNN.ts.net`). The hostname is captured into a VPS env var `TAILSCALE_FUNNEL_HOSTNAME` and surfaced to Vercel + Routines as `MT5_BASE_URL=https://{TAILSCALE_FUNNEL_HOSTNAME}` (and `FFCAL_BASE_URL` similarly if FF MCP is HTTP-exposed).
+  - [ ] AC-009-2: App-layer auth replaces what Cloudflare Access previously provided: a shared bearer token `MT5_BEARER_TOKEN` (generated at VPS setup, stored in `/etc/caishen/channels.env` and `tunnel-bearer.env`, surfaced to Vercel + Routines as a secret) is required on every request to MT5 REST endpoints in the form `Authorization: Bearer <token>`. The operator's existing MT5 REST gateway is wrapped (or modified) to enforce the bearer at HTTP level — requests without a valid bearer return 401. ForexFactory MCP, if HTTP-exposed, gets the same treatment with `FFCAL_BEARER_TOKEN`.
+  - [ ] AC-009-3: Direct unauthenticated requests to the public `*.ts.net` hostname return 401 (verified via curl from the dev laptop, with `Authorization` header omitted). Confirmed by an `init.sh` smoke-test stage. Note: the Funnel surface is intentionally public (Tailscale Funnel exposes services to the open internet); auth lives in the app layer per AC-009-2.
+  - [ ] AC-009-4: `init.sh` on the dev laptop verifies that `curl -H "Authorization: Bearer ${MT5_BEARER_TOKEN}" https://${TAILSCALE_FUNNEL_HOSTNAME}/get_account_info5` returns a JSON response with the operator's account info. Failure here is a hard stop — the rest of the system is unbuildable.
 - **Edge Cases**:
-  - EC-009-1: Cloudflare Tunnel hiccup → Routines retry per FR-003 EC-003-1 logic; dashboard shows "Live data unavailable" per FR-006 EC-006-1.
-  - EC-009-2: Service token rotation needed → documented in init.sh + decisions.md; rotation requires updating Vercel env + each routine's connector secret.
+  - EC-009-1: Tailscale Funnel hiccup or VPS-to-tailnet disconnect → Routines retry per FR-003 EC-003-1 logic; dashboard shows "Live data unavailable" per FR-006 EC-006-1.
+  - EC-009-2: Bearer token rotation needed → documented in `init.sh` + `decisions.md`; rotation requires updating Vercel env (`MT5_BEARER_TOKEN`), each routine's secret-environment-variable, the VPS `/etc/caishen/channels.env`, AND the gateway's accepted-tokens list in a single coordinated step. Bearer rotation is a planned-outage operation (≤ 60s).
+  - EC-009-3: Operator later acquires a custom domain and wants to switch back to Cloudflare Tunnel + Access Service Token → run `/harness:edit "switch VPS-to-cloud transport from Tailscale Funnel to Cloudflare Tunnel + Access Service Token using domain {domain}"`. The cascade re-introduces ADR-005's previous pattern (CF-Access-Client-Id / CF-Access-Client-Secret headers) and updates Stack/init.sh/env-vars accordingly. v1 does NOT ship this path.
```

**Reasoning**: Q2 is an architecture change. FR-009 is rewritten end-to-end: header retitled, user story acknowledges the no-domain choice, all four ACs swap Cloudflare Tunnel + Service Token for Tailscale Funnel + app-layer bearer (because Funnel exposes services publicly — auth must move into the app), ECs updated for the new failure modes plus a forward-compatibility EC-009-3 that points at the `/harness:edit` cascade if the operator gets a domain later.

---

### Patch 4 — Q2: PRD FR-005 AC-005-1 — healthcheck endpoint reachability via Tailscale Funnel

**File**: `.harness/spec/prd.md`
**Location**: § Functional Requirements § FR-005 § Acceptance Criteria § AC-005-1

```diff
-  - [ ] AC-005-1: A small healthcheck endpoint runs on the VPS (FastAPI/Express stub on a non-public port, accessible only via the same Cloudflare Tunnel as MT5 REST). It returns `{healthy: true, uptime_sec, last_message_handled_at}` IF: systemd shows the channels unit `active (running)` AND the session has handled a message OR a cron-injected synthetic ping in the last 10 min.
+  - [ ] AC-005-1: A small healthcheck endpoint runs on the VPS (FastAPI/Express stub on a local port, exposed via the same Tailscale Funnel as MT5 REST at a path like `/_health` or as a separate `health.{TAILSCALE_FUNNEL_HOSTNAME}` if Funnel multi-host is needed). The endpoint requires the same `Authorization: Bearer ${HEALTH_BEARER_TOKEN}` (separate token from MT5's, so a leaked MT5 token can't probe health internals). It returns `{healthy: true, uptime_sec, last_message_handled_at}` IF: systemd shows the channels unit `active (running)` AND the session has handled a message OR a cron-injected synthetic ping in the last 10 min.
```

**Reasoning**: Q2 changes the transport. The healthcheck previously reused Cloudflare Tunnel — it now reuses Tailscale Funnel and gets its own bearer token (defence in depth so a leaked MT5 token can't enumerate health internals).

---

### Patch 5 — Q2: PRD RISK-005 — update transport mention from Cloudflare Tunnel to Tailscale Funnel

**File**: `.harness/spec/prd.md`
**Location**: § Risks § RISK-005

```diff
 ### RISK-005: MT5 REST or ForexFactory MCP unreachable for an extended window
 - **Likelihood**: Low-Medium (VPS network blips, broker-side outages)
 - **Impact**: High (Executors fire blind — no candles, no calendar)
-- **Mitigation**: Per-call retry-with-backoff (FR-003 EC-003-1); audit row marks `degraded=true`; SPARTAN prompt's safeguards refuse to trade on insufficient data (existing behavior); Telegram alert. If outage > 30 min, the Planner re-plan path's "no trade" output is the safe default.
+- **Mitigation**: Per-call retry-with-backoff (FR-003 EC-003-1); audit row marks `degraded=true`; SPARTAN prompt's safeguards refuse to trade on insufficient data (existing behavior); Telegram alert. If outage > 30 min, the Planner re-plan path's "no trade" output is the safe default. New v1-specific failure mode: Tailscale Funnel hostname change after VPS reboot/re-auth — Funnel hostnames are stable per-machine but a fresh `tailscale up` with a new node-name produces a new hostname; mitigation = init.sh smoke test (FR-009 AC-009-4) catches the mismatch on next dev-laptop run; operator updates Vercel + Routines secret-env-vars in a single coordinated step.
```

**Reasoning**: Tailscale Funnel hostnames are stable per-tailnet-node but can drift if the VPS is re-auth'd with a new node name — capturing this as a v1-specific risk subnote within the existing RISK-005 (not a new top-level risk; mitigation is the same init.sh smoke).

---

### Patch 6 — Q2: PRD Silent Defaults SD-001 — replace with the chosen Tailscale Funnel default

**File**: `.harness/spec/prd.md`
**Location**: § Silent Defaults § SD-001

```diff
-- **SD-001**: VPS-to-cloud transport = Cloudflare Tunnel + Cloudflare Access service token. Picked because: (a) operator confirmed VPS access, (b) Cloudflare's docs are explicit about service-token auth for non-browser callers, (c) bearer-token alternatives leak the secret in URLs more readily, (d) Tailscale Funnel doesn't expose internal services to Anthropic-cloud Routines without an additional ACL layer. Override path: `/harness:edit` to switch to Tailscale or mTLS-proxy.
+- **SD-001 [resolved by clarify Q2, 2026-05-01]**: VPS-to-cloud transport = **Tailscale Funnel + app-layer bearer token** (operator chose Tailscale Funnel over Cloudflare Tunnel because the operator does not own a Cloudflare-managed domain at v1 launch). Funnel exposes the local MT5 REST + healthcheck to the public internet via auto-assigned `*.ts.net` hostname; auth moves into the app layer (the gateway enforces `Authorization: Bearer ${MT5_BEARER_TOKEN}`). Override path: when the operator acquires a custom domain, run `/harness:edit "switch VPS-to-cloud transport to Cloudflare Tunnel + Access Service Token using domain {domain}"` — the Planner cascade re-introduces ADR-005's prior pattern. See ADR-005 (revised) for the full rationale.
```

**Reasoning**: SD-001 was the silent default that Q2 surfaced. Per the universal CLARIFY-ANSWERS pattern, mark it resolved with a date and the new chosen path; preserve the override note so the future "swap back to Cloudflare" path is documented.

---

### Patch 7 — Q3: PRD FR-006 AC-006-1 — passkey/WebAuthn login

**File**: `.harness/spec/prd.md`
**Location**: § Functional Requirements § FR-006 § Acceptance Criteria § AC-006-1

```diff
-  - [ ] AC-006-1: Dashboard is built as a Next.js 16 App Router project with shadcn/ui components, deployed to Vercel free tier. Auth.js gates every route; login is single-user (Tao's email/credential, configured via Vercel env). All routes except `/login` and `/api/cron/*` (CRON_SECRET-gated) require an authenticated session.
+  - [ ] AC-006-1: Dashboard is built as a Next.js 16 App Router project with shadcn/ui components, deployed to Vercel free tier. Auth.js v5 gates every route via the WebAuthn/passkey provider; login is single-user (Tao registers a passkey on his phone AND a passkey on his laptop during first-run setup; both are bound to the operator email `tao@belcort.com` at registration). Subsequent logins use platform authenticators (Touch ID / Windows Hello / phone biometric). All routes except `/login`, `/auth/passkey-register` (one-time, gated by `INITIAL_REGISTRATION_TOKEN` env var), and `/api/cron/*` (CRON_SECRET-gated) require an authenticated session. No SMTP/magic-link infrastructure is provisioned in v1; if passkeys prove clunky, `/harness:edit` swaps the Auth.js provider in a single config change.
```

**Reasoning**: Q3's answer is WebAuthn/passkeys with `tao@belcort.com`. This rewrite pins Auth.js v5, names the passkey provider, defines the registration flow (separate `INITIAL_REGISTRATION_TOKEN`-gated route so the first phone+laptop pair-up is possible), and notes the fallback path is one-line — keeping the Generator's optionality explicit.

---

### Patch 8 — Q3: Architecture Stack table — Auth row updated for passkeys

**File**: `.harness/spec/architecture.md`
**Location**: § Stack table, "Auth (dashboard)" row

```diff
-| Auth (dashboard) | Auth.js (NextAuth.js) | v5+ for Next.js 16 | NFR-009 | Vercel-native, single-user trivially via email magic-link; multi-user-extensible without rewrite. |
+| Auth (dashboard) | Auth.js (NextAuth.js) v5 + WebAuthn provider | v5+ for Next.js 16 | NFR-009 | Vercel-native; passkey-only in v1 (no SMTP infra, no shared-secret in inbox); multi-device via separate passkey registrations on phone + laptop; fallback to magic-link is a one-line provider swap. Resolved per clarify Q3 (2026-05-01). |
```

**Reasoning**: Stack table mirrors the AC-006-1 change. Passkey provider named, multi-device pattern noted, fallback path acknowledged.

---

### Patch 9 — Q4: Architecture ADR-009 — restart-on-idle replaces daily 03:00 restart

**File**: `.harness/spec/architecture.md`
**Location**: § Key Stack Decisions § ADR-009

```diff
-### ADR-009: Periodic Channels-session restart at 03:00 GMT (silent default)
-- **Context**: Long-lived LLM sessions can accumulate context bloat or memory pressure over days.
-- **Options considered**: Never restart (clean if no leak); daily restart (planned outage during low-traffic minute); restart-on-symptom (detect bloat, restart conditionally).
-- **Chosen**: Daily 03:00 GMT restart via systemd timer.
-- **Rationale**: 03:00 GMT is before the daily Planner (04:00 GMT) and outside any market session; planned restart removes uncertainty.
-- **Affects**: FR-005.
+### ADR-009: Channels-session restart-on-idle (resolved per clarify Q4, 2026-05-01)
+- **Context**: Long-lived LLM sessions can accumulate context bloat or memory pressure over days. The original silent default (daily 03:00 GMT restart) was rejected by the operator because it daily-wipes conversational context the operator may want to reference ("yesterday at the NY open you closed EUR/USD because of CPI; what's your current view?").
+- **Options considered**: (i) never restart (clean if no leak, but RISK-004 unaddressed); (ii) daily 03:00 GMT restart (original silent default — rejected, daily context loss); (iii) restart-on-idle (chosen — restart only when session has been idle ≥ 4h AND it is outside both Euro and NY sessions, currently 22:00–06:00 GMT); (iv) restart-on-symptom (e.g., on memory threshold) — rejected as over-engineered for v1 single-tenant scale.
+- **Chosen**: Option (iii) restart-on-idle. Implementation: a small `systemd` timer fires every 30 min and runs a check script that (a) queries the most recent `telegram_interactions.received_at` for this tenant, (b) confirms current GMT is in `[22:00, 06:00]`, (c) if both conditions met (idle ≥ 4h AND off-hours), runs `systemctl restart caishen-channels` AND posts a `channels_health` row with `restart_reason='scheduled_idle'`. Before restart, the script writes a 90s-mute marker into `channels_health` so the Vercel-cron healthcheck (FR-005 AC-005-2) suppresses any down-alert during the restart window.
+- **Rationale**: Preserves conversational context across days for the operator's "what was your view yesterday" workflow while still bounding session lifetime to address RISK-004's memory-pressure concern. The off-hours + idle-gate combination ensures NFR-002 (Telegram p95 ≤ 3s) is never paid as a cold-start cost during trading hours. The Channels-session subagent system prompt also notes that `telegram_interactions` and `routine_runs` are queryable via `mcp__postgres_query`, so even when context HAS been lost (after restart), the operator can ask "what did you tell me yesterday?" and get a real answer reconstructed from audit rows.
+- **Affects**: FR-004 (subagent system prompt mentions postgres-query recovery hint), FR-005 (cron healthcheck honors mute marker).
```

**Reasoning**: Q4's answer is option (iii) — restart-on-idle with conditions, alarm-mute coordination, and the system-prompt-hint addendum. ADR-009 is rewritten end-to-end to capture all three pieces; the prompt-hint piece is logged here AND surfaces as a Generator concern in the Channels-session-prompt deliverable.

---

### Patch 10 — Q5: Architecture ADR-008 — drop scrape, ship local counters only with conditional reconciliation

**File**: `.harness/spec/architecture.md`
**Location**: § Key Stack Decisions § ADR-008

```diff
-### ADR-008: Cap-monitoring data source priority
-- **Context**: NFR-006 needs a way to read current Anthropic cap usage.
-- **Options considered**: Anthropic `/v1/usage` HTTP API if it exposes one (documented for `/usage` slash command, may have a programmatic counterpart); headless-browser scrape of operator's `/usage` page from a Vercel cron; tracking-only via local counters in `routine_runs`.
-- **Chosen**: `/v1/usage` API if available (preferred); fallback to headless scrape; emergency fallback to local counters which assume cap is what we count.
-- **Rationale**: First-party data > scraped > local-derived.
-- **Affects**: NFR-006, FR-021.
+### ADR-008: Cap-monitoring data source = local counters (v1) + conditional reconciliation cron (resolved per clarify Q5, 2026-05-01)
+- **Context**: NFR-006 needs a way to read current Anthropic cap usage. The original silent default attempted to layer (a) `/v1/usage` API → (b) headless-browser scrape → (c) local counters; the scrape path was rejected by the operator because storing claude.ai login cookies in Vercel env is a credential-rotation problem AND Cloudflare's bot-detection on claude.ai is a reliability risk.
+- **Options considered (revised)**: (i) `/v1/usage` HTTP API if Anthropic exposes one; (ii) headless-browser scrape of `claude.ai/usage` — REJECTED entirely (cookie-storage risk, Cloudflare-bot-detection risk); (iii) local counters only (every cap-burning code path inserts a `cap_usage_local` row, dashboard reads from this); (iv) hybrid: local counters as v1 source of truth + reconciliation cron against `/v1/usage` IF it exists.
+- **Chosen**: V1 ships **local counters only** (option iii). FR-001 spike (AC-001 series) checks whether `/v1/usage` is exposed; if YES, FR-021 follow-on adds a daily reconciliation Vercel cron that compares the local count against Anthropic's reported number for the same date and alerts on drift > 1 slot (option iv path). If `/v1/usage` is NOT exposed, v1 stays on local-counters-only and the dashboard's cap-progress-bar carries a "local-counter-derived" tooltip.
+- **Rationale**: At single-tenant scale local counters are reliable IF every cap-burning code path is instrumented; the surface to instrument is small (Planner routine fire, Executor one-off fire, dashboard `/fire`-driven re-plan, cap-status cron itself). Headless scrape would have been the heaviest implementation surface AND the highest failure-mode surface (auth rotation + bot-detection + DOM drift) — its expected operational benefit at our scale (catching out-of-band fires from the operator's terminal that bypass our counters) is small enough that we accept the residual risk in v1. Reconciliation cron, gated on the spike outcome, gives us a verification path without committing to it speculatively.
+- **Affects**: NFR-006, FR-021 (AC-021-1 simplifies; AC-021-4 obsoleted as written).
```

**Reasoning**: Q5's answer drops scrape entirely. ADR-008 rewritten to reflect local-counters-as-source-of-truth with a conditional follow-on reconciliation cron behind the FR-001 spike outcome.

---

### Patch 11 — Q5: PRD FR-021 AC-021-1 — local counters source

**File**: `.harness/spec/prd.md`
**Location**: § Functional Requirements § FR-021 § Acceptance Criteria § AC-021-1

```diff
-  - [ ] AC-021-1: A small "cap-status" routine runs at 12:00 GMT (cap-counted, costs 1 of 15) — OR a dedicated Vercel cron uses the `/v1/usage` HTTP API if Anthropic exposes one (check during FR-001 spike) — and writes today's usage to a `cap_usage` Postgres table.
+  - [ ] AC-021-1: V1 ships local-counter-derived cap data: every cap-burning code path (Planner routine fire, each Executor one-off fire, dashboard `/fire`-driven re-plan, the cap-status cron itself) inserts a row into `cap_usage_local` (`tenant_id`, `at`, `cap_kind ∈ {planner_recurring, executor_one_off_cap_counted, replan_fire, cap_status_cron}`, `routine_runs_id` FK). A Vercel cron at 12:00 GMT computes today's totals from `cap_usage_local` and inserts a daily `cap_usage` row (`tenant_id`, `date`, `daily_used`, `daily_limit=15`, `weekly_used`, `weekly_limit`, `source='local_counter'`). If FR-001 spike confirms `/v1/usage` is exposed, a follow-on Vercel cron also fetches Anthropic-reported numbers daily and inserts a parallel `cap_usage` row with `source='anthropic_api'`; drift > 1 slot triggers a Telegram alert. Headless-browser scrape is **explicitly out of scope** for v1.
```

**Reasoning**: Q5's answer crisply specifies the cap_usage_local instrumentation surface, the daily computation cron, the conditional reconciliation behind FR-001 outcome, and the explicit out-of-scope-of-v1 stance on scrape. The original AC-021-1 mixed all three options into a single sentence; this rewrite picks the answered path.

---

### Patch 12 — Q5: PRD FR-021 AC-021-4 — drop the assumption-dependent edge clause

**File**: `.harness/spec/prd.md`
**Location**: § Functional Requirements § FR-021 § Acceptance Criteria § AC-021-4

```diff
-  - [ ] AC-021-4: If FR-001's AC-001-1 came back as "one-offs cap-exempt" (the assumed PASS case): cap usage is mostly only the daily Planner + any `/fire`-driven re-plans, so 14/15 is unusual and indicates abuse.
+  - [ ] AC-021-4: Cap-usage interpretation is contingent on FR-001 AC-001-1 outcome: if PASS (one-offs cap-exempt), expected daily usage is ~1/15 (the Planner) plus any `/fire`-driven re-plans, so >5/15 on a normal day flags either heavy operator-driven re-planning or an out-of-band spike worth investigating; if FAIL (one-offs cap-counted per ADR-002 fallback), expected daily usage is up to 14/15 with 1 slot reserved for emergency re-plan, so 14/15 is normal and 15/15 is hard-stop. The dashboard tooltip on the cap-progress-bar reflects the chosen interpretation based on what FR-001 returned (Generator selects the right tooltip text at build time per the spike report's PASS/FAIL outcome).
```

**Reasoning**: Q5 doesn't directly touch AC-021-4 but it inherits Q5's clarity-improvement spirit — the original AC-021-4 was a vague "if assumed-PASS" clause that didn't say what to do if FAIL. Rewritten to give both interpretation modes and pin the tooltip to the spike outcome.

---

### Patch 13 — Q6: Architecture ADR-006 — 365 day default + env override + dashboard cold-archive recall

**File**: `.harness/spec/architecture.md`
**Location**: § Key Stack Decisions § ADR-006

```diff
-### ADR-006: Audit retention = 90 days hot in Postgres + cold archive in Blob (silent default)
-- **Context**: Postgres tables grow forever otherwise.
-- **Options considered**: Forever in Postgres (storage cost grows linearly, query cost grows); 30-day hot + cold archive (too aggressive — operator wants reasonable retention for review); 90-day hot + cold archive (chosen); 365-day hot + cold archive (too much storage at a single-tenant scale).
-- **Chosen**: 90-day hot, then daily Vercel cron archives older rows to a Blob "cold archive" prefix indexed by date.
-- **Rationale**: 90 days covers operator's typical review window; archive is recoverable for forensics.
-- **Affects**: NFR-004, FR-007.
+### ADR-006: Audit retention = 365 days hot in Postgres + cold archive in Blob, configurable via env (resolved per clarify Q6, 2026-05-01)
+- **Context**: Postgres tables grow forever otherwise. The original silent default was 90-day hot retention; the operator preferred 365 days because trader workflows often look back at "last quarter" or "last year same month" for performance review and the original 90-day window broke that promise once "yesterday" became "3 months ago".
+- **Options considered (revised)**: Forever in Postgres (storage cost grows linearly forever); 30-day hot (too aggressive); 90-day hot (original silent default — rejected, breaks "last quarter" review); **365-day hot (CHOSEN)**; configurable-via-env so operator can tune up or down without a code change.
+- **Chosen**: **365-day hot retention in Postgres + cold archive in Vercel Blob** at `archive/{tenant_id}/{YYYY-MM}/` after the hot window. Default `AUDIT_HOT_DAYS=365`, configurable via env var. Daily Vercel cron at 03:30 GMT archives any audit rows older than `AUDIT_HOT_DAYS` to Blob. Dashboard "History" page transparently fetches from cold archive when the operator filters to a date older than `AUDIT_HOT_DAYS` — a Next.js Route Handler mints a signed Blob URL and the page renders with a "loading from archive…" skeleton during the fetch.
+- **Rationale**: 365 days fits comfortably under Neon's free-tier 0.5 GB at single-tenant scale (audit rows are small text — ~few MB/year worst case at a few hundred routine fires + few thousand Telegram interactions/year). Configurable via env so the operator can dial down later if storage cost surfaces. PII (Telegram user IDs, message text) is NOT separated from trading data in v1 because the operator IS the only PII subject — re-evaluate at the multi-tenant migration.
+- **Affects**: NFR-004, FR-007 (EC-007-2 — 90 day reference updated; new Cold Archive Recall behavior implied for the History view).
```

**Reasoning**: Q6's answer is comprehensive: 365 default + env-var override + dashboard recall path + PII deferred. ADR-006 rewritten to capture all four.

---

### Patch 14 — Q6: PRD FR-007 EC-007-2 — 90 → 365 day default + env-var + recall behavior

**File**: `.harness/spec/prd.md`
**Location**: § Functional Requirements § FR-007 § Edge Cases § EC-007-2

```diff
-  - EC-007-2: Audit table grows unboundedly → daily Vercel cron archives rows older than 90 days to a separate Vercel Blob "cold archive" prefix. Default 90-day retention recorded in `architecture.md` ADR-006 as a silent default.
+  - EC-007-2: Audit table grows unboundedly → daily Vercel cron at 03:30 GMT archives rows older than `AUDIT_HOT_DAYS` (default **365**) to a separate Vercel Blob "cold archive" prefix at `archive/{tenant_id}/{YYYY-MM}/`. Operator can override by setting `AUDIT_HOT_DAYS` env var (e.g., `=90` to recover Neon space). Dashboard "History" view transparently fetches from cold archive when the user filters to a date older than `AUDIT_HOT_DAYS`: Route Handler mints a signed Blob URL (`expires-in 1h`), page renders skeleton + "loading from archive…" spinner, then displays the rows from the fetched JSON. Resolved per clarify Q6 (2026-05-01); see ADR-006.
```

**Reasoning**: Q6's answer needs the FR side updated too — old text said 90 days as silent default; new text reflects 365 + env override + cold-archive recall path with concrete UX.

---

### Patch 15 — Q7: PRD FR-006 AC-006-2 — design-bundle fallback to text-based generation

**File**: `.harness/spec/prd.md`
**Location**: § Functional Requirements § FR-006 § Acceptance Criteria § AC-006-2

```diff
-  - [ ] AC-006-2: Five core screens are present (the Claude Design bundle in `design/dashboard-bundle/` defines the visual design — Generator translates via `frontend-design` skill): **Overview** (balance/equity, today's P&L, today's schedule with countdowns, open positions table), **Per-pair Detail** (per-pair history, last report, current position), **Schedule** (today's schedule + "force re-plan" button), **History** (filterable trade history, per-pair report archive with rendered markdown), **Override Panel** (close-all, close-pair, edit-SL/TP forms, audit of recent overrides).
+  - [ ] AC-006-2: Five core screens are present: **Overview** (balance/equity, today's P&L, today's schedule with countdowns, open positions table), **Per-pair Detail** (per-pair history, last report, current position), **Schedule** (today's schedule + "force re-plan" button), **History** (filterable trade history, per-pair report archive with rendered markdown, transparent cold-archive fetch per FR-007 EC-007-2), **Override Panel** (close-all, close-pair, edit-SL/TP forms, audit of recent overrides). Design source: if `design/dashboard-bundle/index.html` exists, the Generator's `frontend-design` skill consumes the bundle directly. If the bundle does NOT exist, the Generator invokes `frontend-design` skill on the AC-006-2 wireframe descriptions above (text-based generation from the PRD); the implementation report MUST explicitly flag "design generated from text — Claude Design bundle was not present at build time" so the operator knows to run a Claude Design pass and re-iterate. `init.sh` prints an "operator action required" warning (per FR-020 AC-020-3) when the bundle is missing, with instructions for what to export and where to put it.
```

**Reasoning**: Q7's answer is the degraded-build-with-flag pattern. AC-006-2 is rewritten to embed both paths (bundle present → consume; bundle missing → text-based generation + flagged in implementation report) and to wire up the init.sh warning.

---

### Patch 16 — Q7: PRD FR-006 EC-006-2 — clarify the dual path (no functional change but explicit)

(Skipped — Q7's coverage is fully captured in AC-006-2 above. EC-006-2 is about Planner-run-in-flight, unrelated. No patch needed here.)

---

### Patch 17 — Q8: PRD FR-013 — conditional behavior keyed to FR-001 AC-001-2 math fidelity

**File**: `.harness/spec/prd.md`
**Location**: § Functional Requirements § FR-013 (header through edge cases)

```diff
 ### FR-013: Code interpreter substitute for the Executor (`compute_python` MCP)
 - **Journey**: UJ-001
-- **Priority**: P1
+- **Priority**: P1 (conditional — see AC-013-1 below)
 - **User Story**: As Tao, I want the Executor to have access to a sandboxed Python execution tool for any heavy math (ATR computation, position-size math) that would be awkward in pure prompt reasoning, so that the n8n GPT-5.4 system's code-interpreter capability isn't lost in the migration.
 - **Acceptance Criteria**:
-  - [ ] AC-013-1: A `compute_python` MCP server is attached to the Executor routine as a connector. It accepts a Python expression/snippet and returns the result. Implementation runs on Vercel Sandbox (or a similar ephemeral execution environment); spec doesn't lock the impl, see ADR.
-  - [ ] AC-013-2: The Executor system prompt is NOT modified to mention `compute_python` (preserve verbatim is non-negotiable). Instead, the tool is documented in the routine connector list; Opus 4.7 is left to discover when to call it (it's good at this).
+  - [ ] AC-013-1: **Conditional build, gated on FR-001 AC-001-2 math-fidelity outcome**: as part of FR-001 AC-001-2, the spike runs a synthetic ATR computation on a known-answer dataset, comparing Opus 4.7's output to a Python reference implementation (the spike report includes a "Math fidelity check" section). If max relative error is < 1e-3, FR-013 is moved to "out of scope v1, ticket for v2"; `compute_python` MCP is NOT built and FR-013 is marked SKIPPED in `decisions.md` with the spike's evidence. If max relative error is ≥ 1e-3 OR Opus refuses to compute (rare), FR-013 builds per the original spec: a `compute_python` MCP server is attached to the Executor routine as a connector, accepts a Python expression/snippet and returns the result, runs on Vercel Sandbox (or a similar ephemeral execution environment); spec doesn't lock the impl, see ADR. Either decision is recorded in `decisions.md` with the spike report citation.
+  - [ ] AC-013-2: IF FR-013 is built (math-fidelity FAILED): the Executor system prompt is NOT modified to mention `compute_python` (preserve verbatim is non-negotiable). Instead, the tool is documented in the routine connector list; Opus 4.7 is left to discover when to call it (it's good at this). IF FR-013 is skipped (math-fidelity PASSED): no Executor changes, `compute_python` MCP is not provisioned, Vercel Sandbox attack surface is not introduced.
 - **Edge Cases**:
-  - EC-013-1: `compute_python` adds latency that pushes the Executor past the duration limit → fallback per FR-001 EC-001-2.
-  - EC-013-2: Operator decides Opus's native math is sufficient and `compute_python` was unnecessary → the connector is detached. Recorded in retrospective.
+  - EC-013-1: IF FR-013 is built and `compute_python` adds latency that pushes the Executor past the duration limit → fallback per FR-001 EC-001-2.
+  - EC-013-2: IF FR-013 is skipped at build time but operator later observes ATR drift in production → re-open via `/harness:edit "build FR-013 compute_python MCP per original AC-013-1 fallback path"`. The conditional is reversible.
```

**Reasoning**: Q8's answer makes FR-013 conditional. The whole FR is rewritten to gate the build on the FR-001 AC-001-2 math-fidelity outcome, and ECs reflect both paths (built + drift, skipped + reversible).

---

### Patch 18 — Q9: Architecture Stack table — lock Drizzle, remove Prisma caveat

**File**: `.harness/spec/architecture.md`
**Location**: § Stack table, "ORM/migrations" row

```diff
-| ORM/migrations | Drizzle ORM + Drizzle Kit | latest | §4, §12 | Type-safe queries; per-tenant filter is enforceable in code; lightweight migration tool. (Generator may pick Prisma instead during negotiation; both qualify.) |
+| ORM/migrations | Drizzle ORM + Drizzle Kit | latest | §4, §12 | Type-safe queries with `WHERE tenant_id = $1` enforceable at the type level (more obvious in code review than Prisma's middleware row-level filter); smaller runtime + edge-friendly pattern fits Vercel Functions; Drizzle Kit migrations simple to author by hand for v1's small schema. **Locked per clarify Q9 (2026-05-01)** — Generator does not negotiate ORM choice. |
```

**Reasoning**: Q9 locks Drizzle. Stack table updated, "or Prisma" caveat removed, rationale preserved + the lock note added so the negotiation phase doesn't re-open this.

---

### Patch 19 — Q9: Architecture Deferred-to-Negotiation list — remove ORM bullet

**File**: `.harness/spec/architecture.md`
**Location**: § Deferred to Negotiation Phase (the bullet list)

```diff
 - Workspace / monorepo layout (`apps/`, `packages/`, etc.)
 - Specific file paths inside each workspace
-- ORM choice (Drizzle vs. Prisma — both qualify under §4 multi-tenant requirement)
 - Exact Postgres index list beyond the must-haves in FR-008 AC-008-3
```

**Reasoning**: Q9 locks the ORM choice; the Deferred list bullet that contradicted the Stack table needs to go away.

---

### Patch 20 — Q10: Architecture Deferred-to-Negotiation list — remove package-manager bullet

**File**: `.harness/spec/architecture.md`
**Location**: § Deferred to Negotiation Phase (the bullet list)

```diff
 - Headless-browser library if scrape path is chosen for cap monitoring (Playwright already in stack — likely reuse)
-- pnpm vs npm vs bun for the project's package manager (Bun is on the VPS already; pnpm is Vercel-friendly; choose one)
 - Test harness for the Channels session's tool integration (likely a record-replay)
```

**Reasoning**: Q10 locks Bun. The Deferred list bullet is removed.

---

### Patch 21 — Q10: PRD FR-020 AC-020-1 — bun-only canonical wording

**File**: `.harness/spec/prd.md`
**Location**: § Functional Requirements § FR-020 § Acceptance Criteria § AC-020-1

```diff
-  - [ ] AC-020-1: `init.sh` on the dev laptop verifies: Node >= 20, Bun installed (or installs it), git clean working tree, `pnpm install`, runs lint + tsc + tests, runs `make audit-no-api-key`, smoke-tests Cloudflare Tunnel auth (FR-009 AC-009-4).
+  - [ ] AC-020-1: `init.sh` on the dev laptop verifies: Node >= 20, **Bun installed (or installs it — Bun is the canonical package manager for this project per clarify Q10, used on local dev + Vercel build + VPS scripts)**, git clean working tree, `bun install`, runs lint + tsc + tests via `bun run`, runs `make audit-no-api-key`, smoke-tests **Tailscale Funnel + bearer-token auth** (FR-009 AC-009-4 — see also patch 3 for the Q2 architecture change). The `package.json` `packageManager` field pins `bun@<version>` and `bun.lock` is committed; Vercel project settings: install command = `bun install`, build command = `bun run build`.
```

**Reasoning**: Q10 locks Bun, and Q2 (separately) already changed the tunnel from Cloudflare to Tailscale Funnel — both updates land in the same AC because both are FR-020-AC-020-1's responsibility surface (the dev-laptop init.sh smoke). Cross-referenced patch-3 for the tunnel change to keep the trail visible.

---

### Patch 22 — Q2: Architecture Stack table — replace Tunnel row

**File**: `.harness/spec/architecture.md`
**Location**: § Stack table, "Tunnel (VPS → cloud)" row

```diff
-| Tunnel (VPS → cloud) | Cloudflare Tunnel + Cloudflare Access | `cloudflared` latest, Access Service Tokens | FR-009 | Verified via Context7: Service Token (`CF-Access-Client-Id`/`CF-Access-Client-Secret`) is documented for non-browser callers. Bearer-in-URL alternative leaks more readily. Tailscale's funnel doesn't expose internal services to Anthropic-cloud routines without ACL gymnastics. |
+| Tunnel (VPS → cloud) | Tailscale Funnel + app-layer bearer | `tailscale` latest | FR-009 | Verified via Context7 (2026-05-01): `tailscale funnel` exposes a local HTTP service publicly via auto-assigned `*.ts.net` hostname with TLS, accessible to non-Tailscale callers (Anthropic Routines + Vercel Functions both call OK). Funnel surface is intentionally public — auth lives in app layer (gateway enforces `Authorization: Bearer ${MT5_BEARER_TOKEN}`). Operator does not own a Cloudflare-managed domain at v1 launch, so this is the no-domain path. **Resolved per clarify Q2 (2026-05-01)**; see ADR-005 (revised). When operator acquires a domain, `/harness:edit` re-introduces the Cloudflare Tunnel + Access Service Token pattern. |
```

**Reasoning**: Q2 architecture change — Stack table mirrors the FR-009 + ADR-005 changes. Rationale points at Context7 verification done at clarify time (Tailscale Funnel does work for non-Tailscale HTTP callers), names the no-domain motivation, and preserves the migration path.

---

### Patch 23 — Q2: Architecture ADR-005 — full rewrite for Tailscale Funnel

**File**: `.harness/spec/architecture.md`
**Location**: § Key Stack Decisions § ADR-005

```diff
-### ADR-005: Cloudflare Tunnel + Access Service Token over alternatives
-- **Context**: Need to expose VPS-resident MT5 REST + ForexFactory MCP to Routines (Anthropic cloud) and Vercel functions (dashboard reads).
-- **Options considered**: Cloudflare Tunnel + Access Service Token (CF-Access-Client-Id + CF-Access-Client-Secret); Cloudflare Tunnel + bearer token in URL or header; Tailscale Funnel + ACLs; mTLS proxy (HAProxy with client-cert auth).
-- **Chosen**: Cloudflare Tunnel + Access Service Token.
-- **Rationale**: Documented for non-browser callers; bearer-in-URL is more leaky; Tailscale Funnel doesn't easily expose to Anthropic-cloud Routines without an additional public-listener layer; mTLS is operationally heavier.
-- **Affects**: NFR-001, FR-009.
+### ADR-005: Tailscale Funnel + app-layer bearer token (resolved per clarify Q2, 2026-05-01)
+- **Context**: Need to expose VPS-resident MT5 REST + ForexFactory MCP to Routines (Anthropic cloud) and Vercel Functions (dashboard reads). Original silent default (Cloudflare Tunnel + Access Service Token) was rejected at clarify time because the operator does not own a Cloudflare-managed domain at v1 launch, and registering / migrating DNS to Cloudflare is a launch-blocker the operator wants to defer.
+- **Options considered (revised)**:
+  - (a) Cloudflare Tunnel + Access Service Token — original silent default. **Rejected** — requires Cloudflare-managed domain the operator does not own at v1 launch.
+  - (b) Cloudflare Tunnel + bearer-in-URL — same domain prerequisite, plus bearer-in-URL is a leakier auth model.
+  - (c) **Tailscale Funnel + app-layer bearer token (CHOSEN)** — `tailscale funnel <port>` exposes a local HTTP service to the public internet via auto-assigned `*.ts.net` hostname with automatic TLS. No domain prerequisite. Funnel surface is intentionally public — Tailscale Funnel does NOT include built-in auth for callers, so auth moves into the app layer (gateway enforces `Authorization: Bearer ${MT5_BEARER_TOKEN}` on every request). Verified via Context7 lookup at clarify time: `tailscale funnel 3000` works against non-Tailscale HTTP callers (perfect for Anthropic Routines + Vercel Functions). Cost: free.
+  - (d) mTLS proxy (HAProxy with client-cert auth) — operationally heavier, no domain prerequisite but cert-management overhead.
+  - (e) ngrok / similar third-party tunneling service — paid, Tailscale Funnel matches the value at zero cost since the operator was already going to use Tailscale for SSH.
+- **Chosen**: (c) Tailscale Funnel + app-layer bearer token.
+- **Rationale**: Removes the domain prerequisite (the operator's stated blocker), free, automatic TLS, verified to work for non-Tailscale-client HTTP callers (Routines + Vercel both reach OK). Auth via app-layer bearer is straightforward to implement at the MT5 REST gateway and rotates cleanly via `/etc/caishen/channels.env`. Trade-off accepted: the Funnel surface IS publicly addressable (anyone with the `*.ts.net` hostname can attempt a connection); we mitigate by enforcing bearer at gateway level (any unauthenticated request gets 401, see FR-009 AC-009-3) and by giving the healthcheck endpoint a separate bearer (FR-005 AC-005-1) so a leaked MT5 bearer can't probe internals.
+- **Migration path**: When the operator acquires a Cloudflare-managed domain later, `/harness:edit "switch VPS-to-cloud transport from Tailscale Funnel to Cloudflare Tunnel + Access Service Token using domain {domain}"` replays this ADR's prior version (option a) as the chosen path.
+- **Affects**: NFR-001 (transport reliability), FR-009 (full FR rewrite — see PRD), FR-005 (healthcheck via same Funnel), Stack table "Tunnel (VPS → cloud)" row, init.sh smoke test (now `tailscale funnel` health), VPS setup script (`infra/vps/setup.sh` installs Tailscale instead of cloudflared).
```

**Reasoning**: Q2 is the largest architectural change in this clarify round. ADR-005 is rewritten end-to-end to capture: original-decision-rejected reasoning, all five options considered (including the previously rejected paths), the chosen path with Context7-verified rationale, the explicit acknowledgement that the public-surface trade-off is mitigated at app layer, and the forward migration path so this is reversible when the operator acquires a domain.

---

### Patch 24 — Q2: Architecture Architectural Style — replace tunnel mention

**File**: `.harness/spec/architecture.md`
**Location**: § Architectural Style (single paragraph)

```diff
-A three-surface system: (1) **Trading core** is a set of cron+one-off Claude Code Routines on Anthropic's cloud, all subscription-billed. (2) **Telegram** is an always-on Claude Code Channels session running as a systemd service on the operator's VPS. (3) **Dashboard** is a Next.js 16 App Router project on Vercel free tier. All three surfaces share state through a single Vercel Postgres (Neon) database and a Vercel Blob bucket. The MT5 REST API and ForexFactory MCP live on the operator's VPS and are reached by (1) and (3) through a Cloudflare Tunnel with Access Service Token; (2) reaches them locally. No Anthropic API SDK is ever loaded; LLM calls only originate from (1) and (2). All time is GMT/UTC; localization happens in the dashboard view layer only.
+A three-surface system: (1) **Trading core** is a set of cron+one-off Claude Code Routines on Anthropic's cloud, all subscription-billed. (2) **Telegram** is an always-on Claude Code Channels session running as a systemd service on the operator's VPS. (3) **Dashboard** is a Next.js 16 App Router project on Vercel free tier. All three surfaces share state through a single Vercel Postgres (Neon) database and a Vercel Blob bucket. The MT5 REST API and ForexFactory MCP live on the operator's VPS and are reached by (1) and (3) through a Tailscale Funnel (auto-assigned `*.ts.net` hostname, no domain required at v1 launch) with app-layer bearer-token auth at the gateway; (2) reaches them locally. No Anthropic API SDK is ever loaded; LLM calls only originate from (1) and (2). All time is GMT/UTC; localization happens in the dashboard view layer only.
```

**Reasoning**: Architectural Style paragraph is the elevator pitch — Cloudflare reference must update.

---

### Patch 25 — Q2: Architecture NFR Feasibility Check — NFR-001 row update

**File**: `.harness/spec/architecture.md`
**Location**: § NFR Feasibility Check § NFR-001 bullet

```diff
-- **NFR-001 (≥99.5% scheduled fires execute)**: Routines + Postgres + audit-or-abort design (§3) gives observable failure attribution. Cap-exempt one-offs (verified in FR-001) keep scheduling within budget. Tunnel + Service Token gives a stable transport. Risk concentrated in the long-running Executor; FR-001 AC-001-2 measures and informs split/fallback.
+- **NFR-001 (≥99.5% scheduled fires execute)**: Routines + Postgres + audit-or-abort design (§3) gives observable failure attribution. Cap-exempt one-offs (verified in FR-001) keep scheduling within budget. Tailscale Funnel + app-layer bearer (per ADR-005 revised) gives a stable, free transport with no domain prerequisite — Funnel hostnames are stable per-tailnet-node. Risk concentrated in the long-running Executor; FR-001 AC-001-2 measures and informs split/fallback. Funnel-hostname-drift on VPS re-auth is caught by init.sh smoke (FR-009 AC-009-4) per RISK-005 v1 subnote.
```

**Reasoning**: NFR Feasibility Check explicitly reasoned about transport — must reflect Q2's change.

---

### Patch 26 — Q5: Architecture NFR Feasibility Check — NFR-006 row update

**File**: `.harness/spec/architecture.md`
**Location**: § NFR Feasibility Check § NFR-006 bullet

```diff
-- **NFR-006 (token budget ≤ 80% Max 20x weekly)**: FR-001 AC-001-4 establishes baseline; ongoing weekly cron monitors. If exceeded, Channels free-text capability is the first lever (cap output tokens, route slash commands to Vercel Functions).
+- **NFR-006 (token budget ≤ 80% Max 20x weekly)**: FR-001 AC-001-4 establishes baseline; ongoing weekly cron monitors via `cap_usage_local` (per ADR-008 revised — local-counter source-of-truth, scrape path dropped). If exceeded, Channels free-text capability is the first lever (cap output tokens, route slash commands to Vercel Functions). If FR-001 spike reveals `/v1/usage` API exposure, daily reconciliation cron (per ADR-008 option iv) provides cross-check on the local count; drift > 1 slot triggers Telegram alert.
+
```

**Reasoning**: Q5's ADR-008 rewrite needs to ripple into the NFR Feasibility Check; NFR-006 used to vaguely point at "scrape" indirectly via "ongoing cron" — now it explicitly points at `cap_usage_local`.

---

### Patch 27 — Q4: PRD RISK-004 — restart cadence updated

**File**: `.harness/spec/prd.md`
**Location**: § Risks § RISK-004

```diff
-- **Mitigation**: FR-005 (systemd Restart=always + Vercel-cron healthcheck + out-of-band Telegram Bot API alert at 10 min downtime). Recovery message on restart (FR-005 AC-005-3). Periodic restart cron (e.g., daily at 03:00 GMT, 1h before the Planner) recorded as silent default ADR-009.
+- **Mitigation**: FR-005 (systemd Restart=always + Vercel-cron healthcheck + out-of-band Telegram Bot API alert at 10 min downtime). Recovery message on restart (FR-005 AC-005-3). **Restart-on-idle cron** (per ADR-009 revised — restarts only when session has been idle ≥ 4h AND current GMT is in `[22:00, 06:00]`, with 90s alarm-mute before restart so the cron healthcheck doesn't false-alarm) replaces the original "daily 03:00" silent default. Subagent system prompt notes that yesterday's Telegram history is queryable from `telegram_interactions` so context loss across restart is recoverable.
```

**Reasoning**: Q4 changed the restart strategy. RISK-004's mitigation paragraph references the cadence and must update.

---

### Patch 28 — Q1, Q2: contract.md D6 (FR-009 deliverable) — retitle

**File**: `.harness/features/001-foundation-routines-channels-dashboard/contract.md`
**Location**: § Deliverables § D6

```diff
-### D6: [FR-009] Cloudflare Tunnel + Access Service Token (M1)
+### D6: [FR-009] Tailscale Funnel + app-layer bearer (M1) — per clarify Q2
 - AC-009-1, AC-009-2, AC-009-3, AC-009-4
-- EC-009-1, EC-009-2
+- EC-009-1, EC-009-2, EC-009-3
```

**Reasoning**: Q2 changes the D6 deliverable surface. Retitled, EC-009-3 (the "switch back to Cloudflare when domain available" path) added per FR-009 patch above.

---

### Patch 29 — Q2: contract.md Build Order step 6 — Cloudflare → Tailscale

**File**: `.harness/features/001-foundation-routines-channels-dashboard/contract.md`
**Location**: § Suggested Build Order § M1 § step 6

```diff
-6. **FR-009** — Cloudflare Tunnel + Access Service Token; init.sh smoke test; verify MT5 REST + ForexFactory MCP both reachable through it.
+6. **FR-009** — **Tailscale Funnel + app-layer bearer** (per clarify Q2 — operator does not own a domain at v1 launch); init.sh smoke test; gateway-side bearer enforcement (replaces what Cloudflare Access previously provided); verify MT5 REST + ForexFactory MCP both reachable through it via `Authorization: Bearer ${MT5_BEARER_TOKEN}`. When operator later acquires a domain, `/harness:edit` swaps in the Cloudflare Tunnel + Access Service Token pattern from the prior ADR-005 version.
```

**Reasoning**: Build order step 6 is the "what we build next" deliverable line — must reflect the Q2 change so the Generator picks the right path during negotiation + build.

---

### Patch 30 — Q8: contract.md Build Order step 12 — FR-013 conditional

**File**: `.harness/features/001-foundation-routines-channels-dashboard/contract.md`
**Location**: § Suggested Build Order § M2 § step 12

```diff
-12. **FR-013** — `compute_python` MCP server (Vercel Sandbox impl); attach to Executor.
+12. **FR-013** — **Conditional, gated on FR-001 AC-001-2 math-fidelity outcome** (per clarify Q8): if max relative error < 1e-3 on the spike's synthetic ATR comparison, FR-013 is SKIPPED in v1 and `decisions.md` records the skip + spike evidence; Vercel Sandbox attack surface is not introduced. If error ≥ 1e-3 or Opus refuses to compute, FR-013 builds per the original spec — `compute_python` MCP server (Vercel Sandbox impl); attach to Executor. Either path is recorded in `decisions.md`.
```

**Reasoning**: Build order step 12 must surface the conditional so the Generator runs the spike's math-fidelity check first and uses its outcome as the build decision.

---

### Patch 31 — Q1: contract.md D19 (FR-004 deliverable) — note the AC-004-6 specifics

**File**: `.harness/features/001-foundation-routines-channels-dashboard/contract.md`
**Location**: § Deliverables § D19

```diff
 ### D19: [FR-004] Always-on Channels session (M4)
 - AC-004-1, AC-004-2, AC-004-3, AC-004-4, AC-004-5, AC-004-6
 - EC-004-1, EC-004-2, EC-004-3
+- Note (per clarify Q1): AC-004-6 enforcement is via `tenants.allowed_telegram_user_ids` JSON column populated by `infra/vps/setup.sh` from the `ALLOWED_TELEGRAM_USER_IDS` env var. Off-allowlist messages produce a `telegram_interactions` audit row with `command_parsed='REJECTED_NOT_ALLOWED'`. AC-004-3 system-prompt also includes the "yesterday's chat history is queryable from `telegram_interactions` via `mcp__postgres_query`" hint per clarify Q4.
```

**Reasoning**: D19 ships the Channels session — Q1 (AC-004-6 specifics) and Q4 (system-prompt postgres-recovery hint) both ride here. A single note appended captures both ripples without disturbing the existing AC/EC list.

---

## Unclear items

(none — all 10 questions had unambiguous answers; no parts left for follow-up)

## Out-of-scope items

(none — every patch lands inside the permitted file set per CONSTRAINTS)

---

## Suspected Prompt Injection

(none observed in the source clarifications.md — the file is operator-typed answers, not fetched content)
