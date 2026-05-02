/**
 * Schedule screen (FR-006 AC-006-2 #3 + AC-006-5).
 *
 * Today's per-pair sessions with countdowns + a "Force Re-plan" button that
 * POSTs to /api/overrides/replan via the CSRF-protected client form.
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
    <main className="schedule-page">
      <header>
        <h1>Schedule — {today} GMT</h1>
        {agent.pausedBool ? (
          <p className="warn">Agent is paused — schedules will not fire until resumed.</p>
        ) : null}
      </header>

      {loadError ? (
        <p className="error">Couldn't load schedule: {loadError}</p>
      ) : (
        <table className="schedule-table">
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
                  No sessions scheduled for today.
                </td>
              </tr>
            ) : (
              schedule.map((s) => (
                <tr key={s.id}>
                  <td className="pair">{s.pairCode}</td>
                  <td>{s.sessionName}</td>
                  <td>{formatTime(s.startTimeGmt)}</td>
                  <td>{formatTime(s.endTimeGmt)}</td>
                  <td className={`status status-${s.status}`}>{s.status}</td>
                  <td>{s.countdown}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}

      <section className="actions">
        <ForceReplanForm />
      </section>

      <style>{`
        .schedule-page { padding: 2rem; max-width: 1100px; margin: 0 auto; }
        .schedule-table { width: 100%; border-collapse: collapse; margin: 1.5rem 0; }
        .schedule-table th, .schedule-table td { padding: 0.5rem 0.75rem; text-align: left;
          border-bottom: 1px solid #1f2937; font-variant-numeric: tabular-nums; }
        .schedule-table thead th { color: #9ca3af; font-weight: 500; font-size: 0.875rem; }
        .pair { font-weight: 600; }
        .status-cancelled { color: #ef4444; }
        .status-skipped_no_window { color: #6b7280; }
        .status-fired { color: #10b981; }
        .status-scheduled { color: #6366f1; }
        .warn { color: #fdba74; }
        .error { color: #ef4444; }
        .muted { color: #6b7280; }
        .actions { margin-top: 2rem; padding-top: 1.5rem; border-top: 1px solid #1f2937; }
      `}</style>
    </main>
  );
}

function formatTime(d: Date | null): string {
  if (d === null) return '—';
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(11, 16);
}
