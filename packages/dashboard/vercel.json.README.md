# vercel.json — sibling notes

Per **AC-005-2 amendment** (ADR-011), this file lists ONLY daily-frequency
crons. The two sub-daily crons (5-min channels-session cross-check and
30-min synthetic-ping) live as GitHub Actions workflows under
`/.github/workflows/cron-channels-health.yml` and
`/.github/workflows/cron-synthetic-ping.yml`, because Vercel Hobby plan
(which the project targets per cost-target line in the contract) blocks
sub-daily Vercel cron entries.

The Next.js handlers under `app/api/cron/*` are unchanged regardless of
trigger source — same auth gate (`lib/cron-auth.ts` validates
`Authorization: Bearer ${CRON_SECRET}`), same business logic.

If the project ever moves to Vercel Pro, the two sub-daily entries can be
re-added here verbatim per the contract's pre-amendment design.

See:

- `.harness/progress/decisions.md` ADR-011 — full rationale
- `.harness/features/001-foundation-routines-channels-dashboard/contract.md`
  § "Cron schedule" + § "GitHub Actions cron workflows"
- `tests/cron-workflows.test.ts` — schedule-string regression guard
