# Evaluation Criteria

Default rubric for the BELCORT Harness Evaluator. The Planner copies this to `.harness/evaluator/criteria.md` at the start of a project (or during Pass 2) and customises the **Weighting Decision** section + the per-criterion thresholds + per-criterion wording for the specific project type. Defaults below are calibrated for medium-complexity full-stack TypeScript/Node projects.

> **The Planner customises this file.** The Evaluator and Generator both read it. The wording shapes both: changes here affect what the Generator builds AND how strictly the Evaluator scores. See `agents/planner.md` Pass 2 § "Decision 2: Wording" for the principles to apply when editing this file.

## Weighting Decision

> Customise this section for THIS project's type. The default below is for a generic full-stack SaaS.

Project type: **[fill in: SaaS / e-commerce / data pipeline / CLI / design-heavy frontend / API-only backend / etc.]**

For this project type, Claude's default weaknesses are expected in: **[fill in — e.g., Product Depth and edge-case Functionality for frontend SaaS; Functionality (input edge cases) and Code Quality (security, error shapes) for backend APIs]**. Those dimensions carry higher thresholds below to push the Generator harder.

Project-adapted thresholds (defaults marked DEFAULT — change them):

- **Functionality**: 6/10 — DEFAULT (raise to 7+ for products with subtle UX or many edge cases)
- **Code Quality**: 6/10 — DEFAULT (raise to 7+ for security-sensitive or long-lived code)
- **Test Coverage**: 6/10 — DEFAULT (raise to 7+ if regressions are expensive to catch in production)
- **Product Depth**: 5/10 — DEFAULT (raise to 6+ for frontend-heavy products where polish is differentiating)

ANY criterion below threshold = FAIL → Generator retries with feedback.

---

## 1. Functionality (threshold: 6/10)

**What strong work looks like:**

The product behaves correctly across all flows in scope. Happy path works smoothly. Edge cases (empty input, very long input, special characters, rapid repeated actions, network failures, browser back/forward) all produce sensible outcomes. Error states give the user a path forward, not a stack trace. The product feels considered, not improvised.

**What failing work looks like (anti-patterns):**

- Happy path works but empty state is a blank page
- Input validation rejects invalid data with generic "400 Bad Request" instead of field-specific messages
- Rapid double-clicks cause duplicate submissions
- Browser refresh mid-flow loses unsaved state without warning
- Network failure shows "undefined" or hangs forever
- Special characters (apostrophes, emoji, RTL text) break rendering or storage

**How to test (Evaluator):**

- Use Playwright MCP to exercise EVERY acceptance criterion (AC-NNN-N) listed in the contract
- Use Playwright MCP to exercise EVERY edge case (EC-NNN-N) listed in the contract
- For every input field: try empty, very long (500+ chars), special characters (`<script>`, `'; DROP TABLE`, unicode, emoji), rapid repeated submission
- For every navigable flow: try browser back/forward at each step, page refresh mid-operation
- For every API call: simulate network failure (Playwright route interception)
- Cite file:line or Playwright-action evidence for every score < 10

---

## 2. Code Quality (threshold: 6/10)

**What strong work looks like:**

Each module has a single clear responsibility. Function names describe behaviour, not implementation. Error handling at every external boundary (API calls, file I/O, user input). No `any` types in TypeScript code. Code reads as if written for a future maintainer, not the current task. Every `git diff` block is a coherent unit of behaviour, not a "miscellaneous fixes" dump.

**What failing work looks like (anti-patterns):**

- Mega-functions over 50 lines doing many things
- Files over 300 lines doing many things
- Silent error swallowing (`catch (e) {}`)
- Dead code left in
- Commented-out experiments alongside live code
- TODO markers without owners or tickets
- `any` types papering over uncertainty
- Console.log statements left from debugging
- Duplicate logic across files instead of a shared helper
- Unused imports / variables

**How to verify (Evaluator):**

- Verify every constitution principle (see `spec/constitution.md`)
- Run linter: must have zero errors, warnings reviewed
- `find src -name "*.ts" -o -name "*.tsx" | xargs wc -l | sort -rn | head` — flag files > 300 lines
- `grep -rn ": any" src/` — flag every occurrence
- `grep -rn "console.log" src/` — flag every occurrence
- Check commit granularity in `git log --oneline` — flag mega-commits
- Cite file:line for every score < 10

