/**
 * Override Panel (FR-006 AC-006-2 #5).
 *
 * In M3 read-only this page renders BUT all action buttons 404 until M4
 * step 20 wires the corresponding /api/overrides/* route handlers.
 *
 * Per the contract: scaffolding ships in M3 step 17–18; live override
 * actions (close-pair, close-all, edit SL/TP, pause, resume, replan) and
 * their CSRF protection land in M4 step 20.
 */

export default function OverridesPage(): React.ReactElement {
  return (
    <main style={{ padding: '2rem' }}>
      <h1>Override Panel</h1>
      <p style={{ color: '#888' }}>
        Override actions ship in M4. The form scaffolds are here; the POST handlers route 404 until
        then.
      </p>
    </main>
  );
}
