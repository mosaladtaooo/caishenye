# Evaluator Tuning Log

Append-only record of every divergence between Evaluator judgment and human judgment. Raw material for `/harness:tune-evaluator` to analyze patterns and propose prompt improvements.

## How entries are added

After each `/harness:sprint` evaluation completes, the orchestrator asks: "Do you agree with this evaluation?" If the human says no, or flags specific findings, the divergence is recorded here automatically.

## How entries are used

When 3+ divergences of the same pattern accumulate, `/harness:tune-evaluator` surfaces them and proposes either:
- Adding a calibration example to `examples.md` (for most patterns)
- Updating `evaluator.md` prompt (for systematic behavioral issues)

## Entry schema

Every entry MUST follow this shape. `/harness:tune-evaluator` reads these fields programmatically and will skip malformed entries — keep the field names and divergence-category vocabulary exact.

```markdown
## YYYY-MM-DD — features/NNN-name — <agree | disagree | partial>

### Evaluator's judgment
- Verdict: <PASS | FAIL>
- Scores: F:X/10 Q:X/10 T:X/10 P:X/10
- Key findings: <summary — one or two sentences>

### Human's judgment
- Verdict: <what human thinks it should have been>
- Scores: <what human would give — same F/Q/T/P format>
- Reasoning: <why human disagreed, one sentence>

### Divergence category
<one of: Leniency | Strictness | Missed issue | Overclaim | Wrong severity | Scope confusion | Other>

### Specific diff
- <concrete thing Evaluator got wrong — quote from eval-report.md>
- <concrete thing Evaluator missed — what the human noticed instead>

### Action taken
- [ ] Added example to examples.md (ID: F-NNN | Q-NNN | T-NNN | P-NNN)
- [ ] Added note to spec/evaluator-notes.md
- [ ] Flagged for evaluator.md prompt revision
- [ ] No action (one-off, not a pattern)
```

Divergence-category vocabulary (must be one of exactly these — `/harness:tune-evaluator` greps for them):
- **Leniency** — Evaluator approved something the human thinks should have failed (false PASS)
- **Strictness** — Evaluator failed something the human thinks should have passed (false FAIL)
- **Missed issue** — Evaluator didn't notice a bug the human sees
- **Overclaim** — Evaluator claimed a test passed or a criterion met when it didn't
- **Wrong severity** — Evaluator graded Major when human says Critical (or vice versa)
- **Scope confusion** — Evaluator penalized for or graded something outside the contract
- **Other** — doesn't fit the above; explain in Reasoning

---

## Log entries

_No entries yet._