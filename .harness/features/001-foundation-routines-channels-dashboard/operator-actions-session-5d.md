# Operator Actions — Session 5d Handoff

**Date**: 2026-05-04
**Session**: 5d (PAUSED at step 6 — Vercel preview is LIVE, but env vars must be populated before further smoke tests can run; routine UI configuration must happen before spike kickoffs can fire)
**Build branch HEAD**: `184e0e4` (commit added in session 5d, pushed to origin)
**Vercel preview URL**: `https://caishen-v2-c7079me98-belcort.vercel.app` (target=preview, status=READY)
**Vercel SSO bypass token**: `Sn6lXAxM3QKdf8k9GHs4P4op04ABtJAw` (NOT a secret — auto-generated for protected-preview access; documented in Vercel docs as a per-project share token)

---

## What's done in session 5d

1. ✅ Vercel project `caishen-v2` (under team `belcort`) re-linked at the **monorepo root** instead of `packages/dashboard/`. This enables Bun workspace packages (`@caishen/db`, `@caishen/routines`) to be shipped into the deployment bundle.
2. ✅ Root `vercel.json` authored with `framework: nextjs`, `buildCommand: bun --filter=@caishen/dashboard run build`, `installCommand: bun install`, `outputDirectory: packages/dashboard/.next`. The 3 daily cron entries (orphan-detect, audit-archive, cap-rollup) were moved here from `packages/dashboard/vercel.json` (which has been deleted).
3. ✅ Root `package.json` `prepare` script made graceful — skips lefthook install when not in a git repo (Vercel build env has no `.git`).
4. ✅ Root `package.json` `devDependencies` declares `next` so Vercel's framework detection finds it. Bun's hoist-by-default ensures the install is shared with `packages/dashboard`, not duplicated.
5. ✅ `next.config.ts` sets `outputFileTracingRoot` to monorepo root so Next traces workspace-linked package files into the deployment bundle.
6. ✅ Missing peer dep `@simplewebauthn/server@9` added to dashboard's deps (Auth.js v5 passkey provider needs it at build time).
7. ✅ Vercel preview deploy succeeded: `https://caishen-v2-c7079me98-belcort.vercel.app` — status READY.
8. ✅ Curl smoke-test PARTIAL: `/login` → 200 (HTML renders), `/api/csrf` → 307 redirect to login (correct middleware behavior), `/` → 307 redirect to `/login?next=%2F` (correct NFR-009 enforcement). `/api/cron/cap-rollup` → 500 "server misconfigured" (correct LOUD failure per constitution §15: env var `CRON_SECRET` is not set on Vercel).
9. ✅ `bash scripts/sync-env-to-vercel.sh` authored — one-shot operator helper that pipes `.env.local` values to Vercel CLI without echoing them.
10. ✅ `operator-instructions-routines.md` authored — per-routine setup for planner / executor / spike-noop.
11. ✅ `operator-instructions-github-cron.md` authored — GitHub repo configuration values for the cron workflows.
12. ✅ 5 atomic commits added in session 5d, all pushed to origin.

---

## What's NOT done in session 5d (operator action gates the rest)

- ❌ Env vars on Vercel project — currently zero. Until populated, every cron and Auth.js route returns 500 / 401.
- ❌ `AUTH_URL` placeholder in `.env.local` — still pointing at the session-5b stale value.
- ❌ Anthropic Routines GitHub-attach + setup-script + env-var configuration — the 3 routines exist in the console but cannot run code yet.
- ❌ FR-001 spike kickoffs — gated on routine configuration above.
- ❌ `bash .harness/init.sh` live smoke against the tunnel — gated on env vars.
- ❌ Vercel ↔ GitHub auto-deploy — `vercel git connect` still fails with the same "Failed to connect" error from sessions 5b + 5c. The dispatch said the operator linked `mosaladtaooo` GitHub identity to the personal `zhantaolau54@gmail.com` Vercel account, but our local CLI is logged in as `toolsbbb` (owner of the `belcort` team), and the linked Vercel project (`prj_wUqcbLvroJI8PVlSxbW2ezKmkNKb`) lives under `belcort`. So either (a) the operator linked GitHub to the WRONG Vercel account, or (b) there are TWO `caishen-v2` projects (one under `belcort`, one under `zhantaolau54@gmail.com` personal), and the latter is the one that got the GitHub UI connect. **For v1 launch we are using CLI-deploy from `belcort/caishen-v2`** — it works today. Auto-deploy can be set up later by either re-doing the GitHub App authorization specifically against the `belcort` team's Vercel scope, OR by re-pointing the local worktree to a personal-scope project.

---

## Operator actions IN ORDER (do these next)

### Action 1 — Update `AUTH_URL` in `.env.local`

The session-5d Vercel preview URL is `https://caishen-v2-c7079me98-belcort.vercel.app`. Find the line in `.env.local` that begins with `AUTH_URL=` and replace its value with this URL.

This must be done MANUALLY by you — Claude is not allowed to edit `.env.local` (AgentLint blocks any write to it; correct policy).

After editing, verify:
```bash
grep '^AUTH_URL=' .env.local
```
should print the expected URL.

### Action 2 — Sync env vars to Vercel

```bash
bash scripts/sync-env-to-vercel.sh
```

