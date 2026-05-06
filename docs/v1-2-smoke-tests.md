# v1.2 smoke tests — operator-attended live verification

These recipes are operator-run AFTER `vercel --prod` deploys the v1.2 build branch and BEFORE the harness Evaluator passes. They are NOT auto-run in CI; they exercise the live Vercel + Postgres + Blob + MT5 + Telegram stack against `.env.local` credentials.

For each section, paste the result line-block into `.harness/features/002-fix-bug-bundle-v1-2/implementation-report.md` § "Live verification" so the Evaluator can cite real evidence.

---

## D1 (FR-026 / KI-008) — Vercel Blob report-archive 502 fix

### AC-026-3 — happy-path upload smoke

```bash
# Run from project root with .env.local sourced through bun (DO NOT `source .env.local`).
bun --env-file=.env.local -e '
  const r = await fetch(`${process.env.AUTH_URL}/api/internal/blob/upload`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.INTERNAL_API_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      filename: `smoke-v1-2-${Date.now()}.html`,
      html: "<p>v1.2 blob smoke OK</p>",
      tenantId: 1,
      pairScheduleId: 0,
    }),
  });
  console.log("status:", r.status);
  console.log("body:", await r.text());
'
```

Expected:
- `status: 200`
- `body: {"url":"https://...vercel-storage.com/executor-reports/1/2026-MM-DD/smoke-v1-2-...html","pathname":"...","size":<n>}`
- The returned URL must `curl -I` to a `200 OK` from Vercel-Blob's CDN.

### EC-026-1 — oversize 413 verification

```bash
bun --env-file=.env.local -e '
  const big = "x".repeat(4_500_001);
  const r = await fetch(`${process.env.AUTH_URL}/api/internal/blob/upload`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.INTERNAL_API_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ filename: "big.html", html: big, tenantId: 1, pairScheduleId: 0 }),
  });
  console.log("status:", r.status);
  console.log("body:", await r.text());
'
```

Expected:
- `status: 413`
- `body` contains `"error":"Payload Too Large"` and a numeric `detail` string showing the actual byte count vs the 4_500_000 limit.

### EC-026-2 — token-rotated 502 surface

ONLY run this test if the operator just deliberately rotated `BLOB_READ_WRITE_TOKEN` server-side and has NOT yet re-pulled into Vercel env. Otherwise this section is theoretical (no need to manufacture the failure).

Expected if reproduced:
- `status: 502`
- `body.upstream_error` = `"Token rejected by Blob backend — re-pull via 'vercel env pull' and redeploy"`

### Recovery checklist after a reported failure

1. Operator confirms `BLOB_READ_WRITE_TOKEN` is set on the active Vercel deployment scope:
   ```bash
   vercel env ls production | grep BLOB_READ_WRITE_TOKEN
   ```
2. If absent or stale, re-pull and redeploy:
   ```bash
   vercel env pull .env.local
   vercel --prod
   ```
3. Re-run AC-026-3 to confirm the 200 path is restored.
4. Append the resolved-at timestamp to `progress/known-issues.md` § KI-008.

---

## D3 (FR-025 / KI-007) — operator-session cookie sweep

### AC-025-2 — operator-cookie reach across the 9 swept routes

After logging in via `/auth/token` (operator-token flow) the cookie is `caishen-operator-session=...`. Verify it now authorises every swept route. Tests run against the production deploy of `harness/build/002-fix-bug-bundle-v1-2`.

