# Retrospective — features/001-foundation-routines-channels-dashboard

**Date**: 2026-05-06
**Eval result**: PASS-by-live-behavior (formal Evaluator EVALUATE pass not run; live end-to-end behavior verified across all critical paths instead — see § Eval-substitute below)
**Spec adherence (0-10)**: 8

## Eval-substitute

The contract was negotiated 2026-05-03 and the v1 build shipped over sessions 5a-5g. v1.1 corrective work (sessions 5h-5i) addressed gaps that surfaced from live wire-up — gaps the spec's static review couldn't catch (e.g., Anthropic having no programmatic /schedule API; Caddy intercepting MT5 traffic; UTF-8 em-dashes breaking PowerShell 5.1 parsers; nested here-strings unsupported). Rather than retroactively running Evaluator EVALUATE against artifacts that were partially out of date during build, the operator + orchestrator chose live-behavior verification as the proof:

- **Planner** end-to-end fire 2026-05-04 returned a black-swan no-trade decision protecting capital from Iran/Hormuz crisis (session 5h MILESTONE — see implementation-report.md)
- **Cron tick** `/api/cron/fire-due-executors` GH Actions run `25379691712` succeeded with `dueCount=0` (correct fast path)
- **MT5 funnel** returned real `{balance:122.11, equity:122.11, leverage:200}` and real OHLC candles for XAU/USD H4
- **TwelveData** indicators returned canonical ATR ($23.57 for XAUUSD H4), RSI, Stoch
- **FFCal** returned 13 real ForexFactory events (ECB Lagarde, ISM Services PMI, JOLTS)
- **Channels session** Telegram bot replied to `/status` within seconds (proves VPS NSSM service + claude CLI as LocalSystem + bidirectional Telegram I/O)

This is "ship-and-watch-it-work" reality, not Evaluator-script verification. Sufficient for v1.1 close. A formal Evaluator pass can be added in v1.2 if/when a regression discipline is wanted.

## Drift Findings

### Positive drift (candidates for spec capture)

- **`/api/internal/ffcal/today` resurrection** — contract (and session-5g architectural correction) had this route deprecated to 501; v1.1 #3 brought it back as a JSON proxy fetching the public ForexFactory feed. Better than the originally-contracted FFCal-MCP-via-custom-connector path because Anthropic's UI requires OAuth which the FFCal MCP doesn't have. → spec already updated via the v1.1 cascade-edit ADR-013.
- **Vercel-mediated TwelveData indicators route** — contract didn't include this; v1 went live without indicator support, the verbatim SPARTAN prompt mandates it. v1.1 Phase A added `/api/internal/indicators` with 27 tests + helper module. → should be folded into spec; currently only documented in changelog/impl-report.
- **Phase B + C MT5 toolset** — contract said "market orders only"; v1.1 Phase B/C added position management (close-by-id, modify SL/TP, close-all-by-symbol) + pending orders (place limit/stop, cancel-by-id, cancel-by-symbol) for verbatim SPARTAN parity. 7 new internal-API routes; 75 new tests. → should be in spec.
- **Cron-fired executor pattern** — contract said "Planner programmatically schedules executors"; reality is Planner persists rows + every-minute cron tick fires via /fire. Already captured in spec via v1.1 cascade-edit ADR-013 (33 patches across 4 files).
- **Two new helper modules** in `packages/routines/src/` (calendar.ts + indicators.ts) — not in original directory tree. → spec needs the directory tree updated.
- **Caddy bypass on VPS** — contract assumed Bun auth-proxy directly behind Tailscale Funnel; reality had Caddy in the path. v1.1 #2 disabled Caddy and restored the architectural intent. Not a spec issue (architecture was right; deployment had drifted).

### Negative drift (debt or tightening)