The script reads `.env.local`, pipes each runtime-essential value to `vercel env add` for both `preview` and `production` scopes, and never echoes any value. Expect ~24 OK lines (12 keys × 2 scopes; some may print WARN if they already exist — that's safe to ignore unless you want to overwrite, in which case re-run with `--force`).

After it finishes, verify:
```bash
npx vercel env ls
```
should list ~12 keys present in both Preview and Production.

Then trigger a redeploy so the new env vars take effect:
```bash
cd .worktrees/current && npx vercel deploy --yes
```
Wait for "Deployment ... ready." (~60 s).

### Action 3 — Re-run curl smoke tests

After redeploy, the new preview URL will differ. Capture it from the deploy output. Then:

```bash
NEW_URL="<the new https://caishen-v2-XXXX-belcort.vercel.app>"
BYPASS="Sn6lXAxM3QKdf8k9GHs4P4op04ABtJAw"
BEARER="$(grep '^CRON_' .env.local | head -1 | cut -d= -f2-)"

# /login should be 200
curl -sS -H "x-vercel-protection-bypass: $BYPASS" -o /dev/null -w "/login: %{http_code}\n" "${NEW_URL}/login"

# /api/cron/cap-rollup with valid bearer should be 200 (not 500 anymore)
curl -sS -H "x-vercel-protection-bypass: $BYPASS" -H "Authorization: Bearer $BEARER" -o /dev/null -w "/api/cron/cap-rollup auth+OK: %{http_code}\n" "${NEW_URL}/api/cron/cap-rollup"

# /api/cron/cap-rollup without bearer should be 401
curl -sS -H "x-vercel-protection-bypass: $BYPASS" -o /dev/null -w "/api/cron/cap-rollup no-auth: %{http_code}\n" "${NEW_URL}/api/cron/cap-rollup"

# Without SSO bypass at all, every URL should be 401 from Vercel SSO
curl -sS -o /dev/null -w "/login no-bypass: %{http_code}\n" "${NEW_URL}/login"
```

Expect: 200 / 200 / 401 / 401 respectively.

### Action 4 — Configure Anthropic Routines

Open `operator-instructions-routines.md` (alongside this file). Follow the per-routine sections. Test-fire spike-noop FIRST (cheapest probe). Once it succeeds end-to-end, do planner, then executor.

### Action 5 — Configure GitHub repo for cron workflows

Open `operator-instructions-github-cron.md`. Add the two repo configuration values (`CRON_SECRET` and `VERCEL_DEPLOYMENT_URL`). They sit dormant until merge to `main` triggers the workflows.

### Action 6 — Rotate the MT5 bearer (URGENT — chat-leak)

The `MT5_BEARER_TOKEN` value was incidentally surfaced into a Claude chat context window during session 5d (an ungrep'd grep output). Per the project's chat-leak rotation policy, the value must be rotated. Steps in `operator-instructions-routines.md` § "URGENT — MT5 bearer rotation".

### Action 7 — (Decision required) Resolve Vercel ↔ GitHub auto-deploy

Three options:

(a) **Defer indefinitely** — accept the manual-deploy debt. Every dashboard change requires running `vercel deploy --yes` from the worktree. Acceptable for v1; revisit when iteration friction becomes annoying.

(b) **Re-do GitHub App authorization against the `belcort` Vercel scope** — visit `https://vercel.com/account/login-connections` (or the equivalent dashboard URL for `belcort` team), authorize the GitHub App against the `belcort` team specifically (not just personal account), then re-run `vercel git connect https://github.com/mosaladtaooo/caishenye` from the worktree.

(c) **Migrate `caishen-v2` to a personal Vercel scope** — if the operator's actual intent was to host this under `zhantaolau54@gmail.com` personal scope (not `belcort` team), then: in Vercel UI, transfer the project from `belcort` team to personal account, OR delete the `belcort/caishen-v2` project and re-link locally (`vercel logout && vercel login` as `zhantaolau54@gmail.com` → `vercel link --project=caishen-v2`). This may also require re-uploading env vars.

Pick one before next session.

### Action 8 — Re-dispatch session 5e

After actions 1–7, dispatch session 5e with prompt:

> Resume BUILD mode for feature 001-foundation-routines-channels-dashboard. Session 5d landed Vercel deploy + monorepo config (5 commits, HEAD `184e0e4` pushed). Operator has now: AUTH_URL set, env vars synced to Vercel, 3 routines configured + smoke-tested, GitHub repo cron configuration values added, MT5 bearer rotated. Continue from session 5d step 8 (FR-001 spike kickoff via /fire) → step 9 (init.sh live smoke) → step 10/11/12 (bookkeeping). Then dispatch Evaluator EVALUATE.

---

## Suggested next manifest state

After session 5e completes the spike kickoffs:
```yaml
state:
  phase: "building"
  current_task: "session-5e-spike-harvest"
  last_session: "<ISO timestamp at re-dispatch>"
```

Or if session 5e ALSO can't proceed (e.g., operator skipped routine config):
```yaml
state:
  phase: "building"
  current_task: "session-5d-still-blocked-on-operator-env-vars"
```

---

## Quick reference — files added in session 5d

- `.harness/features/001-foundation-routines-channels-dashboard/operator-actions-session-5d.md` (this file)
- `.harness/features/001-foundation-routines-channels-dashboard/operator-instructions-routines.md`
- `.harness/features/001-foundation-routines-channels-dashboard/operator-instructions-github-cron.md`
- `.worktrees/current/scripts/sync-env-to-vercel.sh`
- `.worktrees/current/vercel.json` (root level; `packages/dashboard/vercel.json` deleted)

Modified:
- `.worktrees/current/package.json` (added `next` dep, replaced `prepare` script)
- `.worktrees/current/packages/dashboard/package.json` (added `@simplewebauthn/server@9`)
- `.worktrees/current/packages/dashboard/next.config.ts` (`outputFileTracingRoot`)
- `.worktrees/current/tests/cron-workflows.test.ts` (vercel.json assertion target moved to root)
- `.worktrees/current/.gitignore` (`.vercel`)
