/**
 * Dashboard root — Overview screen (FR-006 AC-006-2 #1).
 *
 * Server component renders the initial data; SWR-on-the-client (mounted by
 * `<OverviewClient />`) polls /api/overview every 5s for live updates +
 * surfaces stale-state banners (yellow >30s, red >60s) per AC-006-3.
 *
 * Composition:
 *   - Hero: balance + equity + open-positions (from MT5 via /api/overview)
 *   - Today's schedule with per-row countdowns
 *   - Cap progress bar (FR-021 AC-021-2; tier colour-coded)
 *   - Last Telegram interaction (FR-005 heartbeat readout)
 *   - Recent activity feed (last 10 executor reports)
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

  return (
    <main className="overview">
      <header className="overview-hero">
        <div>
          <h1>财神爷 — Mission Control</h1>
          <p className="muted">{today} GMT</p>
        </div>
        <AgentStatePill paused={agent.value?.pausedBool === true} />
      </header>

      <OverviewLiveBanner />

      <section className="overview-grid">
        <Card title="Today's schedule" subtitle={`${schedule.value?.length ?? 0} sessions`}>
          {scheduleList(schedule.value)}
        </Card>

        <Card title="Daily cap (Max 20x)" subtitle="">
          {capWidget(capProgress.value)}
        </Card>

        <Card title="Recent activity" subtitle="last 8 executor runs">
          {recentList(reports.value)}
        </Card>
      </section>

      <style>{overviewStyles}</style>
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

function AgentStatePill({ paused }: { paused: boolean }): React.ReactElement {
  return (
    <span className={`pill ${paused ? 'pill-warn' : 'pill-ok'}`}>
      {paused ? 'Paused' : 'Active'}
    </span>
  );
}

function scheduleList(items: ScheduleEntry[] | null): React.ReactElement {
  if (items === null) return <p className="muted">— couldn't load schedule —</p>;
  if (items.length === 0)
    return <p className="muted">No sessions scheduled for today. Run /replan if unexpected.</p>;
  return (
    <ul className="schedule-list">
      {items.map((s) => (
        <li key={s.id}>
          <span className="pair">{s.pairCode}</span>
          <span className="muted">{s.sessionName}</span>
          <span className={`countdown countdown-${s.status}`}>{s.countdown}</span>
        </li>
      ))}
    </ul>
  );
}

function capWidget(cap: CapProgress | null): React.ReactElement {
  // Defensive default when the cap-rollup cron hasn't run today.
  const c = cap ?? computeCapBarTier({ dailyUsed: 0, dailyLimit: 15 });
  return (
    <div className={`cap-bar cap-bar-${c.tier}`} data-testid="cap-bar">
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
    <ul className="recent-list">
      {items.map((r) => (
        <li key={r.id}>
          <span className="muted">{new Date(r.createdAt).toISOString().slice(11, 16)} GMT</span>
          <span className="pair">{r.pair}</span>
          <span className="action">{r.actionTaken ?? '—'}</span>
        </li>
      ))}
    </ul>
  );
}

interface CardProps {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}

function Card({ title, subtitle, children }: CardProps): React.ReactElement {
  return (
    <article className="card">
      <header className="card-header">
        <h2>{title}</h2>
        <span className="muted">{subtitle}</span>
      </header>
      <div className="card-body">{children}</div>
    </article>
  );
}

const overviewStyles = `
  .overview { padding: 2rem; max-width: 1100px; margin: 0 auto; }
  .overview-hero { display: flex; justify-content: space-between; align-items: center;
                   border-bottom: 1px solid #1f2937; padding-bottom: 1rem; margin-bottom: 1.5rem; }
  .overview-hero h1 { margin: 0; font-size: 1.5rem; letter-spacing: -0.02em; }
  .overview-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
                   gap: 1rem; }
  .muted { color: #6b7280; font-size: 0.875rem; }
  .card { background: #0b1220; border: 1px solid #1f2937; border-radius: 10px; padding: 1rem 1.25rem; }
  .card-header { display: flex; justify-content: space-between; align-items: baseline;
                 margin-bottom: 0.75rem; }
  .card-header h2 { margin: 0; font-size: 1rem; font-weight: 600; }
  .schedule-list, .recent-list { list-style: none; margin: 0; padding: 0;
                                 display: grid; grid-template-columns: 80px 1fr auto; gap: 0.5rem 1rem;
                                 font-variant-numeric: tabular-nums; }
  .schedule-list li, .recent-list li { display: contents; }
  .schedule-list .pair, .recent-list .pair { font-weight: 600; }
  .countdown { text-align: right; font-variant-numeric: tabular-nums; }
  .countdown-cancelled { color: #ef4444; }
  .countdown-skipped_no_window { color: #6b7280; }
  .pill { padding: 0.25rem 0.75rem; border-radius: 999px; font-size: 0.875rem; font-weight: 600; }
  .pill-ok { background: #064e3b; color: #6ee7b7; }
  .pill-warn { background: #7c2d12; color: #fdba74; }
  .cap-bar { position: relative; height: 32px; background: #1f2937; border-radius: 6px; overflow: hidden; }
  .cap-bar-fill { position: absolute; inset: 0; transition: width 200ms ease; }
  .cap-bar-green .cap-bar-fill { background: #10b981; }
  .cap-bar-yellow .cap-bar-fill { background: #f59e0b; }
  .cap-bar-red .cap-bar-fill { background: #ef4444; }
  .cap-bar-label { position: relative; padding: 0.5rem 0.75rem; font-size: 0.875rem; color: #f3f4f6; }
  body { background: #030712; color: #f3f4f6; }
`;
