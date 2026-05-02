/**
 * Override Panel (FR-006 AC-006-2 #5).
 *
 * Single-page operator control surface. Five live POSTs to the
 * /api/overrides/* endpoints, each CSRF-gated via the shared
 * OverrideForm component. Listed by destructiveness — least to most.
 */

import { getAgentState, getRecentReports } from '@caishen/db/queries/overview';
import { ForceReplanForm } from '../_components/force-replan-form';
import {
  CloseAllForm,
  ClosePairForm,
  EditPositionForm,
  PauseResumeForm,
} from '../_components/override-forms';

export const dynamic = 'force-dynamic';

export default async function OverridesPage(): Promise<React.ReactElement> {
  let agent: Awaited<ReturnType<typeof getAgentState>> = {
    pausedBool: false,
    pausedAt: null,
  };
  let recentPairs: string[] = [];
  let loadError: string | null = null;
  try {
    const { getTenantDb } = await import('@caishen/db/client');
    const db = getTenantDb(1);
    agent = await getAgentState(db);
    const reports = await getRecentReports(db, 30);
    recentPairs = Array.from(new Set(reports.map((r) => r.pair)));
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  }

  return (
    <main>
      <div className="page-head">
        <h1>Overrides</h1>
        <span className="meta">audit-trailed via override_actions</span>
      </div>

      {loadError ? <p className="error">Couldn't load state: {loadError}</p> : null}

      <p className="muted" style={{ marginBottom: '1rem' }}>
        Every override writes a row to <span className="mono">override_actions</span> with{' '}
        <span className="mono">before_state_json</span> +{' '}
        <span className="mono">after_state_json</span> per the R4 7-step flow. Failures are
        recoverable via <span className="mono">orphan-detect</span>.
      </p>

      <section className="section">
        <header className="section-head">
          <h2>Agent state</h2>
          <span className="section-meta">
            currently{' '}
            {agent.pausedBool ? (
              <span className="pill pill-warn">paused</span>
            ) : (
              <span className="pill pill-ok">active</span>
            )}
          </span>
        </header>
        <PauseResumeForm paused={agent.pausedBool} />
      </section>

      <section className="section">
        <header className="section-head">
          <h2>Force re-plan</h2>
          <span className="section-meta">
            cancels today's not-yet-fired schedules + fires Planner Routine
          </span>
        </header>
        <ForceReplanForm />
      </section>

      <section className="section">
        <header className="section-head">
          <h2>Edit position</h2>
          <span className="section-meta">SL / TP only</span>
        </header>
        <EditPositionForm />
      </section>

      <section className="section">
        <header className="section-head">
          <h2>Close pair</h2>
          <span className="section-meta">close all positions for one pair</span>
        </header>
        <ClosePairForm pairs={recentPairs} />
      </section>

      <section className="section">
        <header className="section-head">
          <h2>Close ALL positions</h2>
          <span className="section-meta">requires typed confirmation</span>
        </header>
        <CloseAllForm />
      </section>
    </main>
  );
}