---

## 3. Test Coverage (threshold: 6/10)

**What strong work looks like:**

Tests describe behaviour, not implementation. Every FR in the contract has a passing unit test. Every UJ in the contract has a passing E2E test. TDD evidence in `git log` — test commits appear BEFORE the implementation commits they verify. Tests are deterministic (run twice = same result). Edge cases and error paths are covered, not just the happy path.

**What failing work looks like (anti-patterns):**

- Tests that only assert "renders without crash"
- Tests written after implementation to match what was built
- Skipped/pending tests (`.skip`, `xit`, `xdescribe`) — these may indicate reward-hacking; the Evaluator's Step 4.5 scan flags them
- Tests that depend on execution order
- Tests that use `expect(true).toBe(true)` or other no-op assertions
- Test files modified in the SAME commit as the implementation they test (also a reward-hacking signal)
- E2E tests that don't actually navigate (just import a module and call a function)

**How to verify (Evaluator):**

- `npx vitest run` (or project equivalent) — must pass with zero skipped/pending tests in scope
- `npx playwright test` — must pass with zero skipped tests in scope
- `git log --oneline --name-only` — verify test commits precede implementation commits
- Read each test file and confirm assertions exercise real behaviour
- Run the full Step 4.5 reward-hacking scan (see `agents/evaluator.md` EVALUATE mode)
- Cite file:line for every score < 10

---

## 4. Product Depth (threshold: 5/10)

**What strong work looks like:**

The product feels considered from a user's perspective, not just an engineer's. All UI states are rendered (loading, empty, error, partial, success). Helpful affordances guide the user through multi-step flows. Errors point toward resolution, not blame. The product handles the kinds of weird inputs and weird situations real users actually produce.

For a CLI: helpful errors pointing toward resolution. Progress indication on long operations. Handles piped input AND terminal input both correctly. `--help` is useful, not generic.

For an API: error responses include actionable details (which field, what was wrong, what valid values look like). Pagination has sensible defaults. Rate limits are documented. Versioning strategy is visible.

For a frontend: loading, empty, error, partial, success states all render with appropriate UI. Forms preserve user input across errors. Keyboard navigation works. Accessibility basics (labels, focus management, contrast) are present.

**What failing work looks like (anti-patterns):**

- Loading states show blank screen
- Error states dump stack traces to the user
- Empty states look identical to loading states
- Forms lose user input on validation error
- No keyboard navigation
- API errors return generic 500 with no body
- CLI errors don't suggest a fix
- Multi-step flows have no progress indication

**How to verify (Evaluator):**

- Exercise each user journey (UJ-NNN) end-to-end via Playwright, hitting every UI state
- Verify NFR metrics with measurement, not estimation:
  - Performance NFRs: use Playwright's performance API or curl with `-w '%{time_total}'`
  - Accessibility NFRs: run axe-core via Playwright
  - Security NFRs: per `spec/constitution.md` security principles
- Try to break the product as a real user would (drag-drop wrong files, paste 10MB into a textarea, refresh during submit, etc.)
- Cite file:line or Playwright-action evidence for every score < 10

---

## Calibration

**For Evaluator:**

You over-score by ~2 points on LLM-generated code by default. If your gut says 8, the calibrated score is 6. Always read `.harness/evaluator/examples.md` BEFORE scoring — examples set the scale. If `examples.md` is empty (early in a project's life), apply the ANTI-LENIENCY PROTOCOL in `agents/evaluator.md` EVALUATE mode as the sole safeguard.

**For Generator:**

These thresholds are the FLOOR, not the target. Writing to the floor is failing. The target is to clear the floor in a way that would produce good calibration examples for `examples.md` — meaning the Evaluator would have trouble finding things to criticise.

---

## Evidence requirement

Every score below 10/10 in the eval report MUST cite specific evidence:

- File:line for code-quality findings
- Playwright action sequence + observed outcome for functionality findings
- Test file:line + assertion text for test-coverage findings
- Screenshot or DOM snippet for product-depth findings

Findings without evidence are flagged as low-quality and do not contribute to the score. This prevents vague "feels off" assessments and forces the Evaluator to ground its scoring in observation. (Source: Anthropic harness research — *"specific bug findings rather than vague assessments"*.)