```bash
# Capture the cookie out of a fresh /auth/token POST, then hit each swept route.
bun --env-file=.env.local -e '
  const SWEPT = [
    "/api/overview",
    "/api/overrides/close-pair",
    "/api/overrides/close-all",
    "/api/overrides/edit-position",
    "/api/overrides/pause",
    "/api/overrides/resume",
    "/api/overrides/replan",
    "/api/history/archive/2026-05",
    "/api/reports/0",
  ];
  const tokenLogin = await fetch(`${process.env.AUTH_URL}/api/auth/token-login`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({token: process.env.INITIAL_REGISTRATION_TOKEN}),
  });
  const cookie = tokenLogin.headers.get("set-cookie")?.split(";")[0] ?? "";
  console.log("login status:", tokenLogin.status);
  for (const path of SWEPT) {
    const isGet = path === "/api/overview" || path.startsWith("/api/history") || path.startsWith("/api/reports");
    const r = await fetch(`${process.env.AUTH_URL}${path}`, {
      method: isGet ? "GET" : "POST",
      headers: {cookie, "content-type": "application/json"},
      body: isGet ? undefined : JSON.stringify({}),
    });
    // We expect 200/400/422/etc. — anything that ISNT 401 means cookie was accepted.
    console.log(`${path.padEnd(40)} -> ${r.status}`);
  }
'
```

Expected:
- Login `status: 200` and a `set-cookie` containing `caishen-operator-session=...`.
- Every swept-route call returns NOT 401 (200, 400, 403 for CSRF — all acceptable; 401 would mean the cookie sweep failed for that route).

### EC-025-2 — bad-signature fail-fast

```bash
bun --env-file=.env.local -e '
  // Tamper a single byte in the operator-session cookie payload.
  const realLogin = await fetch(`${process.env.AUTH_URL}/api/auth/token-login`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({token: process.env.INITIAL_REGISTRATION_TOKEN}),
  });
  const sc = realLogin.headers.get("set-cookie") ?? "";
  const realCookie = sc.split(";")[0];
  const tampered = realCookie.slice(0, -3) + "AAA";
  const r = await fetch(`${process.env.AUTH_URL}/api/overrides/close-pair`, {
    method: "POST",
    headers: {cookie: tampered, "content-type": "application/json"},
    body: JSON.stringify({pair: "EUR/USD"}),
  });
  console.log("status:", r.status);
  console.log("body:", await r.text());
'
```

Expected:
- `status: 401`
- `body.error` matches `/operator-session signature invalid/`
- A `routine_runs` row exists with `event_type='auth_bad_signature'` (verify via dashboard or direct DB query).

---

## D2 (FR-027 / KI-009) — close-due-sessions extension

### AC-027-3 — Telegram alert wording

