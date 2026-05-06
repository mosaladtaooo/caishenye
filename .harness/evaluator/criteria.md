# Evaluation Criteria — 财神爷 v2

> Customised from the BELCORT default for THIS project: an LLM-driven forex trading system where correctness is high-stakes, the audit trail is operator-mandated, and the dashboard is design-driven through the `frontend-design` + `impeccable` skills.

## Weighting Decision

Project type: **trading-agent backend + design-driven frontend dashboard + agentic Telegram surface — hybrid full-stack with safety-critical financial behaviour and senior-trader-grade IP preservation**.

For this project, Claude's default weaknesses are expected in:

- **Functionality**: many quiet correctness landmines specific to forex trading — symbol-cleaning for XAU/USD, GMT-only timezone discipline, exact preservation of an existing senior-trader prompt, multi-tenant filter on every query, the four LOAD-BEARING UNVERIFIED ASSUMPTIONS being verified via spike code that actually exercises them. Claude will tend to "approximate" the behaviour and miss specific landmines unless pushed. **Threshold raised from 6 → 8.**
- **Code Quality**: secrets management is the entire reason this project exists (no `ANTHROPIC_API_KEY` anywhere), audit-or-abort is the operator's hard line, and the constitution has 17 testable principles. Claude will tend to "log and continue" instead of "abort"; will tend to leave dead `console.log` calls; will tend to omit the multi-tenant `WHERE tenant_id = $1`. **Threshold raised from 6 → 8.**
- **Product Depth**: the dashboard is the operator's mission control on the desk. The brainstorm explicitly invokes `frontend-design` and `impeccable` skills. Claude's default is bland-but-functional; this project's competition is "n8n+spreadsheet" and the operator wants something he's *proud* to run his desk from. The Channels session also has Product Depth: the Telegram chat must feel like talking to a senior trader's assistant, not a chatbot. **Threshold raised from 5 → 7.**
- **Test Coverage**: regressions in trading code cost real money. TDD is in the constitution. Snapshot tests for the news-fetch port, golden-file tests for the prompt preservation, route-enumeration tests for auth coverage, replay-equivalence tests for routine prompts. **Threshold raised from 6 → 7.**

Project-adapted thresholds:

- **Functionality**: 8/10 (raised from 6)
- **Code Quality**: 8/10 (raised from 6)
- **Test Coverage**: 7/10 (raised from 6)
- **Product Depth**: 7/10 (raised from 5)

ANY criterion below threshold = FAIL → Generator retries with feedback.

**Why these thresholds**: this project's failure modes are concentrated in correctness ("missed trade", "wrong symbol", "exposed API key", "audit hole") and in operator-experience ("dashboard feels cheap", "Telegram feels canned"). Pushing the thresholds up where Claude's defaults are weakest matches the Anthropic research finding that weighted thresholds shape Generator output: a default-rubric Generator would ship the bland version of this product; a weighted-rubric Generator builds for the operator's actual standard.

---

## 1. Functionality (threshold: 8/10)

**What strong work looks like:**

The trading core fires reliably and visibly. Every routine writes its provenance row before any side effect (audit-or-abort respected). Every order placed by the Executor honours the SPARTAN prompt's risk rules — 5% capital cap, ATR-based SL, the XAU/USD `XAUUSD` symbol cleaning, the structure-key + ATR-buffer SL formula — verified by a synthetic XAU/USD test that asserts every MT5 tool call uses `XAUUSD` exactly. Every edge case the brainstorm called out (MT5 down, ForexFactory empty, RSS unreachable, cap exhausted, beta-header bumped, Channels session crashed) has a coded response that's been exercised, not just described in a comment. The 4 LOAD-BEARING ASSUMPTIONS (FR-001) are verified by code that actually runs the spike, not by a doc note that says "TODO verify". The dashboard's override actions are atomic — audit row + MT5 call + Telegram broadcast either all succeed or are visibly rolled back. Multi-tenant `WHERE tenant_id = $1` is in EVERY query — verified by a static-analysis test that scans the codebase. Time is GMT/UTC everywhere; a DST-transition-day test passes.

**What failing work looks like (anti-patterns):**

