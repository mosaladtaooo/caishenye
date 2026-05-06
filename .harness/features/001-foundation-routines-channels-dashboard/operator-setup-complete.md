# Operator Setup Complete — Session 5 Dispatch Readiness

**Date completed**: 2026-05-04
**Operator**: Tao (tao@belcort.com)
**Status**: Providers 1-5 done; Provider 6 (Claude Design bundle) deferred to post-deploy iteration per honest-recommendation analysis.

This file is the canonical pre-dispatch state for session 5 (live wire-up). Everything session 5 needs to know about external services, credential locations, and deferred work is here.

## External services provisioned

### Telegram (Provider 1)
- Bot created via @BotFather; rotated once after a chat-leak incident.
- Allowed Telegram user IDs: 1 (operator's phone)
- Env vars in `.env.local`: `TELEGRAM_BOT_TOKEN`, `ALLOWED_TELEGRAM_USER_IDS`
- session 5: register bot webhook with Vercel; verify @-message gets through Channels session.

### Anthropic Routines (Provider 2)
- 3 routines created in claude.ai/code/routines on operator's Max 20x subscription:
  - `财神爷-planner` — Sonnet 4.6, cron `0 4 * * 1-5` + API trigger
  - `财神爷-executor` — Opus 4.7 [1m], API trigger only
  - `财神爷-spike-noop` — Haiku 4.5, API trigger only (FR-001 spike target)
- ALL 3 bearers rotated once after a chat-leak incident.
- Routine IDs (NOT secret) and bearers in `.env.local` under: `PLANNER_ROUTINE_ID`, `PLANNER_ROUTINE_BEARER`, `EXECUTOR_ROUTINE_IDS` (JSON `{"default": "trig_..."}`), `EXECUTOR_ROUTINE_BEARERS` (JSON), `SPIKE_NOOP_ROUTINE_ID`, `SPIKE_NOOP_ROUTINE_BEARER`, `ROUTINE_BETA_HEADER=experimental-cc-routine-2026-04-01`.
- Routines have NO repository attached yet (Path A from Provider 2 walkthrough). Session 5 must:
  1. Push the build branch (`harness/build/001-foundation-routines-channels-dashboard`) to github.com/mosaladtaooo/caishenye
  2. In each routine's web UI: add the GitHub repo as the cloned source
  3. Configure each routine's "Setup script" to install Bun + run `bun install` in `packages/routines/`
  4. Test fire each routine via `/fire` API to confirm it can clone + run
- Connectors for `财神爷-planner` and `财神爷-executor`: ForexFactory MCP via remote URL (FFCAL_BASE_URL + FFCAL_BEARER_TOKEN). Session 5 wires this.
- MT5 access from routines: via HTTP to MT5_BASE_URL with MT5_BEARER_TOKEN — NOT via Anthropic MCP connector. The Executor's mt5 client uses standard fetch().

### Vercel (Provider 3)
- Account created (free Hobby plan)
- Project: `caishen-v2` linked to GitHub repo github.com/mosaladtaooo/caishenye
- First deploy failed (empty repo) — expected. Session 5 push triggers real deploy.
- Provisioned: Vercel Postgres (Neon Free, 0.5 GB) + Vercel Blob (Free, 1 GB)
- Auto-injected env vars: `DATABASE_URL` (alias for `POSTGRES_URL`), `BLOB_READ_WRITE_TOKEN`
- Operator-generated random secrets in `.env.local`: `AUTH_SECRET`, `INITIAL_REGISTRATION_TOKEN`, `CRON_SECRET` (one was rotated after chat-leak)
- `AUTH_URL` placeholder; will be set to actual `*.vercel.app` URL after first successful deploy in session 5.

### Tailscale (Provider 4)
- Account: zhantaolau54@gmail.com (free Personal plan)
- Tailnet domain: `tail374a8c.ts.net`
- VPS hostname: `vmi2993463.tail374a8c.ts.net` (FQDN, MagicDNS resolvable)
- Tailnet ACL: `nodeAttrs` block added grant `funnel` capability to all nodes; coexists with grants-syntax `acls` + `ssh` blocks.
- Funnel exposes 2 ports (after Provider 5 re-pointing):
  - `https://vmi2993463.tail374a8c.ts.net/`     (port 443) → loopback `http://localhost:18000` → bearer-proxy → MT5 REST on `localhost:8000`
  - `https://vmi2993463.tail374a8c.ts.net:8443/` → loopback `http://localhost:18081` → bearer-proxy → ForexFactory MCP SSE on `localhost:8081`
- Funnel cert provisioning: succeeded; HTTPS works.
- Auth key (for VPS reauth): `TAILSCALE_AUTH_KEY` in `.env.local` (90-day reusable, pre-approved).
- Env vars in `.env.local`: `TAILSCALE_FUNNEL_HOSTNAME`, `MT5_BASE_URL`, `FFCAL_BASE_URL`, `TAILSCALE_AUTH_KEY`

### MT5 + ForexFactory MCP (Provider 5)
- VPS: Windows Server, NSSM-managed services
- Pre-existing services (untouched):
  - `MetaTraderMCP` — actually serves HTTP REST API on `localhost:8000` (uvicorn/FastAPI fork; not stdio MCP despite the name)
  - `ForexFactoryMCP` — serves SSE on `localhost:8081`
  - `n8n` — still running on 5678 for parallel-run safety, can be stopped after session 5 verification
- New services added in Provider 5:
  - `caishen-mt5-proxy` — Bun reverse proxy listening on `localhost:18000`, forwards to `localhost:8000` after `Authorization: Bearer ${MT5_BEARER_TOKEN}` validation
  - `caishen-ffcal-proxy` — Bun reverse proxy listening on `localhost:18081`, forwards to `localhost:8081` after `Authorization: Bearer ${FFCAL_BEARER_TOKEN}` validation
- Proxy script source: `C:\caishen\auth-proxy.ts` on VPS (~50 lines Bun TypeScript)
- Bun installed at `C:\Users\Administrator\.bun\bin\bun.exe`
- NSSM at `C:\windows\system32\nssm.exe`
- Three bearer tokens in `.env.local`: `MT5_BEARER_TOKEN`, `FFCAL_BEARER_TOKEN`, `HEALTH_BEARER_TOKEN`
- MT5 bearer rotated once after chat-leak incident
- Verified end-to-end (dev laptop → Funnel → proxy → MT5): 401 without bearer, 200 + real account JSON with bearer (uvicorn server, contest demo account, $222 balance)
- ForexFactory verification was done by operator (operator confirmed Provider 5 done after MT5 worked); session 5 should re-verify FF in the init.sh smoke test as a defensive check

## Deferred to session 5 / post-deploy iteration

- **Provider 6 (Claude Design)** — deliberately deferred per the design analysis: Claude Design works dramatically better when reading an existing deployed app vs. generating from scratch. Operator will iterate AFTER session 5 deploy: open claude.ai/design, point at the live `*.vercel.app` URL, iterate based on real intraday usage friction, export bundle to `design/dashboard-bundle/`, then `/harness:amend "regenerate dashboard from updated design/dashboard-bundle/"` triggers Generator to consume.

- **AUTH_URL** — placeholder until first Vercel preview deploy in session 5; operator updates `.env.local` then re-deploys to make Auth.js redirect URLs work.

- **GitHub repo push** — session 5 pushes `harness/build/001-foundation-routines-channels-dashboard` to github.com/mosaladtaooo/caishenye, then attaches to each Anthropic Routine.

- **n8n shutdown** — keep n8n running (port 5678) until session 5 verification confirms v2 is live + executing trades correctly. Then stop n8n NSSM service. Don't remove yet (60-day grace for archive).

## Session 5 dispatch instructions

When the orchestrator is ready to dispatch session 5 (BUILD mode resume), include:

1. **Resume context**: `state.current_task` in manifest is whatever the previous build session left it at (was `FR-016` then advanced through M4/M5; check current value)
2. **Operator setup complete**: read this file
3. **Credentials**: live in `.env.local` at project root (gitignored). Session 5 must NOT echo or commit them.
4. **External identifiers**:
   - GitHub repo: github.com/mosaladtaooo/caishenye
   - Vercel project: caishen-v2
   - VPS Tailscale FQDN: vmi2993463.tail374a8c.ts.net
   - Anthropic Routines: 财神爷-planner, 财神爷-executor, 财神爷-spike-noop
   - Telegram bot: rotated, allowlist = 1 user
   - VPS NSSM services: MetaTraderMCP, ForexFactoryMCP (existing) + caishen-mt5-proxy, caishen-ffcal-proxy (new)
5. **Work to do in session 5**:
   - Push build branch to GitHub
   - Wire Vercel project to GitHub (auto-deploy on push)
   - Trigger first Vercel deploy
   - Update AUTH_URL in `.env.local` + Vercel env
   - Attach GitHub repo to each Anthropic Routine; configure setup scripts
   - Fire FR-001 spike-noop routine; capture outcomes JSON
   - Run FR-001 spikes 1-4 (programmatic-one-off creation, duration limit, /fire stability, Channels token quota) — these are 24-48h elapsed-time measurements
   - Resolve FR-013 conditional based on Spike 2 math-fidelity outcome
   - Update SPIKE_FR_001_OUTCOMES JSON
   - Verify dashboard loads + auth works end-to-end
   - Verify init.sh smoke test passes against the live tunnel + bearers
6. **Then** dispatch Evaluator EVALUATE → tuning check → retrospective → merge.

## Calibration notes (3 chat-leak incidents during operator setup)

The operator pasted bearer values directly into chat 3 separate times during the walkthrough (TELEGRAM_BOT_TOKEN, then 3x ANTHROPIC bearers, then MT5 bearer via `curl -v`, then 2 IDE-selection leaks of values from `.env.local`). Each was rotated. For future operator-walkthrough sessions: bake the "no chat-paste" coaching into the Provider 1 instructions BEFORE asking for any tokens, not as a reactive fix after the first leak. Memory `feedback_keep_tokens_out_of_chat.md` has the rule.