After a session-end fires (e.g. `end_time_gmt` of `EUR/USD`'s `EUR` session has just passed), check the operator's Telegram chat for the per-case wording:

| Outcome | Expected wording |
|---|---|
| 1 position closed + 1 pending cancelled | `Session ended for {PAIR}: closed 1 position + cancelled 1 pending` |
| 0 positions, 1 pending | `Session ended for {PAIR}: cancelled 1 pending (no open positions)` |
| 1 position, 0 pending | `Session ended for {PAIR}: closed 1 position (no pending orders)` |
| 0 of either | NO Telegram emitted (idempotent silence) |
| pending filled mid-close | `Session ended for {PAIR}: pending filled mid-close, position closed at {fill_price}` |

### EC-027-4 — race detection

If the operator sees the "pending filled mid-close" wording in Telegram, the audit trail in `routine_runs` should show `closed_due_to_pending_fill_during_close=true` for that tick. This is an audit-replay clarity feature, not an error.

---

## D5 (FR-024 / KI-006) — VPS-NSSM cron-runner

### AC-024-2 — install script idempotency (DryRun)

On the VPS (Windows admin PowerShell), test the new installer in dry-run mode BEFORE running it for real:

```powershell
.\infra\vps\windows\install-cron-runner-service.ps1 `
    -BunPath "C:\Users\Administrator\.bun\bin\bun.exe" `
    -NssmPath "C:\windows\system32\nssm.exe" `
    -RepoRoot "C:\caishen\caishenye" `
    -EnvFile "C:\caishen\cron-runner.env" `
    -DryRun
```

Expected:
- Stdout contains `[DRY-RUN]` markers and the literal command `nssm install caishen-cron-runner`.
- `Get-Service caishen-cron-runner -ErrorAction SilentlyContinue` returns `$null` (no actual service created).

### AC-024-3 — `/api/cron/health` ping verification

After the cron-runner is running on the VPS, verify a recent ping landed in `cron_runner_health`:

```bash
bun --env-file=.env.local -e '
  // SECURITY: this is a GET-by-token-only diagnostic. Never expose.
  const r = await fetch(`${process.env.AUTH_URL}/api/cron/health-status`, {
    method: "GET",
    headers: {authorization: `Bearer ${process.env.CRON_SECRET}`},
  });
  console.log("status:", r.status);
  console.log("body:", await r.text());
'
```

Expected:
- The freshest `cron_runner_health.pinged_at` is within the last 90 seconds.

### AC-024-4 path 2 — Vercel-cron watchdog backstop

If the operator manually shuts down the VPS cron-runner service, within 30 minutes the `/api/cron/runner-watchdog` Vercel cron should emit one Telegram alert:

> Cron-runner ALL DEAD — last ping HH:MM GMT, 30+ min stale.

After re-starting the service, the next runner-watchdog run should NOT emit (the freshness check resets).

---

## D4 (FR-023 / KI-005) — SimpleWebAuthn direct passkey flow

### AC-023-6 — register + authenticate end-to-end

1. Visit `https://caishenv2.vercel.app/auth/passkey-register?token=<INITIAL_REGISTRATION_TOKEN>`.
2. Complete the browser passkey prompt (phone or laptop authenticator).
3. Verify redirect to `/overview` with `caishen-operator-session` cookie set.
4. Sign out (`POST /api/auth/sign-out`).
5. Visit `/auth/login`, complete passkey authentication.
6. Verify redirect to `/overview` with cookie re-minted.
7. Confirm `webauthn_credentials.last_used_at` is updated for the just-used credential (direct DB query).
8. Confirm `webauthn_credentials.counter` value advanced (for HW authenticators that report counter; for some passkey-providers like 1Password / Apple iCloud Keychain the counter remains 0 — that is expected per spec).

### AC-023-5 — emergency-token-banner lifecycle

1. Default first-deploy state: `EMERGENCY_TOKEN_LOGIN_ENABLED=true`. Banner copy on `/overview` is empty (no banner) until the 7-day-passkey condition is met.
2. After both authenticators have logged in successfully within the last 7 days (verify by checking `webauthn_credentials.last_used_at` for two distinct rows), the banner appears with copy:
   > You can now disable emergency token login: `vercel env edit production EMERGENCY_TOKEN_LOGIN_ENABLED false`
3. After running the env-edit + Vercel propagation, visiting `/auth/token` returns 404. Login still works via `/auth/login` (passkeys).
4. Rollback path: `vercel env edit production EMERGENCY_TOKEN_LOGIN_ENABLED true` + propagate; `/auth/token` returns 200 again.

---

## Post-deploy hardening checklist

After all five sections above pass:

- [ ] D1 — Blob upload smoke at AC-026-3 returns 200.
- [ ] D3 — All 9 swept routes accept the operator-session cookie (no 401).
- [ ] D2 — Next session-end fires the new Telegram wording (positive case).
- [ ] D5 — `caishen-cron-runner` NSSM service is `RUNNING`; latest `cron_runner_health.pinged_at` < 90 s old.
- [ ] D4 — Both passkeys (phone + laptop) registered; lifecycle banner appears after 7 days.
- [ ] After 7 days of successful passkey logins, run `vercel env edit production EMERGENCY_TOKEN_LOGIN_ENABLED false` + verify `/auth/token` returns 404.

When this checklist is fully checked off, append a one-line entry to `.harness/progress/changelog.md` as the v1.2 production-validation milestone.
