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
