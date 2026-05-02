/**
 * History screen (FR-006 AC-006-2 #4 + FR-015 read paths).
 *
 * Last 50 orders, filterable by date via search params (?from=YYYY-MM-DD &
 * to=YYYY-MM-DD). When `from` is older than AUDIT_HOT_DAYS (default 365),
 * the route delegates to /api/history/archive/[YYYY-MM] which mints a
 * signed Vercel Blob URL (R6 cold-archive transparent fetch). The Blob
 * minter is mocked at the route level until BLOB_READ_WRITE_TOKEN is
 * available; tests assert the route returns a signed URL shape.
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
      <main className="history-page">
        <h1>History</h1>
        <p className="muted">
          Date {params.from} is older than {hotDays} hot-tier days. Cold-archive view:
        </p>
        <p>
          <a href={`/api/history/archive/${yyyymm}`} className="archive-link">
            Open archived month {yyyymm}
          </a>
        </p>
        <style>{historyStyles}</style>
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
    <main className="history-page">
      <header>
        <h1>History</h1>
        <p className="muted">Last 50 orders</p>
      </header>

      <form className="filter" method="get">
        <label>
          From
          <input type="date" name="from" defaultValue={params.from ?? ''} />
        </label>
        <label>
          To
          <input type="date" name="to" defaultValue={params.to ?? ''} />
        </label>
        <button type="submit">Apply</button>
      </form>

      {loadError ? (
        <p className="error">Couldn't load history: {loadError}</p>
      ) : (
        <table className="history-table">
          <thead>
            <tr>
              <th>Opened (GMT)</th>
              <th>Pair</th>
              <th>Type</th>
              <th>Vol</th>
              <th>Price</th>
              <th>P&L</th>
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
                  <td>{t.openedAt ? new Date(t.openedAt).toISOString().slice(0, 16) : '—'}</td>
                  <td className="pair">{t.pair}</td>
                  <td>{t.type}</td>
                  <td>{t.volume ?? '—'}</td>
                  <td>{t.price ?? '—'}</td>
                  <td className={pnlClass(t.pnl)}>{t.pnl ?? '—'}</td>
                  <td>{t.status}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}

      <style>{historyStyles}</style>
    </main>
  );
}

function pnlClass(pnl: string | null): string {
  if (pnl === null) return 'pnl-zero';
  const n = Number(pnl);
  if (Number.isNaN(n) || n === 0) return 'pnl-zero';
  return n > 0 ? 'pnl-pos' : 'pnl-neg';
}

const historyStyles = `
  .history-page { padding: 2rem; max-width: 1100px; margin: 0 auto; }
  .filter { display: flex; gap: 1rem; align-items: end; margin: 1rem 0; }
  .filter label { display: flex; flex-direction: column; font-size: 0.875rem; color: #9ca3af; }
  .filter input, .filter button { padding: 0.5rem 0.75rem; border-radius: 6px; border: 1px solid #1f2937;
    background: #0b1220; color: #f3f4f6; }
  .filter button { background: #1f2937; cursor: pointer; font-weight: 600; }
  .history-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  .history-table th, .history-table td { padding: 0.5rem 0.75rem; text-align: left;
    border-bottom: 1px solid #1f2937; }
  .history-table thead th { color: #9ca3af; font-weight: 500; font-size: 0.875rem; }
  .pnl-pos { color: #10b981; }
  .pnl-neg { color: #ef4444; }
  .pnl-zero { color: #6b7280; }
  .pair { font-weight: 600; }
  .muted { color: #6b7280; }
  .error { color: #ef4444; }
  .archive-link { color: #6366f1; }
`;
