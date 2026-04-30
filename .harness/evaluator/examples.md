# Evaluator Calibration Examples

Few-shot examples with detailed score breakdowns, used by the Evaluator in EVALUATE mode to calibrate scoring against human preferences.

## Purpose

Anthropic's harness research found that "tuning a standalone evaluator to be skeptical turns out to be far more tractable than making a generator critical of its own work." This file is where that tuning accumulates over time.

The bootstrap examples below seed the scoring scale before any project-specific tuning has happened. **Read them before scoring any criterion.** As the harness logs human-Evaluator divergences in `tuning-log.md`, `/harness:tune-evaluator` adds project-specific examples here.

## How this file is used

The Evaluator reads this file at the start of EVALUATE mode, BEFORE scoring any criterion. The examples set the scoring scale for "what a 3/10 looks like," "what a 5/10 looks like," "what an 8/10 looks like" — in concrete, not abstract, terms.

## How this file is populated

- **Bootstrap**: the examples below ship with the harness as a starting calibration point
- **Automatic**: added by `/harness:tune-evaluator` when a human flags an eval as diverging from their judgment
- **Manual**: you can add examples directly when you notice a grading pattern that needs correction

## Scoring Scale Reference

- 1-2: Fundamentally broken, unusable
- 3-4: Major gaps, core features missing or broken
- 5-6: Passes threshold but with visible issues
- 7-8: Solid work, minor gaps only
- 9-10: Exceptional (rare, should trigger "is something hiding?" check)

---

## Examples by Criterion

### Functionality

#### Example F-001 — Happy-path-only feature ("works for me" trap)
**Scenario**: Bookmark CRUD with 5 ACs. AC-001 (create) works on Playwright. AC-002 (list) works. AC-003 (delete) works. AC-004 (edit) — the form opens but submitting silently no-ops. AC-005 (search) — works for exact match, returns empty for partial.
**Wrong score**: 7/10 — "most ACs pass, edit and search are minor"
**Right score**: 4/10 — two of five ACs are broken, including a primary CRUD operation. Per the rubric's hard-threshold rule, ACs that don't pass don't count as "working." Below the 6 threshold → FAIL.
**Lesson**: count ACs, don't average impressions. A feature with 60% AC pass rate cannot score above 5 unless the failing ACs are all P2/edge cases.

#### Example F-002 — Edge cases not tested
**Scenario**: Search feature works for typed input. Evaluator tested "bookmarks" → returns 3 results. Marked PASS, scored 8/10.
**Wrong score**: 8/10 — happy path verified
**Right score**: 5/10 — happy path only. Anti-leniency protocol Step 4: "If you only tested the happy path → subtract 2 points." Untested edge cases (empty input, very long input, special chars, unicode, rapid repeated submission) are unverified, not assumed-passing. Score the verified portion, not the assumed portion.
**Lesson**: every input field has at least 5 edge cases. Test all of them, or score for the subset tested.

#### Example F-003 — Subtle UX failure that isn't a crash
**Scenario**: Form has 8 fields. User fills all 8, submits, gets validation error on field 3. On re-render, fields 1-2 are preserved but fields 4-8 are blanked. Evaluator noticed but scored 7/10 because "the validation error itself works."
**Wrong score**: 7/10 — "the error message rendered correctly"
**Right score**: 5/10 — losing user input on validation is a P0 UX failure regardless of whether the error UI works. "It didn't crash" is not the bar. The bar is "a real user could complete this flow without re-typing everything." Below threshold.
**Lesson**: grade the user's experience, not the developer's intent. If the user has to do work the product should have done, points come off.

---

### Code Quality

#### Example Q-001 — Mostly-clean code with one mega-function
**Scenario**: Codebase is well-organised, tests pass, lint clean. One function (`processBookmarkBatch`) is 180 lines, does 4 distinct things, has 11 parameters.
**Wrong score**: 7/10 — "overall structure is fine"
**Right score**: 5/10 — calibration benchmark from criteria.md anti-pattern list: "one 200-line function exists" → score 5. Function length is a single objective measurable thing; one violation drops the dimension below 6.
**Lesson**: code quality is multiplicative not additive. One serious violation drops the score; you don't average it out across the rest of the codebase.