- "Audit row gets written best-effort after the trade" (this is not audit-or-abort; this is audit-when-convenient)
- An XAU/USD code path that uses `pair.replace('/', '')` and ends up with `XAUUSDF` because of an unrelated config
- The 5% capital cap implemented as a `// TODO check capital` comment
- A query that filters by `pair_code` but forgets `tenant_id`
- The cap-accounting model taken on faith without spike or audit-row evidence (was originally framed as the cap-exempt `/schedule` assumption — DROPPED in v1.1 per ADR-002 revised; the new failure mode is missing audit rows in `cap_usage_local` for any cap-burning code path)
- "We'll handle the routine timeout if it happens" (no test, no fallback, no observability)
- An override action that writes the audit row but the MT5 call fails silently — operator sees "success" toast, position stays open
- Any time displayed without "GMT" label
- Any time stored as a wall-clock string without timezone
- The Channels session's `/replan` returns a stub response instead of actually firing `/fire`
- News-fetch port produces different markdown than n8n's `Code in JavaScript5` for the same RSS input
- `--dangerously-skip-permissions` shipped without a tool allowlist constraining what the Channels session can run via Bash

**How to test (Evaluator):**

- Use Playwright MCP to exercise every AC in the contract (`features/NNN/contract.md`).
- Use Playwright MCP to exercise every EC in the contract.
- Verify FR-001 spike artefacts: read the `routine_runs` audit rows for the spike runs; confirm the duration measurement for AC-001-2; confirm the `/fire` smoke test for AC-001-3; confirm the 24h Channels-session token measurement for AC-001-4. (AC-001-1 cap-exempt verification was DROPPED in v1.1 per ADR-002 revised — no programmatic `claude /schedule` API exists; no spike artefact to verify.)
- Run the synthetic XAU/USD harness; assert every MT5 tool call's `symbol_name` field == `XAUUSD` (no `XAUUSDF`).
- Run the static-analysis test for `WHERE tenant_id`; expect zero violations.
- Run the DST-transition-day test (date library frozen at March 30, 2026 spring-forward and October 26, 2026 fall-back).
- Run the news-fetch port snapshot test (`packages/routines/src/news.test.ts`) against the n8n version's golden output.
- Run the prompt-preservation diff: read the routine's deployed prompt via the Anthropic API/CLI, byte-compare against `.harness/spec/preserve/spartan-systemprompt.md` and `planner-systemprompt.md`.
- Verify the override action's atomicity: simulate a failed MT5 REST during override, confirm audit row says `success=false`, no Telegram fires, dashboard shows error toast.
- Verify FR-005 healthcheck cron actually pages out-of-band when Channels session is dead for >10 min (mock it).
- Cite file:line or Playwright-action evidence for every score < 10.

---

## 2. Code Quality (threshold: 8/10)

**What strong work looks like:**

Code reads like a senior engineer's pull request — every file has a clear single responsibility, every function name describes the behaviour rather than the implementation, every external boundary (MT5 REST, ForexFactory MCP, Postgres, Vercel Blob, Telegram Bot API, Cloudflare Tunnel call) has explicit error handling that either recovers or aborts loudly. No `any` in TypeScript; uncertainty is modeled via `unknown` + narrowing or a discriminated union. No `console.log` left from debugging; structured logger throughout. No silent catches — every `catch` either logs + re-throws or returns a typed error result. The pre-commit hook + CI lint actually runs and actually catches the things it claims to catch (test it by attempting to commit a file containing the literal `ANTHROPIC_API_KEY` and confirming rejection). The constitution's 17 principles each have a corresponding code or test guard, not just a doc rule. Constitutional compliance would survive an OWASP-style audit on the dashboard side and a financial-controls-style audit on the trading side.

**What failing work looks like (anti-patterns):**

