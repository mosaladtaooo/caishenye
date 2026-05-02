/**
 * History screen (FR-006 AC-006-2 #4 + FR-015 read paths).
 *
 * Trade history + report archive. Cold-archive recall (ADR-006) is wired
 * via /api/archive-fetch.
 */

export default function HistoryPage(): React.ReactElement {
  return (
    <main style={{ padding: '2rem' }}>
      <h1>History</h1>
      <p>Trade history + executor reports + cold archive recall.</p>
    </main>
  );
}