- **Formal Evaluator EVALUATE pass never run** — contract Definition of Done implies an Evaluator score before merge. Skipped due to multi-session structure (v1 + v1.1 corrective fixes). Resolution: **flag-as-debt** — eval-report.md absent. Not blocking trading but the harness wants this for regression discipline. Add to `progress/known-issues.md`.
- **`install-restart-on-idle-task.ps1` non-functional** — ADR-009 specifies periodic restart-during-idle for the Channels session; the install script has a PowerShell parser bug (nested `@"..."@` here-strings unsupported). Channels session works WITHOUT it (NSSM Restart=always covers crash recovery), but ADR-009's preventive-restart pattern is missing. Resolution: **flag-as-debt** in known-issues.md; defer fix to v1.2.
- **MT5_BEARER_TOKEN exposed via VS Code selection-paste pattern** ~3 times this session. Resolution: documented in known-issues.md; rotation queued (operator-paced).
- **Tier 2 deployed-prompt READ test** (Spike 3 R1) — never definitively probed; deployed_prompt_endpoint stays null. Resolution: **accept-as-deferred** — Spike 3 stability did 2 of 10 fires; the endpoint probe is decoupled and can run later.

### Neutral drift (update architecture to reflect reality)

- **Origin/main + build branch have unrelated histories** — origin/main was scaffolded with LICENSE + README only; v1 + v1.1 lives on `harness/build/001-foundation-routines-channels-dashboard`; cron workflow was cherry-picked to main as `2b580e5`. Not in any spec. Resolution: **document in architecture.md** the deployment topology (Vercel deploys from build branch directly via `vercel --prod`; main only carries the cron workflow file for GH Actions to find).
- **NSSM service trio on VPS** (caishen-channels, caishen-mt5-proxy, caishen-ffcal-proxy) — architecture mentions them but `infra/vps/windows/README.md` is the operational source of truth. Not a spec drift; just confirming reality matches.
- **GH Actions cron stack** (3 workflows: synthetic-ping, channels-health, fire-due-executors) — contract said "Vercel cron"; reality is GH Actions for sub-daily ones (Vercel Hobby plan blocks sub-daily). Already captured in AC-005-2 amendment + ADR-013.

## Proposed Spec Updates

| # | File | Section | Change type | Summary |
|---|---|---|---|---|
| 1 | spec/architecture.md | Stack table | tighten | Add row for `/api/internal/indicators` (TwelveData proxy) under data-fetch routes |
| 2 | spec/prd.md | new FR | capture | Add FR-022 "Per-pair MT5 toolset parity (verbatim SPARTAN scope)" listing the 6 new routes (positions/[id] DELETE+PATCH, positions/by-symbol/[symbol] DELETE, orders/pending POST, orders/pending/[id] DELETE, orders/pending/by-symbol/[symbol] DELETE) — provides traceability for v1.1's Phase B + C additions |
| 3 | spec/architecture.md | new ADR-014 | capture | Document the Vercel-deploys-from-build-branch + main-only-has-cron-workflow topology so post-merge confusion doesn't recur |
| 4 | features/001/contract.md | Directory tree | tighten | Add `packages/routines/src/calendar.ts` and `packages/routines/src/indicators.ts` to the routines tree section |
| 5 | progress/known-issues.md | new entries | flag-as-debt | (a) install-restart-on-idle-task.ps1 nested-here-string bug — defer v1.2; (b) Evaluator EVALUATE pass deferred to v1.2 regression discipline; (c) MT5_BEARER_TOKEN rotation pending; (d) deployed_prompt_endpoint probe never resolved |

## Known-issues / Debt

- `progress/known-issues.md` entries (5 new lines per item #5 above)
- ROADMAP.md "Considered (Deferred)" section: add a line for v1.2 work (Evaluator regression discipline + restart-on-idle fix + per-tenant onboarding)
- `install-restart-on-idle-task.ps1` PowerShell-nested-here-string bug — concrete fix for v1.2: refactor to write the runner script via single-here-string-with-Replace, OR write a separate `.ps1` runner file rather than embedding it as a here-string

## Spec adherence score: 8/10

**What kept it from 9-10**:
- Evaluator EVALUATE pass never formally run (–1)
- Multiple in-build spec-vs-reality divergences (Anthropic /schedule API absence; Caddy intercepting; em-dash codepage trap) that the spec couldn't have predicted but had to be amended via /harness:edit (–1)

**What kept it from 5-6**:
- Every divergence was named, classified, and either resolved-in-spec or flagged-as-debt (didn't bury anything as "neutral")
- Cascade-edit ADR-013 was a clean spec-reconciling pivot, not orchestrator chatter
- Live behavior verified at every layer — not theoretical PASS

The build is structurally better than the spec because reality forced corrections the spec couldn't anticipate. That's the point of the retrospective discipline: capture those into the spec so v2 starts from truth.
