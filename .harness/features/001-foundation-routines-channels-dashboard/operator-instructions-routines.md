# Operator Instructions — Anthropic Routines (Path B / Vercel-Proxy Pattern)

**Status**: SUPERSEDES the prior version of this file (which was based on the now-invalidated assumption that Routines run arbitrary TS scripts with full env-var access). The current architecture uses **Path B** (Vercel proxy gateway) per ADR-012 — see `.harness/progress/decisions.md`.

**Last revised**: session 5g — added Step 0.5 (DB migration), Step 3.5 (FFCal MCP connector), Step 4.5 (OPERATOR_CHAT_ID optional override), and "Known issues to revisit" section after live wire-up surfaced six concrete upstream-integration gaps.

**What changed**: Routines do NOT clone the GitHub repo or run `bun run packages/routines/src/*.ts`. They run Claude with a system prompt + Bash, and Claude uses Bash+curl to call internal API routes on the Vercel-deployed dashboard. All real secrets (DATABASE_URL, MT5_BEARER_TOKEN, etc.) live in Vercel env. Each Routine's Cloud Env holds only `INTERNAL_API_TOKEN` + `VERCEL_BASE_URL` + `DEFAULT_TENANT_ID`.

**Pre-requisite**: build branch `harness/build/001-foundation-routines-channels-dashboard` is deployed to `caishen-v2.vercel.app` (live as of session 5d). Internal API routes are deployed and tested in session 5e (this session). Session 5g corrected six upstream-integration bugs that surfaced during live wire-up.

---

## STEP 0a — Run DB migrations + V1 seed against live Vercel Postgres (one-time, session 5g)

The session-5e Generator built the `pair_configs` schema + V1 7-pair seed but never applied them to the live Vercel-managed Postgres. Result: `select_active_pairs` returned 500 ("relation pair_configs does not exist"). Session 5g fixed this by running the canonical Drizzle migrate + seed scripts.

