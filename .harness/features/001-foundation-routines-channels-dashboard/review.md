<!-- BELCORT Harness — Proposal Review — Round 3 (FINAL) -->

# Proposal Review — Round 3 (final negotiation round)

**Date**: 2026-05-02
**Round**: 3 of max 3
**VERDICT**: agreed

## Summary

Round 3 cleanly resolves the one BLOCKING item (R6 CSRF cryptographic primitive) and both non-blocking follow-ons (R3-followup transactional boundary, R5-followup synthetic-ping doc loop). The proposal is now ready for FINALIZE-CONTRACT.

The R6 fix went further than the Round 2 review demanded — instead of validating Auth.js's own CSRF cookie with the corrected HMAC primitive, the Generator chose to issue a self-controlled HMAC-signed CSRF cookie via `GET /api/csrf`, decoupling the dashboard's CSRF check from Auth.js library internals entirely. The deviation rationale (Auth.js v5 cookie format is library-internal, the cookie was renamed in v5, the encryption story has changed) is sound. Independent verification via Context7 confirms the v5 cookie rename (`next-auth.csrf-token` → `authjs.csrf-token`). The resulting design follows the canonical OWASP signed-double-submit-cookie pattern and is verifiable end-to-end without Auth.js library cooperation. The unit-test fixture pins the algorithm in two directions (rejects Round 2's broken concat-hash AND rejects wrong-secret HMAC), so any silent BUILD drift to a different primitive trips the test before any Playwright cycle.

R3-followup adopts the split-transaction design exactly as the Round 2 review outlined. The failure-mode table covers all four critical points (Tx A fail, `/fire` POST fail, `/fire` 200-but-response-dropped, Tx B fail) with deterministic post-states and recovery procedures. Two new test cases extend `replan-cleanup.test.ts` from 4 to 6 cases.

R5-followup is a documentary tightening (no code change), and the 5-step walkthrough correctly traces the synthetic-ping flow through the wrapper-script path, demonstrating that `replied_at` only gets set when the Channels session actually handles the message — so a dead session leaves the synthetic ping unhandled and `MAX(replied_at)` (which ignores NULL by Postgres semantics) does NOT produce false-healthy.

The 5 new ACs carry through unchanged (AC-002-1-b, AC-003-1-b, AC-007-3-b, AC-016-1-b/2-b/3-b, AC-018-2-b — verified verbatim in the "Proposed-by-Evaluator new ACs" section). No locked decision was re-litigated. The proposal is ready for FINALIZE-CONTRACT.

## Did Generator Address Previous Asks? (Round 3 status table)

| R-ID | Round 2 ask | Round 3 status | Notes |
|---|---|---|---|
| **R1** | Two-tier prompt-preserve (file-side always, deployed-side conditional) | Addressed (Round 2) | Preserved unchanged in Round 3. |
| **R2** | Narrow Channels subagent Write/Read scopes | Addressed (Round 2) | Preserved unchanged in Round 3. |
| **R3** | Re-plan cleanup flow ordering | Addressed (Round 2) | Preserved unchanged in Round 3 (R3-followup is the second-order refinement, addressed below). |
| **R4** | Override `before_state_json` capture | Addressed (Round 2) | Preserved unchanged in Round 3. |
| **R5** | Healthcheck `last_message_handled_at` source | Addressed (Round 2) | Preserved unchanged in Round 3 (R5-followup doc clarification addressed below). |
| **R6** | CSRF primitive correction | **Addressed** | Fully resolved (see R6 detail below). |
| **R3-followup** | Split-transaction for re-plan cleanup | **Addressed** | Fully resolved (see R3-followup detail below). |
| **R5-followup** | Synthetic-ping not inflating signal | **Addressed** | Fully resolved (see R5-followup detail below). |

## R6 verification — CSRF cryptographic primitive (was BLOCKING)

The Generator chose to deviate slightly from the Round 2 review's outline: rather than validating Auth.js's own CSRF cookie with the corrected HMAC primitive, the proposal issues its own HMAC-signed CSRF cookie via a new `GET /api/csrf` route. I verified each of the five Round 2 acceptance points against Round 3's actual code:

### (a) HMAC primitive is correct

Round 3 `lib/csrf.ts` (line 890):
```typescript
return createHmac('sha256', secret).update(token).digest('hex');
```

This is the canonical HMAC-SHA256 form: `HMAC(key=AUTH_SECRET, message=token)`. The Round 2 broken form (`createHash('sha256').update(token + secret).digest('hex')`) is gone. ✓

### (b) `timingSafeEqual` is used for both comparisons

- Cookie-signature comparison (line 933): `if (!timingSafeEqual(sigA, sigB)) return false;` ✓
- Submitted-token comparison (line 939): `return timingSafeEqual(subBuf, ckBuf);` ✓

Both buffers are length-preflighted before the call (lines 932 and 938), so the `RangeError` Node throws on length mismatch can never fire — the early return covers it. The comment at line 875 explicitly acknowledges this requirement. ✓

### (c) `__Host-` prefix is used in production

- Cookie-name selection (lines 880-883): `process.env.NODE_ENV === 'production' ? '__Host-caishen.csrf-token' : 'caishen.csrf-token'`. ✓
- `__Host-` prefix prerequisites per RFC 6265bis: `Path=/` (line 903), `Secure` set when production (line 904), no `Domain` attribute set in `.set()` options. All three present. ✓
- Test #8 at lines 1064-1073 explicitly asserts the dev-named cookie is REJECTED in production mode — pinning the prefix logic. ✓

### (d) Unit test rejects the old broken concat-hash AND a wrong-secret HMAC

Both anti-drift tests are present:

- Test #2 (lines 1026-1034): computes a signature using the Round 2 broken algorithm `createHash('sha256').update(FIXED_TOKEN + FIXED_SECRET).digest('hex')` and asserts `validateCsrf` returns `false`. This is the primary anti-drift pin — if BUILD silently regresses to the Round 2 form, this test fails at unit-test time. ✓
- Test #3 (lines 1036-1042): computes a signature with HMAC-SHA256 keyed with `'WRONG_SECRET'` (the right primitive, the wrong key) and asserts `validateCsrf` returns `false`. This pins the HMAC key to `AUTH_SECRET`. ✓

The fixture's known-good signature is computed by `createHmac('sha256', FIXED_SECRET).update(FIXED_TOKEN).digest('hex')` directly in the test file (line 1011-1013) — so the test is self-validating. If the production code's algorithm drifts, the test breaks immediately.

### (e) Auth.js-decoupling rationale is sound

The proposal's decoupling rationale rests on three claims:
1. Auth.js v5 renamed the cookie from `next-auth.csrf-token` to `authjs.csrf-token`.
2. Auth.js v5 stores the CSRF token in an encrypted cookie that's brittle to verify externally.
3. Library-internal CSRF cookie formats can change between minor versions.

Independent verification via Context7 (`/websites/authjs_dev` and `/nextauthjs/next-auth`):

- **Cookie rename — confirmed.** The Auth.js v5 migration doc explicitly states: "The `next-auth` prefix used for cookies is now renamed to `authjs`, reflecting the broader rebranding and consolidation of the authentication library across different frameworks." ✓
- **JWE encryption — partially confirmed.** Context7 confirms Auth.js uses "JWE with A256CBC-HS512 encryption" but explicitly for *JWTs*, not necessarily for the CSRF cookie specifically. The proposal's claim at line 852 that "Auth.js v5 stores its CSRF token in an encrypted JWE cookie (A256CBC-HS512)" is plausible but slightly imprecise — Auth.js historically used a `token|hash` plain-text format for the CSRF cookie. This minor doc-level imprecision does not affect the implementation correctness or the design's soundness; the broader claim ("Auth.js's internal CSRF cookie format is a library-internal implementation detail brittle to verify from outside") is unambiguously correct. The conclusion (decouple to a self-issued HMAC cookie) is canonically correct under OWASP's signed-double-submit-cookie pattern regardless of the exact Auth.js cookie format. **Not blocking** — the Generator should not amend the proposal text in Round 3, and the implementation is independent of this nuance.
- **Library-internal change risk — confirmed by inference.** Auth.js v5 already changed the cookie name from v4 (rename above), demonstrating the Generator's premise that library-internal cookie schemas are not API-stable across major versions. ✓

The deviation also tightens the security posture: the new `GET /api/csrf` route gates token issuance on `auth()` returning a session (line 953-954 returns 401 for unauthenticated requests), so CSRF tokens can only be obtained by an already-authenticated user. The Round 2 design (validate Auth.js's own cookie) had the same property indirectly; Round 3 keeps it explicitly.

The unit test at lines 1058-1062 verifies the round-trip: `issueCsrfToken()` output passes `validateCsrf()`. Combined with tests #2 and #3 pinning the algorithm in two directions, the BUILD cannot silently drift the primitive without breaking unit tests. ✓

**R6 verdict: addressed correctly with a sound deviation.** The deviation reduces brittleness against Auth.js library internals, the implementation is canonically OWASP-correct, and the unit-test fixture provides explicit anti-drift pins. No further revision needed.

## R3-followup verification — split transaction (was non-blocking)

The Round 3 design adopts the Round 2 review's outline almost line-for-line:

- **Tx A** (lines 577-604): two writes only (cancel old rows + insert in-flight audit row with `success=null`). No remote calls inside. Locks held for ~1ms total. ✓
- **External `/fire` POST** (lines 612-619): outside both transactions. Failure captured into `fireErr` rather than propagating immediately. ✓
- **Tx B** (lines 627-648): two writes only (settle audit row to `success=true|false` with `after_state_json` populated). Locks held for ~1ms total. ✓

The failure-mode table (lines 668-673) covers all four critical points the Round 2 review demanded:

1. **Tx A fails** — no cancellation, no audit row, no `/fire` call. Operator retries; idempotent. ✓
2. **`/fire` POST fails** (timeout, 5xx, network blip) — old rows cancelled; audit row stays in-flight; Tx B catches `fireErr` and settles audit to `success=false`. Operator sees error toast and retries. Stale executors that fire from Anthropic side noop via the R3 pre-fire stale-check. ✓
3. **`/fire` POST succeeds but response is dropped** — old rows cancelled; Anthropic actually fired the Planner; Tx B catches the network error and settles to `success=false` with misleading `error_message`. The Planner's own `routine_runs` row provides ground truth; orphan-detect cron surfaces the disagreement; manual re-trigger is idempotent because Planner sub-action g uses `INSERT ... ON CONFLICT DO UPDATE`. ✓
4. **Tx B fails** — old rows cancelled; audit row stays `success=null`; orphan-detect cron picks up the in-flight row >5min old; operator manually settles after verifying via `routine_runs`. ✓

The race-window analysis at line 675 (Tx B vs Planner sub-action g) correctly observes that Tx B writes only to `override_actions` and Planner writes only to `pair_schedules`, so there's no row-level lock contention.

Two new test cases extend `replan-cleanup.test.ts`:
- Case 5 (line 683): Tx A succeeds, `/fire` rejects → assert `success=false`, `error_message` populated, `cancelled_pair_schedule_ids` populated, audit row settled.
- Case 6 (line 684): Tx A succeeds, `/fire` resolves, Tx B mock-throws → assert audit row stays `success=null` (in-flight), assert orphan-detect cron picks it up after time-warp.

Both cases directly verify the failure-mode behavior. ✓

**R3-followup verdict: addressed exactly as outlined.** The bridging via `success=null` in-flight marker reuses the R4 schema delta and the existing NFR-004 orphan-detect cron — no new infrastructure, just sharper ordering. Implementation is straightforward; tests are deterministic.

## R5-followup verification — synthetic-ping doc clarification (was non-blocking)

The 5-step walkthrough at lines 1172-1187 correctly traces the synthetic-ping flow through the wrapper-script path:

1. Vercel cron POSTs a real TG message via Bot API. **No DB write at this step.**
2. The Channels-session wrapper receives via long-polling.
3. The wrapper inserts `telegram_interactions` row with `received_at = NOW()`, `replied_at = NULL`, `command_parsed = 'SYNTHETIC_PING'`. **`replied_at` is still NULL.**
4. The wrapper hands the message to the Channels-session subagent.
5. **ONLY when** the subagent finishes its reply does the wrapper UPDATE the row to set `replied_at = NOW()`.

Dead-session analysis at lines 1180-1185 walks through what happens if the session is dead at each step — Step 5 never fires, so `replied_at` stays NULL forever for that ping. Combined with the Postgres invariant ("`MAX()` ignores NULL" — correct per ISO/IEC 9075 SQL standard), `MAX(replied_at)` excludes the unhandled synthetic-ping rows entirely.

The proposal correctly observes (line 1191) that no new test is needed because "MAX(replied_at) ignores NULL" is a Postgres invariant, not implementation behavior. Adding a test would be over-engineering.

The one edge case worth naming (line 1189: synthetic-ping replies are visible in the operator's TG history subject to per-channel mute) is correctly identified as intentional — that's what makes the synthetic ping a valid liveness probe.

**R5-followup verdict: addressed cleanly.** Doc loop closed. No code change; no new test. The Round 2 healthcheck design was correct in spirit; Round 3 just makes it explicit why.

## Verification of the 5 new ACs flagged for FINALIZE-CONTRACT (carry-through check)

All 5 ACs preserved verbatim from Round 2's "Proposed-by-Evaluator new ACs" section, traceable in the proposal at:

- **AC-002-1-b** — preserved (line 1543, line 1359 cross-reference); Tier 2 conditional test approach intact.
- **AC-003-1-b** — preserved (line 1359 cross-reference, line 1545); Spartan/Executor mirror of AC-002-1-b.
- **AC-007-3-b** — preserved (line 1381, line 1547); Playwright `overrides-atomicity.spec.ts` test approach intact, `before_state_json` capture verified through R4 7-step flow.
- **AC-016-1-b / -2-b / -3-b** — preserved (lines 1396-1400, line 1549); Round 3 R6 rewrite extends test coverage to add the algorithm-pinning unit test, but the e2e Playwright test wording is unchanged.
- **AC-018-2-b** — preserved (line 1405, line 1551); race-window cleanup test intact.

The proposal's recommendation to FINALIZE-CONTRACT (line 1553-ish) is the correct handoff: add exactly these 5 ACs to the final contract's "Test Criteria (flat list)" section, no other changes needed.

## Did Round 3 break a previously-locked decision?

Spot-check against the 9 ADRs and 18 constitution principles:

| Locked decision | Round 3 deltas | Conflict? |
|---|---|---|
| ADR-001 (Path C hybrid) | unchanged | No |
| ADR-002 (cap-handling contingent on Spike 1) | unchanged | No |
| ADR-003 (Opus 4.7 1M, allow Sonnet downgrade) | unchanged | No |
| ADR-004 (`/fire` API beta header pinned) | unchanged; split-tx design uses the same `/fire` endpoint | No |
| ADR-005 (Tailscale Funnel + bearer) | unchanged | No |
| ADR-006 (365-day audit + cold archive) | unchanged | No |
| ADR-007 (direct Telegram Bot API) | unchanged; CSRF change is dashboard-side only | No |
| ADR-008 (local-counters cap source) | unchanged | No |
| ADR-009 (restart-on-idle) | unchanged | No |
| Constitution §1 (no API key) | unchanged | No |
| Constitution §2 (prompt preserve) | Round 2's two-tier test preserved unchanged in Round 3 | No |
| Constitution §3 (audit-or-abort) | R3-followup split-tx still wraps both txs inside `withAuditOrAbort` (line 570); audit boundary preserved | No (improvement) |
| Constitution §4 (multi-tenant) | unchanged; new `/api/csrf` route follows tenant-scoped session pattern | No |
| Constitution §11 (override audits) | R3-followup keeps full §11 surface (`before_state_json`, `after_state_json`, `success`, `error_message`); failure-mode table makes recovery paths explicit | No (improvement) |
| Constitution §17 (forbidden patterns) | New `csrf.ts` is clean: no `any`, no `console.log`, no silent catch; `crypto.timingSafeEqual` is the canonical primitive | No |

No locked decision was re-litigated. Round 3's three changes are all surgical refinements within the gaps Round 2 left.

## Risk Flags — Round 3 review

Generator updated Risk Flag #10 (CSRF token rotation) at line 1124: because the dashboard now owns CSRF cookie issuance, rotation only happens on form-mount fetches of `/api/csrf`, not on Auth.js session refresh. The narrowed risk is "user opens form, lets it sit >12h (`maxAge`), then submits → 403 on submit, retry-once recovers". This is acceptable. **Accept.**

Risk Flag #11 (running-Executor edge during re-plan) preserved from Round 2 — design intent. **Accept.**

No new flags introduced in Round 3.

## Calibration check

Per the Evaluator anti-leniency protocol: am I rubber-stamping Round 3, or is approval genuinely warranted?

**Test 1 — would I be comfortable shipping with Round 3's CSRF code?** Yes. The HMAC primitive is canonical, `timingSafeEqual` is correctly used, the `__Host-` prefix is correctly handled, and the unit-test fixture pins the algorithm in two directions (rejects Round 2's broken form AND rejects wrong-key HMAC). The deviation from "validate Auth.js's own cookie" to "issue our own cookie" is well-reasoned and reduces brittleness against library internals. The implementation is OWASP-compliant.

**Test 2 — would I be comfortable shipping with Round 3's split-tx design?** Yes. The failure-mode table covers all four critical points with deterministic post-states. The bridge via `success=null` reuses existing R4 + NFR-004 infrastructure. Lock duration is bounded to ~1ms × 2 transactions, well below any reasonable connection-pool sizing constraint. Two new test cases cover the new failure modes.

**Test 3 — would I be comfortable shipping with Round 3's R5 doc?** Yes. The 5-step walkthrough is correct; the Postgres invariant is correct; no code change is needed. The doc loop is closed.

**Test 4 — am I letting Round-3-of-max-3 pressure me into agreeing?** No. Each of R6, R3-followup, R5-followup is independently verifiable and substantively addressed. If Round 3 had left R6 with a wrong primitive or omitted the anti-drift unit test, I would write `needs-revision` and accept escalation. None of those gaps are present.

**Test 5 — what's the minor doc-imprecision I noted (Auth.js JWE claim) and is it blocking?** The proposal claims at line 852 that "Auth.js v5 stores its CSRF token in an encrypted JWE cookie (A256CBC-HS512)". Context7 confirms Auth.js uses JWE with A256CBC-HS512 for JWTs but doesn't directly confirm the CSRF cookie specifically uses JWE — Auth.js historically used a `token|hash` plain-text format for the CSRF cookie. This is doc-level imprecision in the rationale, not implementation-level. The implementation (issue our own HMAC cookie, decouple from Auth.js) is correct regardless of whether the Auth.js cookie is JWE or `token|hash` — the Generator's broader claim ("library-internal format is brittle to verify externally") holds in both cases. **Not blocking** — fixing this would be a stylistic nit on a 25-line rationale paragraph; the code is correct. I am explicitly choosing not to over-reject on this per the Round 3 Evaluator instruction ("don't withhold approval over stylistic nits at this point").

Approval is warranted on substantive correctness grounds.

## Hand-off to FINALIZE-CONTRACT

Round 3 is the final negotiation round and the verdict is `agreed`. The Generator's next step is FINALIZE-CONTRACT mode:

1. Take the Round 3 `proposal.md` as the committed implementation plan.
2. Take the negotiated draft `contract.md` and add exactly these 5 ACs to the "Test Criteria (flat list for Evaluator)" section:
   - AC-002-1-b (FR-002, Tier 2 deployed-prompt byte-identity)
   - AC-003-1-b (FR-003, Tier 2 Spartan deployed-prompt byte-identity)
   - AC-007-3-b (FR-007, before_state_json captured from real MT5 read pre-mutation)
   - AC-016-1-b / -2-b / -3-b (FR-016, CSRF 403 on missing token across close-pair / close-all / edit-position)
   - AC-018-2-b (FR-018, replan race-window noop when pair_schedules row is cancelled or one-off ID mismatched)
3. Add the `**Negotiated**:` marker at the top of the final `contract.md` per Evaluator EVALUATE-mode contract-finalization gate.
4. No other changes to the contract scope, deliverables, NFRs, or Definition of Done.

Once FINALIZE-CONTRACT lands, BUILD can begin.
