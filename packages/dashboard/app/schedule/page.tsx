/**
 * Schedule screen (FR-006 AC-006-2 #3 + AC-006-5).
 *
 * Today's per-pair sessions with countdowns + a "Force Re-plan" button
 * that POSTs to /api/overrides/replan via the CSRF-protected client form.
 */

import { getAgentState, getTodaySchedule } from '@caishen/db/queries/overview';
import { ForceReplanForm } from '../_components/force-replan-form';

export const dynamic = 'force-dynamic';

function todayUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}

export default async function SchedulePage(): Promise<React.ReactElement> {
  const today = todayUtc();
  let schedule: Awaited<ReturnType<typeof getTodaySchedule>> = [];
  let agent: Awaited<ReturnType<typeof getAgentState>> = {
    pausedBool: false,
    pausedAt: null,
  };
  let loadError: string | null = null;

  try {
    const { getTenantDb } = await import('@caishen/db/client');
    const db = getTenantDb(1);
    [schedule, agent] = await Promise.all([getTodaySchedule(db, today), getAgentState(db)]);
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  }

  return (
    <main>
      <div className="page-head">
        <h1>Schedule</h1>
        <span className="meta">{today}</span>
      </div>

      {agent.pausedBool ? (
        <p className="banner banner-yellow">
          Agent is paused. Schedules will not fire until /resume + /replan.
        </p>
      ) : null}

      {loadError ? (
        <p className="error">Couldn't load schedule: {loadError}</p>
      ) : (
        <table className="t-table">
          <thead>
            <tr>
              <th>Pair</th>
              <th>Session</th>
              <th>Start (GMT)</th>
              <th>End (GMT)</th>
              <th>Status</th>
              <th>Countdown</th>
            </tr>
          </thead>
          <tbody>
            {schedule.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  No sessions scheduled.
                </td>
              </tr>
            ) : (
              schedule.map((s) => (
                <tr key={s.id}>
                  <td className="pair" data-label="Pair">
                    {s.pairCode}
                  </td>
                  <td data-label="Session">{s.sessionName}</td>
                  <td className="num" data-label="Start">
                    {formatTime(s.startTimeGmt)}
                  </td>
                  <td className="num" data-label="End">
                    {formatTime(s.endTimeGmt)}
                  </td>
                  <td className={`status-${s.status}`} data-label="Status">
                    {s.status}
                  </td>
                  <td className={`countdown countdown-${s.status}`} data-label="Countdown">
                    {s.countdown}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}

      <section className="section">
        <header className="section-head">
          <h2>Override</h2>
          <span className="section-meta">force a fresh Planner fire (cap-confirm gated)</span>
        </header>
        <ForceReplanForm />
      </section>
    </main>
  );
}

function formatTime(d: Date | null): string {
  if (d === null) return '—';
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(11, 16);
}