If your DB is already migrated (e.g., session 5g's run was successful), skip to Step 0. To verify status:

```bash
DATABASE_URL=$(grep '^DATABASE_URL' .env.local | cut -d= -f2-) bun --eval "
import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const r = await sql\`SELECT COUNT(*) AS n FROM pair_configs WHERE tenant_id = 1\`;
console.log('pair_configs rows for tenant 1:', r[0].n);
await sql.end({ timeout: 1 });
"
# Expect: 7
```

If it shows 0 (or errors with "relation does not exist"), run the migrations + seed:

```bash
# 1. Apply schema migrations (idempotent — safe to re-run):
cd packages/db
DATABASE_URL=$(grep '^DATABASE_URL' ../../.env.local | cut -d= -f2-) bun run migrate
# Expect: "migrate: OK"

# 2. Seed V1 pair list + tenant + agent_state row (idempotent — uses ON CONFLICT DO NOTHING):
DATABASE_URL=$(grep '^DATABASE_URL' ../../.env.local | cut -d= -f2-) bun run seed
# Expect: "seed: V1 pair list + tenant + agent_state OK"

cd ../..
```

Verify by re-running the count query above; should now show 7.

(After first-time run, this step is permanent until the schema changes — a future feature might add an `alter` migration, but the v1 schema in `0000_init.sql` is stable.)

---

## STEP 0 — Generate the INTERNAL_API_TOKEN (operator does this LOCALLY)

This is the single new secret you must provision. It's the only thing the Routine sees; everything downstream of the proxy stays in Vercel env.

```bash
# Run on YOUR LOCAL MACHINE (NOT in chat):
openssl rand -hex 32
```

That produces a 64-character hex string. **Do NOT paste the value into chat.** Copy it directly to your clipboard.

Add it to `.env.local` (which is gitignored — never committed):

```bash
# Append to .env.local — paste the value yourself, replacing <value>:
echo "INTERNAL_API_TOKEN=<value>" >> .env.local
```

(Or open `.env.local` in your editor and paste the line — whichever feels safer.)

---

## STEP 1 — Sync to Vercel project env

Run the existing sync script (one-shot pipe, no echo):

```bash
cd .worktrees/current
bash scripts/sync-env-to-vercel.sh --force
```

This pulls `INTERNAL_API_TOKEN` (and all other env vars) from `.env.local` into the Vercel project's `production` env, without printing values to stdout.

Verify (the value won't print, only the var name list):

```bash
npx vercel env ls production --scope=belcort | grep -i internal_api
```

You should see `INTERNAL_API_TOKEN  Encrypted  Production  …`.

---

## STEP 2 — Re-deploy production

The new env var only takes effect in NEW deploys, not the running one:

```bash
cd .worktrees/current
npx vercel deploy --prod --yes --scope=belcort
```

Capture the new production URL (printed at the end of the deploy). Should be `https://caishen-v2-<hash>-belcort.vercel.app`.

Smoke test the internal-auth gate:

```bash
# Without bearer → expect 401:
curl -sS -o /dev/null -w "%{http_code}\n" \
  https://caishen-v2-<hash>-belcort.vercel.app/api/internal/mt5/account

# With wrong bearer → expect 401:
curl -sS -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer wrong" \
  https://caishen-v2-<hash>-belcort.vercel.app/api/internal/mt5/account

# With correct bearer (paste from .env.local; this happens in shell, not chat):
INTERNAL_API_TOKEN=$(grep ^INTERNAL_API_TOKEN= .env.local | cut -d= -f2)
curl -sS -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $INTERNAL_API_TOKEN" \
  https://caishen-v2-<hash>-belcort.vercel.app/api/internal/mt5/account
# → 200 (with real account JSON if Tailscale Funnel is up; 502 if MT5 upstream is down)
```

---

## STEP 3 — Configure each Routine's Cloud Env (3 routines: planner, executor, spike-noop)

For each of `财神爷-planner`, `财神爷-executor`, `财神爷-spike-noop` in `https://claude.ai/code/routines`:

1. Open the Routine.
2. Go to "Cloud Env" → "Environment variables" section.
3. Add three vars (paste values from `.env.local` and the deploy URL — never echo to chat):
   - `INTERNAL_API_TOKEN` = the value you generated in Step 0.
   - `VERCEL_BASE_URL` = `https://caishen-v2-<hash>-belcort.vercel.app` (the URL from Step 2).
   - `DEFAULT_TENANT_ID` = `1`.

That's the **entire** env vars section. Do NOT add `DATABASE_URL`, `MT5_BEARER_TOKEN`, `FFCAL_BEARER_TOKEN`, `TELEGRAM_BOT_TOKEN`, etc. — those stay only in Vercel env. The Routine never sees them; defence in depth.

---

## STEP 3.5 — Attach the ForexFactory MCP connector to the Planner Routine (session 5g, REQUIRED)

In the n8n workflow, ForexFactory was an MCP server (Claude reached it via MCP protocol over stdio/SSE), NOT a plain HTTP service. The session-5e attempt to wrap it as `/api/internal/ffcal/today` failed in live wire-up because no such upstream HTTP endpoint exists. **Path X chosen** (see `routines-architecture.md` § 7): the Planner reaches FFCal via an MCP connector attached to the routine itself.

For the **`财神爷-planner`** Routine ONLY (the Executor doesn't need FFCal in v1 — its prompt step 4 reads candles, not calendar):

1. Open the Routine in `claude.ai/code/routines`.
2. Find the "Connectors" or "Tools" section in the Routine config (the exact UI label depends on the current Anthropic Routines UX revision; look for a list of MCP tools).
3. Add a new MCP connector. Use the same FFCal MCP URL + bearer you used in the n8n workflow. The connector is typically configured with:
   - A remote URL (e.g. `https://your-ffcal-mcp-host/sse` or whatever your provider gave you).
   - A bearer token from the FFCal vendor.
4. Once attached, Claude inside the routine will see tools whose names look like `mcp__<connector_name>__<tool>` (e.g., `mcp__forexfactory__getEvents`). The exact tool name depends on what the MCP server exposes — verify by looking at the available-tools list during a test fire.

The Planner's system-prompt appendix (step 2 of the work loop) instructs Claude to call those MCP tools instead of the deprecated `/api/internal/ffcal/today` curl. If you skip this step, the Planner will fall through to the conservative-defaults path (London 08:00–12:00 GMT, NY 13:30–17:00 GMT) and send a Telegram warning. Plans will still be generated, but without the calendar-aware refinement.

The legacy proxy route `${VERCEL_BASE_URL}/api/internal/ffcal/today` returns `501 Not Implemented` with a pointer back to this section if anything still tries to call it.

---

## STEP 4 — Paste the proxy-aware system prompts into each Routine's Instructions

For each Routine, go to the "Instructions" field and paste the contents of the corresponding file:

| Routine | System-prompt file to paste |
|---|---|
| `财神爷-planner` | `.harness/spec/preserve/planner-systemprompt-vercel-proxy.md` (whole file content) |
| `财神爷-executor` | `.harness/spec/preserve/spartan-systemprompt-vercel-proxy.md` (whole file content) |
| `财神爷-spike-noop` | (No change — keep your existing minimal "echo a sentinel + exit" prompt for spike testing.) |

The proxy overlay files contain the verbatim original prompt (constitution §2 preserved byte-identical) plus a "Tools available" appendix that documents:
- The `${VERCEL_BASE_URL}` URL pattern.
- The `Authorization: Bearer ${INTERNAL_API_TOKEN}` shape.
- The numbered call flow with the **session 5g revisions**:
  - **Planner** (11 steps): insert_routine_run (audit self-insert) → FFCal MCP → news/last-24h → select_active_pairs → reason → insert_pair_schedules → schedule executors → persist binding → telegram → update_routine_run.
  - **Executor** (11 steps): insert_routine_run → stale-check → MT5 account → MT5 positions → MT5 candles (multi-TF) → MSCP reason → MT5 orders → blob upload → executor_reports insert → telegram → update_routine_run.

**If you previously pasted a pre-5g version** of these files, Claude has stale instructions (will still try to call /api/internal/ffcal/today, won't self-insert routine_runs, will reject calls without explicit chat_id). Replace with the current `-vercel-proxy` overlay version now.

---

## STEP 4.5 — OPERATOR_CHAT_ID env override (OPTIONAL, session 5g)

The `/api/internal/telegram/send` route now treats `chat_id` as OPTIONAL. When the Routine omits it, the route resolves the target chat in this order:
1. `OPERATOR_CHAT_ID` env on Vercel (if set + numeric + present in `tenants.allowed_telegram_user_ids`).
2. `tenants.allowed_telegram_user_ids[0]` — the first allowlisted user.
3. 503 if both fail.

**You only need to set `OPERATOR_CHAT_ID`** if your tenant's allowlist contains MULTIPLE users AND you want one specific user to receive the digest by default. With one user in the allowlist (the typical v1 case), the fallback to allowlist[0] picks them naturally.

If you do want it set:
```bash
# Append to .env.local — paste your numeric Telegram user ID:
echo "OPERATOR_CHAT_ID=<your_user_id>" >> .env.local
bash scripts/sync-env-to-vercel.sh --force
npx vercel deploy --prod --yes --scope=belcort
```

The Routines themselves do NOT need this env var. It's a Vercel-side override only.

---

## STEP 5 — Repository attachment is now OPTIONAL (NOT load-bearing)

Under Path B, **the Routine does not clone or run code from the GitHub repo.** Claude doesn't `bun run` anything. All it does is reason + Bash+curl to the Vercel proxy.

You may still attach the repo for log/audit visibility (Anthropic's Routine UI shows the linked repo in run summaries), but the Routine will execute correctly with NO repo attached. If you previously attached `mosaladtaooo/caishenye` per the OLD instructions, you can leave it attached — it does no harm.

**Setup script field**: leave EMPTY. There's nothing to install (no Bun, no `bun install`).

**Run command field**: leave EMPTY. The Routine just runs Claude.

If the UI requires non-empty values: setup script `echo ok` and run command `echo ok` are fine no-ops.

---

## STEP 6 — Verify each Routine end-to-end

For each Routine:

1. Click "Test fire" (or call `POST /v1/routines/<id>/fire` with proper bearer).
2. Watch the run log. Expect:
   - Claude reads its system prompt.
   - Claude executes Bash+curl calls to `${VERCEL_BASE_URL}/api/internal/...`.
   - Each curl returns 200 (or 502 on a transient upstream failure).
   - Final action: `update_routine_run` settles the audit row to `completed` or `failed`.
3. In Postgres, verify a new row in `routine_runs` with the appropriate `routine_name` and `status`. If `status` is still `running` after 5 minutes, the orphan-detect cron will surface it.

The dashboard's `Overview` page (under `https://caishen-v2-<hash>-belcort.vercel.app/`) shows recent `routine_runs` rows + their statuses — the easiest verification surface.

---

## What if Anthropic rotates a bearer (Routine bearer or PLANNER_ROUTINE_BEARER)?

The dashboard's `/api/overrides/replan` and the Planner's `anthropic/fire` step still use the Anthropic-issued Routine bearers (PLANNER_ROUTINE_BEARER, EXECUTOR_ROUTINE_BEARERS, SPIKE_NOOP_ROUTINE_BEARER) for the actual `/v1/routines/{id}/fire` calls. Those live in Vercel env. If you rotate one in the Anthropic console:

1. Update the new value in `.env.local` (paste yourself, never via chat).
2. Re-run `bash scripts/sync-env-to-vercel.sh --force`.
3. Re-deploy: `npx vercel deploy --prod --yes --scope=belcort`.

The Routine itself does NOT need to be reconfigured (its Cloud Env still has only `INTERNAL_API_TOKEN`, which is unchanged).

If you rotate `INTERNAL_API_TOKEN` itself: do all three places (`.env.local`, Vercel env via sync, AND each of the 3 Routines' Cloud Env section). Then re-deploy. Sub-5-min outage window.

---

## What replaces the old "GitHub repo + Bun setup script" walkthrough

The OLD instructions had you attach the repo and configure setup scripts so the Routine could `bun install` and run `bun run packages/routines/src/planner.ts`. **Skip all of that.** Path B doesn't need it. The TS modules at `packages/routines/src/{planner,executor,spike}/*.ts` remain in the repo as offline reference + test scaffolding, but the Routines do not execute them at runtime.

If you scroll back through prior session messages and see references to:
- "Setup script: `bun install`..."
- "Run command: `bun run packages/routines/src/planner.ts`"
- "Configure repo: `mosaladtaooo/caishenye`, branch `harness/build/...`"

Those are obsolete. Use the present (Path B) instructions only.

---

## Known issues to revisit (session 5g audit)

The session 5g fixes resolved the immediate live-wire-up blockers. These items are out of scope for v1 but worth tracking:

1. **FFCal HTTP wrapper (Path Y)** — current Path X requires the operator to manually attach the FFCal MCP connector to the Planner Routine (Step 3.5). If the operator wants `/api/internal/ffcal/today` to actually work as an HTTP-shaped fallback (e.g., for a future second tenant whose Routines don't share the connector list), they could build a small JSON-over-HTTP wrapper on the VPS that proxies the FFCal MCP per-tool. Then revive the deprecated route. Not blocking v1.

2. **INTERNAL_API_TOKEN rotation** — session 5e/5f exposed the token via user-paste in chat. Recommended action: rotate the token (`openssl rand -hex 32`), update `.env.local`, re-run `sync-env-to-vercel.sh --force`, re-deploy, and update each of the 3 Routines' Cloud Env. Sub-5-min outage window. The orchestrator will handle this post-session.

3. **Channels session VPS deployment** — the FR-004 always-on Channels session for Telegram message handling is a separate workstream from the Routines. Tracked under session 5h+ scope.

4. **24-48h spike harvest** — calendar-time-bound; the operator needs to leave the system running for a couple of days under real load to surface anything the unit tests didn't cover. Not a code task.

5. **Per-tenant routine_run audit query optimization** — under heavy load, the `select_pair_schedules_today` + stale-check pattern executes once per Executor fire. That's already fast (sub-50ms typical) but if the schedule grows beyond a few dozen pairs per day, an index on `(tenant_id, date, pair_code)` would help. Not needed in v1.

6. **Chat ID-aware digest formatting** — the new `chatId` field in the `/api/internal/telegram/send` response could be used by the routine to log "digest sent to <chat_id>" rather than a generic "digest sent". Cosmetic; not blocking.

7. **MT5 candle date-mode** — the proxy now supports both `count`-based and `date_from`/`date_to`-based candle fetches (the latter for historical playback / backtest scenarios). The Executor system prompt only uses count mode in v1 (matches the verbatim MSCP bar counts). The date mode is exercised by unit tests but has no production caller until v2 backtest tooling lands.
