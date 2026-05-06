# Known Issues

Minor findings that are acknowledged but not yet fixed. Added by `/harness:retrospective` for negative-drift findings that don't block a PASS but should be tracked.

## KI-001 — `install-restart-on-idle-task.ps1` PowerShell parser bug (nested here-strings)
**Added**: 2026-05-06
**Feature**: 001-foundation-routines-channels-dashboard
**Severity**: Minor
**Category**: Code Quality

### Description
The Windows install script for the ADR-009 restart-on-idle scheduled task uses a nested `@"..."@` here-string construction (a here-string inside a here-string) to embed the runner-script body. PowerShell 5.1 (the deployment target on the operator's Windows VPS) does not support this nesting — the parser sees the inner `"@` terminator at column 0 and incorrectly closes the outer here-string, throwing `Missing argument in parameter list` on the subsequent prose.

### Where
`infra/vps/windows/install-restart-on-idle-task.ps1` lines 66 (outer `@"`) and 99 (inner `"@`)

### Why deferred
Channels session works correctly without the restart-on-idle task. NSSM `Restart=always` covers crash recovery (5s delay). The restart-on-idle scheduled task is preventive maintenance against long-session token-budget drift / hung sessions — a scenario that has NEVER actually occurred in this project. ADR-009's pattern is belt-and-suspenders defense; the v1.1 close prioritized shipping over enabling it.

### Resolution plan
v1.2: refactor the script to either (a) embed the runner script via single-here-string + `Replace` to substitute placeholders, OR (b) write the runner-script as a separate `.ps1` file rather than embedding. Pre-deploy parse-check via `[Parser]::ParseFile()` should be added to all PS1 scripts in `infra/vps/windows/` to catch future regressions before VPS deploy.

---

## KI-002 — Evaluator EVALUATE pass deferred (live-behavior verification used instead)
**Added**: 2026-05-06
**Feature**: 001-foundation-routines-channels-dashboard
**Severity**: Minor
**Category**: Test Coverage

### Description
The harness's normal sprint flow runs `/harness:sprint`'s Evaluator EVALUATE pass after Generator BUILD completes. v1 + v1.1 was a multi-session build where corrective fixes (sessions 5h-5i) addressed gaps that surfaced from live wire-up — gaps the spec's static review couldn't catch. Rather than running the formal Evaluator pass against artifacts that were partially out-of-date during build, live-behavior verification was used as the de-facto pass signal:
- Planner end-to-end fire 2026-05-04 returned a black-swan no-trade decision (session 5h MILESTONE)
- Cron tick `/api/cron/fire-due-executors` GH Actions run `25379691712` succeeded
- MT5 funnel returned real `{balance:122.11, equity:122.11, leverage:200}` and OHLC candles
- TwelveData indicators returned canonical ATR/RSI/Stoch
- FFCal returned 13 real ForexFactory events
- Channels session Telegram bot replied to `/status` within seconds

No formal `eval-report.md` exists for this feature.

### Where
`.harness/features/001-foundation-routines-channels-dashboard/eval-report.md` — file absent

### Why deferred
The corrective-fix sessions invalidated the original contract's static check premise. Running EVALUATE retroactively against a moving spec target would have produced noise. Live-behavior verification provided real-world pass evidence at every layer.

### Resolution plan
v1.2: when the spec is stable for a coherent slice of work (e.g., a v1.2 feature or a multi-fix release), run the formal Evaluator EVALUATE pass to establish regression-discipline baseline.

---

## KI-003 — MT5_BEARER_TOKEN exposed via VS Code selection-paste pattern
**Added**: 2026-05-06
**Feature**: 001-foundation-routines-channels-dashboard
**Severity**: Minor
**Category**: Security (operator process)

### Description
Across session 5i, the operator's VS Code selection-pastes (line 38 of `.env.local`) caused `MT5_BEARER_TOKEN` to appear in chat ~3 times. Each paste was unintentional — VS Code's "select-then-message" pattern auto-includes the selection as context.

### Where
Operator's local `.env.local` line 38 + Vercel prod env + VPS auth-proxy env (3 sync points)

### Why deferred
Operator explicitly stated "no need to rotate" 2026-05-05. Risk profile is low: token only authorizes MT5 reads/writes against a demo contest account ($122.11 balance, scoped permissions matching what the operator already controls).

### Resolution plan
Operator-paced. If/when rotation is desired:
1. `openssl rand -hex 32` generate new
2. Update `.env.local` line 38
3. Vercel: `vercel env rm MT5_BEARER_TOKEN production -y` then `bun --env-file=".env.local" -e "process.stdout.write(process.env.MT5_BEARER_TOKEN||'')" | vercel env add MT5_BEARER_TOKEN production`
4. VPS: update `caishen-mt5-proxy` NSSM service env (PROXY_BEARER); restart service
5. `vercel --prod --yes` to redeploy

---

## KI-007 — 8 dashboard routes still return 401 with operator-session cookie
**Added**: 2026-05-06
**Feature**: 001-foundation-routines-channels-dashboard
**Severity**: Major (blocks dashboard `/overrides` actions, `/history` archive view, `/reports` artefact downloads)
**Category**: Code Quality (auth-cookie sweep gap)

### Description
v1.1.1 commit `e960305` added operator-session cookie support to `/api/overview` only. The other 8 auth-using API routes still call `resolveOperatorFromSession` which expects an Auth.js cookie. Operators logged in via the v1.1 token-flow get 401 on:

- `/api/overrides/close-pair` (POST)
- `/api/overrides/close-all` (POST)
- `/api/overrides/edit-position` (POST)
- `/api/overrides/pause` (POST)
- `/api/overrides/resume` (POST)
- `/api/overrides/replan` (POST)
- `/api/history/archive/[month]` (GET)
- `/api/reports/[id]` (GET)

Plus the dashboard `/schedule`, `/history`, `/pair/[pair]` server-side data-fetch routes if they exist (they may currently render via client-side SWR pulling `/api/overview`-shaped routes).

### Where
- `packages/dashboard/lib/override-bind.ts` `resolveOperatorFromSession` — only reads Auth.js cookies
- All 8 routes listed above invoke `resolveOperatorFromSession` directly + override routes also wrap in `executeOverride` lib

### Why deferred
- Mixed CSRF middleware on /overrides routes makes the sweep nontrivial — each route needs both auth + CSRF flow updated together
- v1.1.1 ship priority was the executor missed-fire fix (KI-006); dashboard read-only viewing already works
- The trading core operates entirely without these routes; operator-side overrides can be done via direct Postgres or Telegram bot in the meantime

### Resolution plan
v1.2 sweep: extract a shared `resolveOperatorAuth(req)` helper that tries operator-session cookie first, then Auth.js cookie, then INTERNAL_API_TOKEN bearer (for cron/internal callers). Replace all 9 callsites including overview. ~30 LOC + 4 hours of CSRF integration testing on overrides.

### Operator workaround until v1.2
- Dashboard `/overview` works (read-only mission-control snapshot)
- Override actions: ask Telegram bot ("close all positions on EUR/USD", "pause trading until tomorrow") — bot has DB + MT5 access via subagent tools
- History/reports browsing: query Postgres directly via `bun --env-file=".env.local"` or Vercel Postgres web console

---

## KI-008 — Vercel Blob upload returns 502 (private store)
**Added**: 2026-05-06
**Feature**: 001-foundation-routines-channels-dashboard
**Severity**: Minor (post-trade artifact only; trade execution unaffected)
**Category**: Code Quality (third-party config)

### Description
First live executor fires 2026-05-06 09:23-09:28 GMT placed real trades successfully (orders #277132741, #277132850, #277134012) but Telegram digests reported `BlobReport: degraded(502)` and `blob upload 502 — report pending retry` for all three. The executor's HTML reasoning-report archive is failing on the Vercel Blob upload step.

The trade itself + audit row + Telegram digest all succeed; only the report-archive write to Vercel Blob is breaking. Per FR-015 architecture, the report URL is meant to be reviewable from `/history` and `/reports/[id]` — without the blob upload, those routes will show null `report_md_blob_url` for these trades.

### Where
- `packages/dashboard/app/api/internal/blob/upload/route.ts` (the Vercel proxy that the executor calls)
- Vercel Blob store binding in the project (likely `caishen-v2-blob` per session 5h migration)

### Why this surfaced now
First live executor fires were 2026-05-06 09:23+. Pre-v1.1.1 the executor was never actually firing real trades, so the blob upload code path was never exercised end-to-end with real session-id-named files.

### Resolution plan
Likely root causes (order of investigation):
1. Vercel Blob token (`BLOB_READ_WRITE_TOKEN`) may not be in production env or is wrong scope
2. The Blob store may have been disconnected during the session 5h Vercel scope migration
3. The upload payload may be too large (Vercel free-tier Blob has size limits)

Diagnose with: `vercel logs` filtered to `/api/internal/blob/upload` requests around 09:23-09:28 UTC. The route's `mapUpstreamError` will log the actual reason.

### Operator workaround until v1.2
Trade-decision audit data is preserved in `routine_runs` (with the Anthropic session_id + URL) and `executor_reports.summary_md` (the one-paragraph fallback). Full HTML reasoning replay requires opening the Anthropic session URL directly.

---

## KI-006 — GitHub Actions cron throttles `* * * * *` to multi-hour gaps under load
**Added**: 2026-05-06
**Feature**: 001-foundation-routines-channels-dashboard
**Severity**: Major (causes missed executor fires; 5-min lookback misses windows)
**Category**: Infra (third-party constraint)

### Description
The v1.1 cron design assumed GH Actions `* * * * *` schedules fire reliably every minute. Live observation 2026-05-06: the `cron-fire-due-executors` workflow ran 5 times in 23 hours (23:11, 00:05, 04:00, 06:39, 09:08 UTC) — gaps of 30 min to 4+ hours. Free-tier GH Actions cron is documented as best-effort with significant throttling under platform load.

Real-world impact: London 08:00 GMT executor fires were MISSED entirely because no cron tick happened between 06:39 and 09:08 UTC, and the (then-)5-minute lookback window in `select_pair_schedules_due_for_fire` rejected the 1+ hour-old rows.

### Where
- `.github/workflows/cron-fire-due-executors.yml` schedule `* * * * *`
- `.github/workflows/cron-close-due-sessions.yml` schedule `* * * * *`
- `packages/dashboard/lib/internal-postgres-queries.ts` `select_pair_schedules_due_for_fire` lookbackMinutes default (was 5; bumped to 60 in commit `8d257ee`)
- `packages/dashboard/app/api/cron/fire-due-executors/route.ts` lookbackMinutes default (60 + query-param override)

### v1.1.1 partial mitigation (commit `8d257ee`)
- Default lookback bumped 5 → 60 min — recovers from typical GH Actions throttling
- New `?lookbackMinutes=N` query param (max 1440) — operator can manually trigger recovery curl with extended lookback when a >60-min gap occurs

### v1.2 resolution paths (operator's choice)
1. **Multi-schedule belt-and-suspenders** — add `*/5 * * * *` and `*/15 * * * *` schedules alongside `* * * * *` so even under heavy throttling, every 15-min ticks still fire. cron-synthetic-ping pattern.
2. **Vercel cron paid tier** — Vercel Pro plan supports sub-daily cron with much tighter SLA (~30s jitter). ~$20/mo. Move all 3 caishen crons to Vercel.
3. **External scheduler** — cron-job.org (free, reliable) or AWS EventBridge or Cloudflare Workers cron-trigger. ~5 min setup, free tier sufficient.
4. **Self-hosted cron on the operator's VPS** — already running NSSM services; add a windows scheduled task that curls the Vercel handler every minute. Same reliability as Channels session.

Recommended: option 4 (operator-VPS cron). Same trust boundary as the existing NSSM services; no new infra; deterministic per-minute.

### Operator workaround until v1.2
If executor fires are missed, run this from your laptop:
```bash
bun --env-file=".env.local" -e "
const r = await fetch('https://caishenv2.vercel.app/api/cron/fire-due-executors?lookbackMinutes=240', {
  headers: { Authorization: 'Bearer ' + process.env.CRON_SECRET }
});
console.log(await r.text());
"
```
Same pattern works for `/api/cron/close-due-sessions` (session-end recovery).

---

## KI-005 — Auth.js v5 WebAuthn passkey registration not working
**Added**: 2026-05-06
**Feature**: 001-foundation-routines-channels-dashboard
**Severity**: Major (blocks dashboard access)
**Category**: Code Quality (third-party beta lib integration)

### Description
The dashboard's `/auth/passkey-register` page renders correctly but the actual passkey registration flow fails with `error=Configuration` returned by Auth.js v5's internal error page (which itself returns 500). Multiple v1.1 fix attempts:
1. Built the missing `PasskeyRegisterForm` client component (it was a placeholder comment in v1)
2. Fixed middleware to make `/auth/passkey-register` public
3. Added email field for the Auth.js Passkey provider's user-identifier requirement
4. Fixed the form to use `useId()` for label binding

After all fixes, `next-auth/webauthn`'s `signIn('passkey', {action:'register', email, redirectTo})` triggers a `GET /api/auth/error?error=Configuration → 500`. Auth.js's own error page handler is failing.

### Where
- `packages/dashboard/app/auth/passkey-register/page.tsx` (server)
- `packages/dashboard/app/auth/passkey-register/PasskeyRegisterForm.tsx` (client; new in v1.1 attempt)
- `packages/dashboard/app/api/auth/[...nextauth]/route.ts` (Auth.js handler)
- `packages/dashboard/lib/auth.ts` (Auth.js config)
- Drizzle schema `packages/db/src/schema/users.ts` (users + accounts + sessions + verification_tokens + authenticators)

### Why deferred
- Auth.js v5 + WebAuthn is **in beta**. The library is moving fast and each fix surfaces another runtime path issue.
- Dashboard is a quality-of-life surface, NOT load-bearing for the trading core. Operator has multiple working alternatives:
  1. Telegram bot free-text Q&A (proven working — bot replied to env-var diagnostic)
  2. Anthropic session URLs (live reasoning trace)
  3. Direct Postgres query via `bun --env-file=.env.local`
  4. Vercel Postgres web console
- The trading core (planner + cron + executor) operates entirely independently of dashboard auth.

### Resolution plan
Three options for v1.2 (operator's choice):

1. **Stick with Auth.js v5 stable Passkey** — wait for v5 stable release; the beta is targeted for stabilization 2026-Q3 per Auth.js roadmap.
2. **Switch to SimpleWebAuthn directly** — bypass next-auth/webauthn; build registration/auth as bare WebAuthn flows + custom session cookie. ~200 LOC; full control.
3. **Switch auth provider** — Clerk / Supabase Auth / Lucia (simpler v5-stable WebAuthn). One-day port.

Most likely path: option 2 (SimpleWebAuthn direct) since dependencies are already installed (`@simplewebauthn/server` 9, `@simplewebauthn/browser` 9.0.1).

### Operator workaround until v1.2
Until the dashboard auth is fixed, operate via:
- Telegram bot (full read-only DB access; chat with the bot for any data)
- Anthropic session URLs printed in `routine_runs.session_url` column (visible via Telegram or direct query)
- Vercel Postgres web console for ad-hoc data exploration

The dashboard's value-add over these is ONLY: live-updating UI, organized per-pair detail pages, and override action buttons (close-pair / pause / replan). All three are recoverable via direct API calls + Telegram with `--dangerously-skip-permissions` enabled (which we already deployed in this session).

---

## KI-004 — Spike 3 R1 deployed-prompt READ endpoint never resolved
**Added**: 2026-05-06
**Feature**: 001-foundation-routines-channels-dashboard
**Severity**: Minor
**Category**: Test Coverage

### Description
FR-001 AC-001-3 (Spike 3 R1) was supposed to probe whether Anthropic exposes a GET endpoint for the routine's deployed system prompt. If discovered, Tier 2 prompt-preserve test would compare deployed prompt vs `.harness/spec/preserve/*.md` byte-for-byte. Spike 3 ran 2 of 10 stability fires and the endpoint probe was orphaned. `.harness/data/spike-fr-001-outcomes.json` has `deployed_prompt_endpoint: null`, so Tier 2 SKIPS in CI.

### Where
`.harness/data/spike-fr-001-outcomes.json` field `deployed_prompt_endpoint`; `packages/routines/tests/prompt-preserve.test.ts` Tier 2 conditional

### Why deferred
Tier 1 (source-vs-mirror byte equality) IS running and provides 95% of the value. Tier 2 catches operator-side drift if someone hand-edits a deployed prompt in the Anthropic Routines UI without updating the source-of-truth file — a possible-but-rare scenario.

### Resolution plan
v1.2: complete Spike 3 by probing both candidate endpoint shapes (`GET /v1/routines/{id}` body fields + `GET /v1/routines/{id}/system_prompt`). If 200, persist endpoint shape in the outcomes JSON; Tier 2 picks it up automatically.

---

<!--
Template for each entry:

## KI-NNN — [Issue Title]
**Added**: YYYY-MM-DD
**Feature**: NNN-feature-name
**Severity**: Minor | Major
**Category**: Code Quality | Test Coverage | UX | Performance

### Description
[What's the issue?]

### Where
[file:line or UI element + URL]

### Why deferred
[Why wasn't it fixed? Out of scope? Low impact?]

### Resolution plan
[When and how this should be addressed — or "won't fix" with reason]
-->
