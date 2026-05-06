# Operator Instructions — GitHub Repository Configuration for Cron Workflows

**Purpose**: enable the two GitHub Actions cron workflows (`cron-channels-health.yml` 5-min, `cron-synthetic-ping.yml` 30-min) so they can curl the Vercel-deployed handlers with the right bearer. Until this is done, both workflows fail with a LOUD error message at every run, which IS visible in the Actions tab — so you'll notice if you forget.

**Pre-requisite**: build branch is pushed (already done in session 5d), so the workflow YAML files exist in the repo at `.github/workflows/cron-{channels-health,synthetic-ping}.yml`. They will start running automatically once GitHub Actions sees them on the default branch.

> **NOTE**: GitHub Actions only runs workflows on the **default branch** (`main` by default). The current branch is `harness/build/...` — these workflows will not start firing until the branch is merged to `main`. Until then, they sit dormant. Add the repository configuration values now anyway so the first deploy after merge has them ready.

---

## Steps

### 1. Open GitHub repo Actions configuration page
- Visit: `https://github.com/mosaladtaooo/caishenye/settings/secrets/actions`
- Make sure you're logged in as the user with admin on the repo.

### 2. Add the cron-bearer repository value
- Click **"New repository secret"**
- Name field: type `CRON_SECRET` (the underscore-separated literal — it's the env-var name our handler reads, not the value).
- Value field: open `.env.local` at the project root, find the line that begins with the same name, copy everything AFTER the equals sign on that line, paste it into the GitHub UI's value field. Do NOT paste the value into chat.
- Click **"Add"**

### 3. Add the deployment-URL repository value
- Click **"New repository secret"**
- Name field: type `VERCEL_DEPLOYMENT_URL`
- Value field: the production Vercel preview URL for the dashboard. As of session 5d this is `https://caishen-v2-c7079me98-belcort.vercel.app` (the latest READY preview). After more deploys land, this URL will rotate; the cleanest value to use here is the **stable alias** that Vercel exposes for the project: `https://caishen-v2-belcort.vercel.app` (this aliases to the latest production deploy). For preview deploys (pre-merge), use the rotating `*.vercel.app` URL temporarily and update this value each time.
- Click **"Add"**

### 4. Verify with a manual workflow run
- After both values are saved, go to the Actions tab: `https://github.com/mosaladtaooo/caishenye/actions`
- (Workflows don't appear here yet because they're only on the build branch, not on main. Skip this step until after merge.)
- POST-MERGE: pick the `cron-channels-health` workflow, click **"Run workflow"** (the workflow_dispatch trigger), select the default branch.
- Watch the run. Success = the curl step exits 0 (the handler returned 2xx, meaning the bearer matched). Failure = the workflow LOUD-prints which value was missing AND/OR exits non-zero with the curl error body (because of `--fail-with-body`).

### 5. (Optional) Smoke test against the current preview URL TODAY
You can test the cron handler today, before merge, against the current preview URL by curling directly. The shell snippet below reads the bearer out of `.env.local` into a shell variable named `BEARER` without echoing it:

```bash
BEARER="$(grep '^CRON_' .env.local | head -1 | cut -d= -f2-)"
curl -fsSL --fail-with-body \
  -H "Authorization: Bearer $BEARER" \
  https://caishen-v2-c7079me98-belcort.vercel.app/api/cron/channels-health \
  -H "x-vercel-protection-bypass: <see notes below>"
```

> **Vercel preview SSO bypass**: the preview deployment is gated by Vercel's "Vercel Authentication" feature (default ON for previews). The bypass token for this project is auto-generated; retrieve it via:
> ```bash
> npx vercel curl --deployment caishen-v2-c7079me98-belcort.vercel.app /login --debug 2>&1 | grep "bypass token"
> ```
> Then pass it as the `x-vercel-protection-bypass` header.

After production-promote (or for production-deploy URLs, which don't have SSO by default), the bypass header is not needed — just the bearer.

---

## What the workflows do (brief)

`cron-channels-health.yml` (every 5 min):
- Fires GitHub Actions cron on `*/5 * * * *` (with up to 15-min jitter — GH Actions's documented behavior).
- Runs a single `curl --fail-with-body` to `${VERCEL_DEPLOYMENT_URL}/api/cron/channels-health` with the bearer in an `Authorization` header.
- The Vercel handler then queries the VPS Channels healthcheck endpoint via the Tailscale Funnel and writes a row to `channels_health` table.
- Workflow failure (any non-2xx from the handler) shows up in the Actions tab as a red X — operator's monitoring signal that something is wrong end-to-end.

`cron-synthetic-ping.yml` (every 30 min):
- Same shape, schedule `*/30 * * * *`, path `/api/cron/synthetic-ping`.
- The handler POSTs a synthetic Telegram-style ping into the Channels session (tagged `command_parsed='SYNTHETIC_PING'`) so quiet-hours health-checks have a fresh `replied_at` MAX value to query (R5 amendment to FR-005 AC-005-1).

Both workflows have `workflow_dispatch:` enabled so they can be manually re-fired from the UI for one-off verification.
