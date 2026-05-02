/**
 * Per-pair Detail screen (FR-006 AC-006-2 #2).
 *
 * Surfaces the latest executor reports + trades for a single pair plus
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
    <main>
      <div className="page-head">
        <h1>
          <span className="mono">{pair}</span>
        </h1>
        <span className="meta">pair detail · {today}</span>
      </div>

      {loadError ? <p className="error">Couldn't load: {loadError}</p> : null}

      <section className="section">
        <header className="section-head">
          <h2>Today sessions</h2>
        </header>
        {schedule.length === 0 ? (
          <p className="muted">No sessions scheduled today for {pair}.</p>
        ) : (
          <ul className="kv-list">
            {schedule.map((s) => (
              <li key={s.id}>
                <span className="label">{s.sessionName}</span>
                <span className={`status-${s.status}`}>{s.status}</span>
                <span className={`countdown countdown-${s.status}`}>{s.countdown}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="section">
        <header className="section-head">
          <h2>Recent reports</h2>
          <span className="section-meta">last 30</span>
        </header>
        {reports.length === 0 ? (
          <p className="muted">No executor reports for {pair} yet.</p>
        ) : (
          <ul className="kv-list" style={{ gridTemplateColumns: '11ch 8ch 1fr auto' }}>
            {reports.map((r) => (
              <li key={r.id}>
                <span className="label">{new Date(r.createdAt).toISOString().slice(0, 10)}</span>
                <span className="label">{new Date(r.createdAt).toISOString().slice(11, 16)}</span>
                <span>{r.actionTaken ?? '—'}</span>
                {r.reportMdBlobUrl ? (
                  <a href={`/api/reports/${r.id}`}>open</a>
                ) : (
                  <span className="subtle">no blob</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="section">
        <header className="section-head">
          <h2>Recent orders</h2>
          <span className="section-meta">last 30</span>
        </header>
        {trades.length === 0 ? (
          <p className="muted">No orders for {pair} yet.</p>
        ) : (
          <table className="t-table">
            <thead>
              <tr>
                <th>Opened</th>
                <th>Type</th>
                <th>Vol</th>
                <th>Price</th>
                <th>P&amp;L</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id}>
                  <td className="num" data-label="Opened">
                    {t.openedAt ? new Date(t.openedAt).toISOString().slice(0, 16) : '—'}
                  </td>
                  <td data-label="Type">{t.type}</td>
                  <td className="num" data-label="Vol">
                    {t.volume ?? '—'}
                  </td>
                  <td className="num" data-label="Price">
                    {t.price ?? '—'}
                  </td>
                  <td className="num" data-label="P&amp;L">
                    {t.pnl ?? '—'}
                  </td>
                  <td data-label="Status">{t.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