#### Example Q-002 — `any` types papering over uncertainty
**Scenario**: TypeScript codebase with 3 `: any` annotations. Two are explicit ("data from external API, will type later"), one is implicit (`response: any` because the developer didn't know the shape).
**Wrong score**: 7/10 — "only 3 anys, mostly explicit"
**Right score**: 5/10 — calibration benchmark: "all features work, but 3 `any` types in code → 5/10". Each `any` is a typed-as-untyped escape hatch that hides bugs. Three of them in a small codebase is below the bar.
**Lesson**: `any` is a code smell with a clear count. Each instance is countable; the threshold is low.

#### Example Q-003 — Silent error swallowing
**Scenario**: Code has 4 `catch` blocks. Two log and re-throw (good). One logs then continues (questionable). One is empty `catch (e) {}` (bad).
**Wrong score**: 8/10 — "mostly good error handling"
**Right score**: 4/10 — empty catch block is a category-A violation per constitution. The logged-then-continued is a category-B (suspicious). Below threshold.
**Lesson**: if the constitution lists a forbidden pattern (silent error swallowing) and you find it, that dimension fails regardless of other strengths.

---

### Test Coverage

#### Example T-001 — Tests that only assert "renders without crash"
**Scenario**: Component has 3 unit tests. All pass. All look like `it('renders', () => { render(<X />); expect(screen.getByRole('button')).toBeInTheDocument(); })`.
**Wrong score**: 7/10 — "tests pass, coverage exists"
**Right score**: 4/10 — calibration benchmark: "Tests exist but only check 'component renders' → 4/10". These tests verify the component imports and mounts, nothing else. They give no confidence that the behaviour is correct. Below threshold.
**Lesson**: count behaviours tested, not test files. Three "renders" tests = 1 behaviour tested (the component imports).

#### Example T-002 — TDD evidence missing in git log
**Scenario**: All ACs have unit tests. All tests pass. Git log shows the implementation file was created in commit X, the test file was created in commit X+3, with no test commits between. This means tests were written AFTER implementation.
**Wrong score**: 8/10 — "tests exist and pass"
**Right score**: 5/10 — TDD requires test-before-impl per constitution. Test-after tests are biased toward what was built (they test the implementation, not the contract). Below threshold by ~2 points specifically because the absence of test-before evidence is a process failure visible in git.
**Lesson**: test-before is verifiable from git. Always check `git log --oneline --name-only` for the order. If tests come after, score accordingly.

#### Example T-003 — Skipped tests in scope
**Scenario**: Test suite reports "12 passing, 0 failing, 4 skipped." The 4 skipped tests were previously passing — Generator added `.skip()` to make a refactor pass. The skipped tests cover ACs in this feature's scope.
**Wrong score**: 6/10 — "12 pass is decent, the skips are temporary"
**Right score**: 3/10 — this is a reward-hacking pattern. Skipped tests in scope = coverage regression masked by green output. Per the Step 4.5 reward-hacking scan in this prompt, this is a CRITICAL finding regardless of headline score. Fail the feature; the Generator must un-skip and fix.
**Lesson**: skip-to-green is reward hacking. Skipped tests in scope are never acceptable without a documented external-dependency reason.

---

### Product Depth

#### Example P-001 — Empty state = blank page
**Scenario**: Bookmark list. Has bookmarks → renders cards. Has no bookmarks → blank white page, no message, no CTA.
**Wrong score**: 6/10 — "core functionality works"
**Right score**: 4/10 — empty state is one of the most common UI states (every list has it on first load) and the product treats it as not-implemented. Calibration benchmark from criteria.md anti-patterns: "empty state is a blank page". Below threshold.
**Lesson**: every list/grid has at least 4 states (loading, empty, partial, full). Missing any of them = not done.

#### Example P-002 — Form loses input on validation error
**Scenario**: 6-field signup form. User fills all 6. Submits with mismatched passwords. Validation error renders correctly. Fields 4-6 are now blank.
**Wrong score**: 7/10 — "validation logic correct"
**Right score**: 4/10 — re-typing fields after a validation error is a UX failure that real users notice immediately. The product technically validates correctly but provides no preserve-on-error scaffolding. Below threshold.
**Lesson**: product depth = grading the user's experience. If the user notices it's worse than competitors, points off.

#### Example P-003 — Overall solid but no edge handling
**Scenario**: All flows work, code is clean, tests are real, UI states are present. Search works for short queries; for queries > 100 chars, the API returns 500 and the UI shows a generic spinner forever.
**Wrong score**: 9/10 — "everything checked works"
**Right score**: 7/10 — calibration benchmark: "App works perfectly for all flows tested → 8 (something is probably hiding)". The unhandled long-input case is the "something hiding". Drop from gut-9 to calibrated-7. Above threshold but signals room to grow.
**Lesson**: 9 and 10 are rare scores. If your gut says 9 and you can't think of an edge case, you haven't tested enough.

---

## Cross-cutting patterns

### Pattern: "Happy path only" scoring (anti-pattern)
When the Evaluator tests only the primary flow and gives a high score, that's a systematic failure mode. Any score ≥7 given without edge case testing should be reduced by 2.

### Pattern: Counting vs averaging
Code quality, test coverage, and product depth are NOT averages. A single category-A violation (mega-function, empty catch, no-op test, missing empty state) drops the dimension below threshold even if the rest of the work is exemplary. Don't soften an objective failure with subjective overall positivity.

### Pattern: Reward-hacking signals
Tests skipped, tests deleted, tests modified in same commit as code: these are detectable from git log and patch diffs. Per Step 4.5 of EVALUATE mode, every match is at minimum MAJOR; skip-to-green of in-scope tests is CRITICAL. The Generator's score on Test Coverage cannot be high if reward-hacking signals are present.

---

## Adding new examples

When `/harness:tune-evaluator` runs and the human flagged a divergence, append the new example below the cross-cutting patterns section. Use the format:

```
### Example [F|Q|T|P]-NNN — [short title]
**Scenario**: [what was tested, what was observed]
**Wrong score**: X/10 — [why this feels right but is wrong]
**Right score**: Y/10 — [the correct score and specific reasoning]
**Lesson**: [the general principle this example teaches]
```

Number examples sequentially within each criterion (F-001, F-002, ...). Keep cross-criterion patterns in the cross-cutting section.
