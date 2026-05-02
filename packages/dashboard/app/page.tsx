/**
 * Dashboard root — Overview screen (FR-006 AC-006-2 #1).
 *
 * Aesthetic: trader's terminal. Sections of a single mission control
 * panel, not identical card widgets. Monospaced numerics for prices,
 * countdowns, P&L. SWR-on-the-client polls /api/overview every 5s for
 * live updates + surfaces stale-state banners (yellow >30s, red >60s)
 * per AC-006-3.
 *
 * Composition (top-to-bottom information density):
 *   1. Page head: agent state pill + GMT date
 *   2. Stale banner (if any)
 *   3. Today's schedule with per-row countdowns
 *   4. Daily cap progress (FR-021 AC-021-2; tier colour-coded)
 *   5. Recent activity feed (last 8 executor reports)
 */

import {
  type CapProgress,
  computeCapBarTier,
  getAgentState,
  getCapUsageProgress,
  getRecentReports,
  getTodaySchedule,
  type ScheduleEntry,
} from '@caishen/db/queries/overview';

import { OverviewLiveBanner } from './_components/overview-live-banner';

export const dynamic = 'force-dynamic';

function todayUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}

export default async function OverviewPage(): Promise<React.ReactElement> {
  const today = todayUtc();
  const [agent, schedule, capProgress, reports] = await Promise.all([
    safeGet(() => loadAgent()),
    safeGet(() => loadSchedule(today)),
    safeGet(() => loadCap(today)),
    safeGet(() => loadReports(8)),
  ]);

  const paused = agent.value?.pausedBool === true;

  return (
    <main>
      <div className="page-head">
        <h1>Overview</h1>
        <span className="meta">
          {paused ? (
            <span className="pill pill-warn" data-testid="agent-pill">
              paused
            </span>
          ) : (
            <span className="pill pill-ok" data-testid="agent-pill">
              active
            </span>
          )}
        </span>
      </div>

      <OverviewLiveBanner />

      <section className="section">
        <header className="section-head">
          <h2>Today schedule</h2>
          <span className="section-meta">{schedule.value?.length ?? 0} sessions</span>
        </header>
        {scheduleList(schedule.value)}
      </section>

      <section className="section">
        <header className="section-head">
          <h2>Daily cap</h2>
          <span className="section-meta">Max 20x · 15-slot ceiling</span>
        </header>
        {capWidget(capProgress.value)}
      </section>

      <section className="section">
        <header className="section-head">
          <h2>Recent activity</h2>
          <span className="section-meta">last 8 executor runs</span>
        </header>
        {recentList(reports.value)}
      </section>
    </main>
  );
}

interface SafeResult<T> {
  value: T | null;
  err: string | null;
}

async function safeGet<T>(fn: () => Promise<T>): Promise<SafeResult<T>> {
  try {
    return { value: await fn(), err: null };
  } catch (e) {
    return { value: null, err: e instanceof Error ? e.message : String(e) };
  }
}

async function loadAgent(): Promise<{ pausedBool: boolean; pausedAt: Date | null }> {
  const { getTenantDb } = await import('@caishen/db/client');
  return getAgentState(getTenantDb(1));
}
async function loadSchedule(today: string): Promise<ScheduleEntry[]> {
  const { getTenantDb } = await import('@caishen/db/client');
  return getTodaySchedule(getTenantDb(1), today);
}
async function loadCap(today: string): Promise<CapProgress | null> {
  const { getTenantDb } = await import('@caishen/db/client');
  return getCapUsageProgress(getTenantDb(1), today);
}
async function loadReports(limit: number) {
  const { getTenantDb } = await import('@caishen/db/client');
  return getRecentReports(getTenantDb(1), limit);
}

function scheduleList(items: ScheduleEntry[] | null): React.ReactElement {
  if (items === null) return <p className="muted">— couldn't load schedule —</p>;
  if (items.length === 0)
    return <p className="muted">No sessions scheduled. Run /replan if unexpected.</p>;
  return (
    <ul className="kv-list">
      {items.map((s) => (
        <li key={s.id}>
          <span className="label">{s.sessionName}</span>
          <span className="pair">{s.pairCode}</span>
          <span className={`countdown countdown-${s.status}`}>{s.countdown}</span>
        </li>
      ))}
    </ul>
  );
}

function capWidget(cap: CapProgress | null): React.ReactElement {
  // Defensive default when the cap-rollup cron hasn't run today.
  const c = cap ?? computeCapBarTier({ dailyUsed: 0, dailyLimit: 15 });
  // AC-021-4: tooltip varies by tier; the live PASS/FAIL state from
  // spike-fr-001-outcomes.json wires in session 5.
  const tooltip =
    c.tier === 'red'
      ? 'Daily cap nearly exhausted. Re-plans will refuse without --force.'
      : c.tier === 'yellow'
        ? 'Daily cap warning at 12+ slots. Operator overrides still allowed.'
        : 'Daily cap healthy.';
  return (
    <div className={`cap-bar cap-bar-${c.tier}`} data-testid="cap-bar" title={tooltip}>
      <div className="cap-bar-fill" style={{ width: `${c.percent}%` }} />
      <div className="cap-bar-label">
        <strong>{c.dailyUsed}</strong> / {c.dailyLimit} slots used today
      </div>
    </div>
  );
}

function recentList(items: Awaited<ReturnType<typeof loadReports>> | null): React.ReactElement {
  if (items === null) return <p className="muted">— couldn't load recent runs —</p>;
  if (items.length === 0) return <p className="muted">No executor runs yet today.</p>;
  return (
    <ul className="kv-list">
      {items.map((r) => (
        <li key={r.id}>
          <span className="label">{new Date(r.createdAt).toISOString().slice(11, 16)}</span>
          <span className="pair">{r.pair}</span>
          <span className="value">{r.actionTaken ?? '—'}</span>
        </li>
      ))}
    </ul>
  );
}
