/**
 * v1.1 #3 — ForexFactory calendar fetch + markdown rendering.
 *
 * Replaces the dead MCP-via-custom-connector path. The Anthropic "Add custom
 * MCP connector" UI requires OAuth and the FFCal MCP server has no OAuth
 * wrapper, so MCP-as-MCP is fundamentally blocked. This helper fetches the
 * public ForexFactory weekly JSON feed (the same data the FFCal MCP wrapped)
 * and renders it for the Planner / Executor system prompts to consume via
 * Bash+curl through the Vercel proxy at /api/internal/ffcal/today.
 *
 * Public feed: https://nfs.faireconomy.media/ff_calendar_thisweek.json
 * Shape per event: { title, country, date, impact, forecast, previous }
 *   - country: 3-char currency code (USD, EUR, JPY, ...)
 *   - date: ISO-8601 with timezone offset (e.g. "2026-05-03T19:00:00-04:00")
 *   - impact: "High" | "Medium" | "Low" | "Holiday"
 *
 * Output shape:
 *   { event_count, time_window_start, time_window_end, markdown, events, degraded }
 *
 * EC-002-1 (constitution): on feed unreachable / non-OK / parse error, return
 * a degraded result (`degraded: true`, empty events, "no calendar data"
 * markdown) rather than throwing — same graceful-degradation contract as
 * news.ts. Caller (Vercel route + Planner Bash) decides whether to alert.
 *
 * Constitution §5: all timestamps GMT/UTC. The feed's local-tz dates are
 * normalized via `new Date(...).toISOString()` before filtering / rendering.
 */

const DEFAULT_WINDOW_HOURS = 48;
const DEFAULT_FEED_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

/** Single event as the upstream JSON feed delivers it. */
export interface CalendarFeedItem {
  title?: string;
  country?: string;
  date?: string;
  impact?: string;
  forecast?: string;
  previous?: string;
}

/** Normalized event shape returned to the Planner / Executor. */
export interface CalendarEvent {
  title: string;
  currency: string;
  time_gmt: string;
  impact: 'High' | 'Medium' | 'Low' | 'Holiday';
  forecast: string;
  previous: string;
}

export interface CalendarRenderResult {
  event_count: number;
  time_window_start: string;
  time_window_end: string;
  markdown: string;
  events: readonly CalendarEvent[];
  degraded: boolean;
}

export type ImpactFilter = 'high' | 'medium' | 'all';

export interface CalendarRenderOptions {
  /** Injected clock — tests pass a frozen Date so the window is deterministic. */
  now?: Date;
  /** Hours forward from `now` to include events. Default 48. */
  windowHours?: number;
  /** Impact threshold. 'high' = High only; 'medium' = High+Medium+Holiday; 'all' = everything. Default 'medium'. */
  impact?: ImpactFilter;
}

const VALID_IMPACTS = new Set(['High', 'Medium', 'Low', 'Holiday']);

function normalizeImpact(raw: string | undefined): CalendarEvent['impact'] | null {
  if (!raw) return null;
  const t = raw.trim();
  if (VALID_IMPACTS.has(t)) return t as CalendarEvent['impact'];
  // Some upstream variants. Be defensive.
  const cap = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  return VALID_IMPACTS.has(cap) ? (cap as CalendarEvent['impact']) : null;
}

function impactPasses(level: CalendarEvent['impact'], filter: ImpactFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'high') return level === 'High';
  // medium: High + Medium + Holiday (Holiday matters for liquidity even if not tagged high).
  return level === 'High' || level === 'Medium' || level === 'Holiday';
}

/**
 * Pure renderer — takes already-fetched feed items, applies window+impact
 * filter, returns the structured result. No network I/O. Trivially testable
 * against frozen fixtures.
 */
