/**
 * Schedule screen (FR-006 AC-006-2 #3).
 *
 * Today's pair_schedules + force re-plan button (which becomes wired in M4
 * step 22 once FR-018 ships).
 */

export default function SchedulePage(): React.ReactElement {
  return (
    <main style={{ padding: '2rem' }}>
      <h1>Schedule</h1>
      <p>Today's per-pair sessions + countdowns. Force re-plan lands in M4.</p>
    </main>
  );
}
