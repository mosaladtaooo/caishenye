/**
 * Per-pair Detail screen (FR-006 AC-006-2 #2).
 *
 * Surfaces the latest executor reports + trades for a single pair, plus
 * today's scheduled sessions for it.
 */

import { getRecentReports, getRecentTrades, getTodaySchedule } from '@caishen/db/queries/overview';

export const dynamic = 'force-dynamic';

interface PairPageProps {
  params: Promise<{ pair: string }>;
}

function todayUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}

export default async function PairDetailPage(props: PairPageProps): Promise<React.ReactElement> {
  const { pair: rawPair } = await props.params;
  const pair = decodeURIComponent(rawPair);
  const today = todayUtc();

  let reports: Awaited<ReturnType<typeof getRecentReports>> = [];
  let trades: Awaited<ReturnType<typeof getRecentTrades>> = [];
  let schedule: Awaited<ReturnType<typeof getTodaySchedule>> = [];
  let loadError: string | null = null;
  try {
    const { getTenantDb } = await import('@caishen/db/client');
    const db = getTenantDb(1);
    [reports, trades, schedule] = await Promise.all([
      getRecentReports(db, 30, pair),
      getRecentTrades(db, 30),
      getTodaySchedule(db, today),
    ]);
    trades = trades.filter((t) => t.pair === pair);
    schedule = schedule.filter((s) => s.pairCode === pair);
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  }

  return (
    <main className="pair-page">
      <header>
        <h1>
          <span className="pair">{pair}</span>
        </h1>
      </header>

      {loadError ? <p className="error">Couldn't load pair detail: {loadError}</p> : null}

      <section>
        <h2>Today's sessions</h2>
        {schedule.length === 0 ? (
          <p className="muted">No sessions scheduled today for {pair}.</p>
        ) : (
          <ul>
            {schedule.map((s) => (
              <li key={s.id}>
                {s.sessionName} — {s.status} ({s.countdown})
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Recent reports</h2>
        {reports.length === 0 ? (
          <p className="muted">No executor reports for {pair} yet.</p>
        ) : (
          <ul className="reports-list">
            {reports.map((r) => (
              <li key={r.id}>
                <header>
                  <strong>{new Date(r.createdAt).toISOString()}</strong> · {r.session} ·{' '}
                  {r.actionTaken ?? '—'}
                </header>
                {r.summaryMd ? (
                  <p className="summary">{r.summaryMd.slice(0, 320)}</p>
                ) : (
                  <p className="muted">(no summary)</p>
                )}
                {r.reportMdBlobUrl ? <a href={`/api/reports/${r.id}`}>Open full report</a> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Recent orders</h2>
        {trades.length === 0 ? (
          <p className="muted">No orders for {pair} in recent history.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Opened</th>
                <th>Type</th>
                <th>Vol</th>
                <th>Price</th>
                <th>P&L</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id}>
                  <td>{t.openedAt ? new Date(t.openedAt).toISOString().slice(0, 16) : '—'}</td>
                  <td>{t.type}</td>
                  <td>{t.volume ?? '—'}</td>
                  <td>{t.price ?? '—'}</td>
                  <td>{t.pnl ?? '—'}</td>
                  <td>{t.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <style>{`
        .pair-page { padding: 2rem; max-width: 900px; margin: 0 auto; }
        .pair-page h1 { letter-spacing: -0.02em; }
        .pair { font-weight: 700; }
        .pair-page section { margin: 2rem 0; }
        .pair-page section h2 { font-size: 1rem; color: #9ca3af; font-weight: 500; }
        .reports-list { list-style: none; padding: 0; display: grid; gap: 1rem; }
        .reports-list li { padding: 1rem; border: 1px solid #1f2937; border-radius: 8px; background: #0b1220; }
        .reports-list header { font-size: 0.875rem; color: #9ca3af; margin-bottom: 0.5rem; }
        .summary { font-size: 0.875rem; color: #d1d5db; }
        table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
        th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid #1f2937; }
        th { color: #9ca3af; font-weight: 500; font-size: 0.875rem; }
        .muted { color: #6b7280; }
        .error { color: #ef4444; }
      `}</style>
    </main>
  );
}