export function renderCalendarMarkdown(
  items: readonly CalendarFeedItem[],
  opts: CalendarRenderOptions = {},
): CalendarRenderResult {
  const now = opts.now ?? new Date();
  const windowHours = opts.windowHours ?? DEFAULT_WINDOW_HOURS;
  const impactFilter: ImpactFilter = opts.impact ?? 'medium';
  const cutoffEnd = new Date(now.getTime() + windowHours * 60 * 60 * 1000);

  const events: CalendarEvent[] = [];
  for (const item of items) {
    if (!item.date) continue;
    const t = new Date(item.date);
    if (Number.isNaN(t.getTime())) continue;
    if (t < now || t > cutoffEnd) continue;

    const impact = normalizeImpact(item.impact);
    if (impact === null) continue;
    if (!impactPasses(impact, impactFilter)) continue;

    const currency = (item.country ?? '').trim();
    if (currency.length === 0) continue;

    events.push({
      title: (item.title ?? '(untitled)').trim(),
      currency,
      time_gmt: t.toISOString(),
      impact,
      forecast: (item.forecast ?? '').trim(),
      previous: (item.previous ?? '').trim(),
    });
  }

  events.sort((a, b) => new Date(a.time_gmt).getTime() - new Date(b.time_gmt).getTime());

  const markdown = renderMarkdown(events, now, cutoffEnd, windowHours, impactFilter);

  return {
    event_count: events.length,
    time_window_start: now.toISOString(),
    time_window_end: cutoffEnd.toISOString(),
    markdown,
    events,
    degraded: false,
  };
}

function renderMarkdown(
  events: readonly CalendarEvent[],
  now: Date,
  end: Date,
  windowHours: number,
  filter: ImpactFilter,
): string {
  if (events.length === 0) {
    return `## Economic Calendar (${windowHours}h forward, ${filter}-impact)\n\nNo events in window.`;
  }
  const lines: string[] = [];
  lines.push(`## Economic Calendar (${windowHours}h forward, ${filter}-impact)`);
  lines.push(``);
  lines.push(`Window: ${now.toISOString()} → ${end.toISOString()} GMT`);
  lines.push(`Events: ${events.length}`);
  lines.push(``);
  lines.push(`| Time (GMT) | Currency | Impact | Title | Forecast | Previous |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const ev of events) {
    lines.push(
      `| ${ev.time_gmt} | ${ev.currency} | ${ev.impact} | ${escapeMd(ev.title)} | ${escapeMd(ev.forecast || '—')} | ${escapeMd(ev.previous || '—')} |`,
    );
  }
  return lines.join('\n');
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Convenience wrapper: fetch the public feed + render. Caller injects fetch. */
export interface FetchAndRenderCalendarDeps {
  fetch: typeof fetch;
  feedUrl?: string;
  now?: Date;
  windowHours?: number;
  impact?: ImpactFilter;
}

export async function fetchAndRenderCalendar(
  deps: FetchAndRenderCalendarDeps,
): Promise<CalendarRenderResult> {
  const url = deps.feedUrl ?? DEFAULT_FEED_URL;
  const opts: CalendarRenderOptions = {
    now: deps.now,
    windowHours: deps.windowHours,
    impact: deps.impact,
  };

  let items: CalendarFeedItem[];
  try {
    const resp = await deps.fetch(url, { method: 'GET' });
    if (!resp.ok) {
      return degraded(opts);
    }
    const raw = (await resp.json()) as unknown;
    if (!Array.isArray(raw)) {
      return degraded(opts);
    }
    items = raw as CalendarFeedItem[];
  } catch {
    return degraded(opts);
  }
  return renderCalendarMarkdown(items, opts);
}

function degraded(opts: CalendarRenderOptions): CalendarRenderResult {
  const now = opts.now ?? new Date();
  const windowHours = opts.windowHours ?? DEFAULT_WINDOW_HOURS;
  const impactFilter: ImpactFilter = opts.impact ?? 'medium';
  const end = new Date(now.getTime() + windowHours * 60 * 60 * 1000);
  return {
    event_count: 0,
    time_window_start: now.toISOString(),
    time_window_end: end.toISOString(),
    markdown: `## Economic Calendar (${windowHours}h forward, ${impactFilter}-impact)\n\nFeed unreachable — using empty calendar. Planner: apply conservative session defaults.`,
    events: [],
    degraded: true,
  };
}
