/**
 * History screen (FR-006 AC-006-2 #4 + FR-015 read paths).
 *
 * Last 50 orders, filterable by date via search params (?from=YYYY-MM-DD &
 * to=YYYY-MM-DD). When `from` is older than AUDIT_HOT_DAYS (default 365),
 * the route delegates to /api/history/archive/[YYYY-MM] which mints a
 * signed Vercel Blob URL (R6 cold-archive transparent fetch).
 */

import { getRecentTrades } from '@caishen/db/queries/overview';

export const dynamic = 'force-dynamic';

interface HistoryPageProps {
  searchParams: Promise<{ from?: string; to?: string }>;
}

const AUDIT_HOT_DAYS_DEFAULT = 365;

function isCold(fromDate: string | undefined, hotDays: number): boolean {
  if (!fromDate) return false;
  const from = Date.parse(fromDate);
  if (Number.isNaN(from)) return false;
  const ageDays = (Date.now() - from) / (24 * 3_600_000);
  return ageDays > hotDays;
}

export default async function HistoryPage(props: HistoryPageProps): Promise<React.ReactElement> {
  const params = await props.searchParams;
  const hotDays = parseInt(process.env.AUDIT_HOT_DAYS ?? String(AUDIT_HOT_DAYS_DEFAULT), 10);
  const cold = isCold(params.from, hotDays);

  if (cold && params.from) {
    const yyyymm = params.from.slice(0, 7); // YYYY-MM
    return (
      <main>
        <div className="page-head">
          <h1>History · cold archive</h1>
          <span className="meta">{params.from}</span>
        </div>
        <p className="muted">
          The requested date is older than {hotDays} hot-tier days. The trade history is in
          cold-archive storage:
        </p>
        <p>
          <a href={`/api/history/archive/${yyyymm}`}>Open archived month {yyyymm}</a>
        </p>
      </main>
    );
  }

  let trades: Awaited<ReturnType<typeof getRecentTrades>> = [];
  let loadError: string | null = null;
  try {
    const { getTenantDb } = await import('@caishen/db/client');
    trades = await getRecentTrades(getTenantDb(1), 50);
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  }

  return (
    <main>
      <div className="page-head">
        <h1>History</h1>
        <span className="meta">last 50 orders</span>
      </div>

      {/* Server-component form: useId is N/A here, single instance. */}
      <form method="get" style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end' }}>
        <div className="field">
          <label htmlFor="history-from">From</label>
          {/* biome-ignore lint/correctness/useUniqueElementIds: server component, single instance */}
          <input id="history-from" type="date" name="from" defaultValue={params.from ?? ''} />
        </div>
        <div className="field">
          <label htmlFor="history-to">To</label>
          {/* biome-ignore lint/correctness/useUniqueElementIds: server component, single instance */}
          <input id="history-to" type="date" name="to" defaultValue={params.to ?? ''} />
        </div>
        <button type="submit" className="btn btn-primary">
          Apply
        </button>
      </form>

      {loadError ? (
        <p className="error" style={{ marginTop: '1rem' }}>
          Couldn't load history: {loadError}
        </p>
      ) : (
        <table className="t-table" style={{ marginTop: '1.5rem' }}>
          <thead>
            <tr>
              <th>Opened (GMT)</th>
              <th>Pair</th>
              <th>Type</th>
              <th>Vol</th>
              <th>Price</th>
              <th>P&amp;L</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {trades.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted">
                  No orders yet.
                </td>
              </tr>
            ) : (
              trades.map((t) => (
                <tr key={t.id}>
                  <td className="num" data-label="Opened">
                    {t.openedAt ? new Date(t.openedAt).toISOString().slice(0, 16) : '—'}
                  </td>
                  <td className="pair" data-label="Pair">
                    {t.pair}
                  </td>
                  <td data-label="Type">{t.type}</td>
                  <td className="num" data-label="Vol">
                    {t.volume ?? '—'}
                  </td>
                  <td className="num" data-label="Price">
                    {t.price ?? '—'}
                  </td>
                  <td className={`num ${pnlClass(t.pnl)}`} data-label="P&amp;L">
                    {t.pnl ?? '—'}
                  </td>
                  <td data-label="Status">{t.status}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}
    </main>
  );
}

function pnlClass(pnl: string | null): string {
  if (pnl === null) return 'pnl-zero';
  const n = Number(pnl);
  if (Number.isNaN(n) || n === 0) return 'pnl-zero';
  return n > 0 ? 'pnl-pos' : 'pnl-neg';
}
