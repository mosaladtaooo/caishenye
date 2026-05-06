# 财神爷 v2 — Constitution

> Each principle is testable. The Evaluator uses these as a hard gate. Amendments only via `/harness:constitution-amend`.

## §1. NO `ANTHROPIC_API_KEY` ANYWHERE
The string `ANTHROPIC_API_KEY` MUST NOT appear in: source files, test fixtures, `.env*` files (committed or local), Vercel env vars, VPS env files, Cloudflare/cloudflared config, or git history. The pre-commit hook (FR-010 AC-010-1) MUST reject any commit that contains it. CI MUST run the same check. **Rationale**: structural prevention of the GitHub#37686 surprise-billing failure mode. Subscription-only billing is the entire point of v2.

## §2. SPARTAN PROMPT + PLANNER PROMPT PRESERVED VERBATIM
The system prompts for the Executor (`spec/preserve/spartan-systemprompt.md`) and the Planner (`spec/preserve/planner-systemprompt.md`) MUST be transmitted to Anthropic byte-identical to the file contents. No paraphrase, no normalization, no smart-quote substitution. A CI test MUST diff the deployed routine prompt against the file and fail on any difference. **Rationale**: that prompt IS the trading IP being migrated. v1 is faithful migration only.

## §3. AUDIT-OR-ABORT
Every routine fire (Planner OR Executor) MUST write its `routine_runs` provenance row BEFORE making any external tool call (MT5 REST, ForexFactory MCP, Postgres write, Telegram message). If the audit-row insert fails, the routine MUST exit immediately without further side effects. **Rationale**: an unaudited trade is worse than no trade. Operator's hard line.

## §4. MULTI-TENANT TENANT_ID FROM DAY ONE
Every Postgres table that holds operator data MUST have a `tenant_id` column (NOT NULL, default `1` for v1's single tenant). Every query in app code MUST include `WHERE tenant_id = $1` (or equivalent ORM filter). A linter rule (or static-analysis test) MUST scan repository TS for query patterns missing the filter. **Rationale**: v2 is shipped to enable a small group later; refactoring tenant scope post-launch is significantly harder than enforcing it now.

## §5. TIMEZONES ARE GMT/UTC, ALWAYS
Every datetime stored in DB, transmitted between agents, written to logs, or shown to the user MUST be GMT/UTC. Times shown to the user MUST display the timezone label ("14:00 GMT", not "14:00"). Local-time conversion happens ONLY in the dashboard's view layer, never in the data layer. **Rationale**: forex trades happen across timezones; ambiguous timestamps cause silent disasters.

## §6. NO GOOGLE CALENDAR ANYWHERE
The string `googleapis.com/calendar`, the npm package `googleapis`, or any Google Calendar OAuth flow MUST NOT appear anywhere in v2's code, dependencies, or infra. The whole reason for the migration is removing this layer; reintroducing it via the back door defeats the goal. **Rationale**: operator's hard-rejection from brainstorm.

## §7. NO N8N
v2 MUST NOT depend on n8n at runtime. The two n8n JSONs in the repo (`财神爷 Agent.json`, `财神爷 schedule trigger.json`) are READ-ONLY references for the migration; they are never deployed, never imported as runtime dependencies, never serve traffic. **Rationale**: zero ongoing dependency on the tool we're replacing.

## §8. TDD CONTRACT (red-green-refactor with evidence)
Every FR in this product's lifetime MUST be implemented via the BELCORT Harness TDD contract: write a failing test, commit (RED), make it pass with minimal code, commit (GREEN), refactor if needed, commit (REFACTOR). Git log MUST show the three-commit cadence per FR. **Rationale**: prevents "looks done, doesn't work" outcomes; gives the Evaluator concrete evidence to grade against.

## §9. UNIT TESTS WITH VITEST, E2E TESTS WITH PLAYWRIGHT
The project's testing stack is fixed: `vitest` for unit/integration, `playwright` for E2E browser tests of the dashboard. Mixing in jest / mocha / cypress is forbidden. **Rationale**: harness defaults are uniform across BELCORT projects, lowering operator cognitive cost; both have first-class Vercel + Next.js 16 support.

## §10. NO SECRETS IN SOURCE
No API key, bot token, bearer token, password, or connection string MAY appear in source files (including tests, fixtures, comments, or example configs). All secrets MUST come from environment variables (Vercel env, VPS systemd `EnvironmentFile=`, or `.env.local` outside git). A secret-scanning step in CI (gitleaks or equivalent) MUST run on every commit. **Rationale**: the existing n8n workflow has a hardcoded TwelveData API key — this constitution specifically forbids carrying that pattern over.

## §11. EVERY OVERRIDE WRITES AN AUDIT ROW
Every `override_actions` write MUST capture: operator user_id, action_type, target, params, before_state, after_state, success_bool, error_message_if_any. Override actions that don't write the audit row MUST refuse to execute (audit-or-abort, applied to overrides). **Rationale**: operator's hard line on full operational replay.

## §12. NO ALL-TENANTS QUERIES
No SQL query (anywhere in app code) MAY scan all tenants. Even cross-tenant analytics (if added in v2+) MUST iterate per-tenant, not select-all. **Rationale**: defense-in-depth against accidental data leak across tenants.

## §13. FORBIDDEN DEPENDENCIES
The following packages MUST NOT appear in `package.json` of any workspace: `googleapis`, `@google-cloud/local-auth`, `n8n-*`, `openrouter-*`, the Anthropic Python SDK (`anthropic` py), the Anthropic TS SDK (`@anthropic-ai/sdk`) (the latter two would imply API-key billing, prohibited by §1). **Rationale**: structural prevention of the rejected paths from the brainstorm.

## §14. ROUTINES + CHANNELS-SESSION ARE THE ONLY LLM CALLERS
LLM calls MUST originate from one of: a Claude Code Routine (Planner or Executor), the always-on Channels session on the VPS. No app-code path may directly call an Anthropic SDK or HTTP endpoint that consumes LLM tokens. **Rationale**: keeps subscription-only billing structurally enforced, makes the audit graph (FR-007) tractable.

## §15. PRE-FLIGHT CLEANNESS
`init.sh` (FR-020) MUST exit 0 only if the entire environment is clean. Any unfixable warning MUST be explained loudly; suppressing or hiding warnings is forbidden. **Rationale**: operator's auto-memory rule (`feedback_perfect_env_first`).

## §16. NAMING CONVENTIONS
- Files: `kebab-case.ts` (not snake_case, not PascalCase except for React components which are `PascalCase.tsx`).
- Database tables: `snake_case` (Postgres convention).
- Database columns: `snake_case`.
- Routine names in Anthropic console: `财神爷-{role}` (e.g., `财神爷-planner`, `财神爷-executor`).
- Subagent IDs in Claude Code: `caishen-{role}` (ASCII).
- Env vars: `SCREAMING_SNAKE`.

## §17. FORBIDDEN PATTERNS
- No `any` in TypeScript (use `unknown` + narrowing if truly necessary; document why).
- No `console.log` left in committed code (use a structured logger or a test-only stub).
- No `// TODO` without an issue link or a date and owner.
- No commented-out code in committed PRs (delete it; git history is the archive).
- No silent catches: every `catch` MUST log + re-throw OR explicitly return an error result; bare `catch (e) {}` is forbidden.