- A single mega-route-handler file with all override actions, > 300 lines
- A `try { ... } catch (e) {}` anywhere in the codebase
- `as any` cast hiding a real type uncertainty
- `console.log` left in production code
- A "miscellaneous fixes" commit that touches 8 unrelated files
- An `.env.example` that includes `ANTHROPIC_API_KEY=` (even with a placeholder — it would defeat the point of §1's literal-string ban; pre-commit MUST flag it)
- A migration that creates a table without `tenant_id`
- A query that uses string concatenation to build SQL instead of parameterised query (SQL injection footgun for the override params)
- A secret committed to the repo that gitleaks doesn't catch (because the gitleaks rules weren't tuned for this project's secrets — bot token, MT5 password, Cloudflare service token)
- The Channels session's tool allowlist allowing `Bash(*)` instead of a strict allowlist
- A failed migration left in the migrations folder (broken state)
- TODO comments without a date and owner
- Commented-out code anywhere

**How to verify (Evaluator):**

- Verify EVERY constitution principle (`spec/constitution.md` §1-§17) has been respected. Each finding cites the principle.
- Run `pnpm lint` (or project equivalent) — must have ZERO errors, warnings reviewed and either fixed or explicitly suppressed with comment justification.
- Run `pnpm tsc --noEmit` — must have zero errors.
- Run gitleaks against the working tree AND the full git history; zero findings.
- Run `make audit-no-api-key` — exit 0.
- Static-analysis: scan all TS files for `: any`, `as any`, `console.log`, bare `catch (e) {}`. All results triaged.
- File-size scan: `find . -name "*.ts" -o -name "*.tsx" | xargs wc -l | sort -rn | head -20` — flag any file > 300 lines.
- Commit-granularity scan: `git log --oneline` — flag mega-commits that touch > 10 unrelated files.
- Scan the Channels session subagent config for tool-allowlist breadth — Bash should not be `*`, should be a list of explicit script paths or commands.
- Scan migrations for any table missing `tenant_id`.
- Cite file:line for every score < 10.

---

## 3. Test Coverage (threshold: 7/10)

**What strong work looks like:**

Every FR in the contract has at least one passing test that exercises its primary AC. Every UJ has at least one Playwright test that walks through it. TDD evidence in `git log` — test commits appear BEFORE the implementation commits they verify, in the three-commit cadence (RED, GREEN, REFACTOR). Tests exercise behaviour, not implementation. Snapshot tests for the news-fetch port use frozen RSS fixtures and compare byte-by-byte. A golden-file test for both routine prompts confirms the deployed routine's system prompt is byte-identical to the `.harness/spec/preserve/` files. Auth coverage via Playwright route-enumeration test (NFR-009). The XAU/USD symbol-cleaning hard test (AC-003-3) is in the test suite and runs in CI. A DST-day test (NFR-008) runs in CI. The pre-commit hook + CI lint enforcement is itself tested (negative test: try to commit a file containing the forbidden string, expect rejection). Tests are deterministic — re-running the suite produces the same result.

**What failing work looks like (anti-patterns):**

- A test that asserts "the page renders" but never exercises an interaction
- A test that mocks the MT5 REST so heavily that what's actually being tested is the mock
- A test that imports a function and asserts `typeof foo === 'function'` (not behaviour)
- Skipped tests (`.skip`, `xit`, `xdescribe`, `it.todo`) — these may be reward-hacking; investigate each one
- A test that depends on system clock without mocking (will flake)
- A test that asserts on the order of unordered DB rows
- The TDD git-log evidence missing — implementation and tests committed together (also reward-hacking signal)
- A test for the audit-or-abort path that confirms "if Postgres is up, audit row is written" but never tests "if Postgres is down, the routine actually aborts"
- The prompt-preservation test passing because it compares the file to itself (not to the deployed routine)
- The XAU/USD test asserting on a string that contains "XAUUSD" anywhere (e.g., "XAUUSDF" contains "XAUUSD" as a substring) — must be exact match
- E2E test that runs against a static HTML mock instead of the actual deployed Vercel preview
- Test coverage gaps on the four LOAD-BEARING assumption verifications (FR-001) — those MUST have tests that re-run the spike, not just doc notes that say "we tested this once"

**How to verify (Evaluator):**

- `pnpm vitest run` — all tests pass, ZERO `.skip` / `.todo` / `xit` in scope.
- `pnpm playwright test` — all tests pass, zero skipped.
- Per FR in `features/NNN/contract.md`: `grep -rn "FR-NNN" tests/` should find at least one test referencing each FR.
- Per UJ in `features/NNN/contract.md`: there should be at least one Playwright spec referencing each UJ.
- Per the constitution's testable principles: each should have at least one test or static-analysis guard.
- `git log --oneline --name-only` — verify test commits precede implementation commits in the TDD cadence.
- Read the news-fetch snapshot test's fixtures; confirm they are pinned and not regenerated automatically.
- Read the prompt-preservation test; confirm it compares the DEPLOYED routine prompt (via API/CLI fetch) against the `.harness/spec/preserve/` file, not against itself.
- Read the XAU/USD symbol test; confirm assertion is exact equality, not substring containment.
- Run the full Step 4.5 reward-hacking scan from `agents/evaluator.md`.
- Cite file:line for every score < 10.

---

## 4. Product Depth (threshold: 7/10)

**What strong work looks like:**

The dashboard feels like a senior trader's tool, not a CRUD app. Every screen has loading, empty, error, partial, and success states distinguishable at a glance. The Overview screen reads at a glance — no scanning required to find P&L, no clicking required to see open positions. Live-data freshness is communicated visibly (a quiet "5s" tick or a fading dot). When data goes stale (yellow at 30s, red at 60s) the UI fails LOUD; operator never wonders if they're looking at last week. The override panel is built like a cockpit kill switch — confirmation modals on destructive actions, before/after diff visible, undo path obvious. Forms preserve user input across validation errors. Keyboard navigation works (operator on a phone keyboard for Telegram is one path; operator on a laptop keyboard for the dashboard is another). The Telegram session feels like a senior trader's assistant — replies are concise, numerate, situated; never canned, never lectured, never refuses to answer reasonable questions. Free-text Q&A reads `routine_runs` and answers with the actual reasoning, not "I cannot determine that". The `frontend-design` skill output and the `impeccable` skill polish are both visible — typography, hierarchy, alignment, color all feel coherent and intentional. The dashboard does NOT look like a default shadcn template; it has been pushed past the default into a coherent product look.

For the trading agent's Telegram surface specifically: response copy is tight (no "Sure, here's what I found:" preamble), uses real numbers (no "many" / "several"), names sources ("based on `routine_runs[id=42]` from 09:14 GMT"). When the operator asks an open-ended question, the answer is grounded in the audit trail; when the operator gives a command, the action is executed and confirmed in two lines.

For the audit/replay path: clicking a trade in the History view to "View Claude session" actually opens the `claude_code_session_url` in a new tab, NOT a 404, NOT a stub.

**What failing work looks like (anti-patterns):**

- Loading states are blank pages or a single spinner with no skeleton
- Empty states look identical to loading states
- Error states show "An error occurred" with no actionable next step
- Stale data has no visual indicator (operator looks at 5-min-old positions and trades on it)
- Override actions fire without confirmation
- Override actions don't show before/after diff
- Forms lose user input when validation fails
- The dashboard looks like a default shadcn template ("purple gradients over white cards" energy)
- The Telegram session over-uses "Sure!" / "I'd be happy to help" / "Let me check that for you" preambles
- Telegram replies are vague ("things look good") instead of grounded ("balance $50,234, equity $50,489, 3 open positions, today's PnL +$255")
- Free-text Q&A returns "I cannot determine" for questions answerable from the audit trail
- The History page renders markdown poorly (no code blocks, no headings, no spacing)
- The "View Claude session" link is a placeholder that doesn't open the session
- The dashboard works on a laptop but breaks on a phone (operator is phone-primary)
- The countdown to next session is wrong by hours because of a TZ bug
- `frontend-design` was invoked but the bundle was ignored — generator wrote scaffold from scratch
- `impeccable` audit didn't run, or ran and surfaced findings that weren't fixed

**How to verify (Evaluator):**

- Walk every UJ via Playwright.
- For every screen: hit it with empty data, with one row of data, with paginated data, with error simulated, with stale data simulated.
- For every override action: simulate a failed MT5 REST mid-action and confirm UI fails LOUD.
- Run axe-core accessibility audit — fix critical findings.
- Test mobile viewport (Playwright `--device "iPhone 14"`); operator-mandatory paths must work.
- Send 10 sample Telegram messages (5 slash commands, 5 free-text questions of varying complexity) to a test instance of the Channels session; rate the replies on tone, accuracy, brevity.
- Open 5 random history entries; verify "View Claude session" link works and opens the actual session URL.
- Compare dashboard screenshots vs the `design/dashboard-bundle/` source — variance should be intentional refinement, not regression.
- Verify `impeccable` skill was invoked at end of UI work AND its findings were addressed (look in `features/NNN/implementation-report.md` for evidence).
- Verify `frontend-design` skill was invoked AND consumed the bundle (not scaffold-from-scratch).
- Cite Playwright action sequence + observed outcome for every Functionality finding; screenshot or DOM snippet for every Product Depth finding.

---

## Calibration

**For Evaluator:**

You over-score by ~2 points on LLM-generated code by default. If your gut says 8, the calibrated score is 6. Always read `.harness/evaluator/examples.md` BEFORE scoring — examples set the scale. If `examples.md` is empty (early in this project's life), apply the ANTI-LENIENCY PROTOCOL in `agents/evaluator.md` EVALUATE mode as the sole safeguard. **For this project specifically:** Functionality and Code Quality have raised thresholds (8/10) — apply EXTRA rigor to those dimensions; the operator's hard lines (no API key, audit-or-abort, prompt verbatim) are dimensions where 7/10 is failing.

**For Generator:**

These thresholds are the FLOOR, not the target. Writing to the floor is failing. The target is to clear the floor in a way that would produce good calibration examples for `examples.md` — meaning the Evaluator would have trouble finding things to criticise. **For this project specifically:** the bar is "would a senior forex prop-trader use this on his own desk and feel proud of it?" — if the answer is "it works, but it feels generic", you have not cleared the bar.

---

## Evidence requirement

Every score below 10/10 in the eval report MUST cite specific evidence:

- File:line for code-quality findings
- Playwright action sequence + observed outcome for functionality findings
- Test file:line + assertion text for test-coverage findings
- Screenshot or DOM snippet for product-depth findings

Findings without evidence are flagged as low-quality and do not contribute to the score.
