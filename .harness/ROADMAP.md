# 财神爷 v2 — Roadmap

_Last updated: 2026-05-06_

This document tracks the full product journey: what's shipped, what's in progress, and what's planned. Updated after each feature completion by `/harness:retrospective`.

## Status Overview

| Status | Count |
|--------|-------|
| ✅ Shipped | 1 |
| 🚧 In progress | 0 |
| 📋 Planned | 0 |
| 💭 Considered (deferred) | 7 |
| 🐛 Known-issues / debt | 4 |

---

## ✅ Shipped Features

_Features that passed the Evaluator and merged to main. Newest first._

### 001 — Foundation: Routines + Channels + Dashboard + Audit (v1 + v1.1)
- **Folder**: `features/001-foundation-routines-channels-dashboard/`
- **Started**: 2026-05-01
- **Shipped**: 2026-05-06
- **Eval result**: PASS-by-live-behavior (formal Evaluator EVALUATE pass deferred per KI-002)
- **Generator self-eval**: F=9, Q=8.5, T=8.5, P=8.5
- **Spec adherence (retrospective)**: 8/10
- **FRs delivered**: FR-001 through FR-022 (FR-022 added in v1.1 retrospective for verbatim SPARTAN MT5 toolset parity)
- **Build branch**: `harness/build/001-foundation-routines-channels-dashboard` HEAD `82d8793`; cron workflow on origin/main commit `2b580e5`
- **End-state stack**: 3 Anthropic Routines + 18 Vercel internal-API routes + 3 GH Actions cron workflows + 3 NSSM services on VPS; 670 tests across 3 packages, all green; tsc-clean
- **Live-verified end-to-end**: planner /fire (Iran/Hormuz black-swan no-trade); cron tick auto-firing; MT5 returning real $122.11 demo balance + OHLC; TwelveData ATR/RSI/Stoch; FFCal real events; Telegram bot replying
- **Cost**: $200/mo Max 20x subscription only (zero per-token API charges)

---

## 🚧 In Progress

_The feature currently being built. Only one at a time._

(none — feature 001 shipped; v2 work paused pending operator decision)

---

## 📋 Planned Features

_Agreed-upon features not yet started. Priority-ordered._

(none — v1 is the foundation; v2 features tracked under "Considered (Deferred)" below)

---

## 💭 Considered (Deferred)

_Ideas evaluated but not planned yet. Can be promoted to planned later._

### TradingView chart embed
- **Why considered**: operator's brainstorm noted "embed TradingView in v2 if needed"
- **Why deferred**: out of v1 scope per operator; numbers + tables are sufficient for v1 mission control
- **Revisit when**: operator requests it after using v1 for ≥30 days

### Backtesting / strategy editor UI
- **Why considered**: dashboard could let operator edit SPARTAN/MSCP from the browser
- **Why deferred**: operator's hard rule — strategy edits via code/version control only
- **Revisit when**: operator wants to onboard non-technical co-traders

### Multi-account / multi-broker support
- **Why considered**: operator may want to A/B test brokers, or run multiple sub-accounts
- **Why deferred**: out of v1 scope; single MT5 REST gateway only
- **Revisit when**: operator's bankroll grows enough to justify >1 account

### GBP/JPY pair (re-add)
- **Why considered**: dropped from v1 to fit 15/day routine cap (1 Planner + 13 Executors = 14)
- **Why deferred**: cap pressure
- **Revisit when**: Anthropic raises the cap, OR re-architecting toward Path B (single 24/7 session) is acceptable, OR FR-001's cap-exempt verification gives so much headroom that the 14th Executor is comfortable

### Dashboard pair-config editing UI
- **Why considered**: pair config in DB; could be edited from dashboard
- **Why deferred**: v1 read-only; reduces UX surface area
- **Revisit when**: multi-tenant onboarding ships

### Replay-of-prior-trade-with-different-params (sim mode)
- **Why considered**: rich learning loop for the operator — "what if I'd used 1:4 RR instead of 1:2?"
- **Why deferred**: out of v1 scope
- **Revisit when**: v1 has accumulated enough trade history to make the analysis worthwhile

### Multi-tenant onboarding flow + billing
- **Why considered**: DB shape is already multi-tenant
- **Why deferred**: v1 is single-user
- **Revisit when**: operator wants to invite a small group

---

## Evolution Notes

_Significant pivots, scope changes, or learnings from retrospectives._

### 2026-05-01 — Project initialised after 3-round Socratic brainstorm
- The brainstorm pivoted twice: from Path 1 (Vercel Workflow + Anthropic API, ~$120-150/mo predictable cost) to Path 4-A (Routines + OpenRouter free Q&A) to **Path C Hybrid** (Routines for trading + Channels session for Telegram, all subscription-billed under Max 20x).
- The pivot was driven by user discovery of the Channels feature, which lets a single always-on Claude Code session handle Telegram bidirectionally with sub-second latency, eliminating the need for OpenRouter or a Vercel-Functions split.
- **GBP/JPY was dropped** from the v1 pair list to fit the 15/day routine cap. v1 ships 7 pairs.
- The four LOAD-BEARING UNVERIFIED ASSUMPTIONS were called out by the user during the brainstorm and made the spec's first FR (FR-001) — verification before lock-in.

### 2026-05-04 — ADR-013 cascade edit: Anthropic /schedule API doesn't exist
- Mid-build discovery: Anthropic exposes only `/fire` HTTP API; the natural-language `/schedule tomorrow at 9am, ...` is web-UI-mediated, not a public endpoint.
- Architectural pivot via `/harness:edit` (33 patches across prd.md, architecture.md, evaluator/criteria.md, contract.md): Planner persists `pair_schedules` rows in `status='scheduled'`; every-minute cron tick `/api/cron/fire-due-executors` polls due rows + fires via `/fire`.
- Original FR-001 AC-001-1 (cap-exempt-`/schedule` verification) and EC-001-1 dropped; FR-001 retitled "four assumptions" → "three assumptions".
- ADR-002 fully replaced ("cap-handling = every fire `/fire`-API-driven and cap-counted").

### 2026-05-06 — v1.1 retrospective: live-behavior PASS + 5 spec updates
- All 4 v1.1 backlog items (#1 cron pivot, #2 MT5 funnel, #3 FFCal MCP, #4 tenants seed UPSERT) plus Phase A (TwelveData) + Phase B (position management) + Phase C (pending orders) DONE+LIVE.
- Eval-substitute: live behavior verified at every layer (planner, cron, MT5, indicators, calendar, news, Telegram bot) instead of formal Evaluator pass.
- Retrospective drift findings: 6 positive, 4 negative, 3 neutral. 5 spec updates applied (FR-022 added; ADR-014 added; Stack table indicator row added; contract directory tree updated; 4 known-issues entries logged).
- Build branch + main on origin have unrelated histories — captured in ADR-014 (cherry-pick of cron workflow only; build branch is the code source-of-truth).
