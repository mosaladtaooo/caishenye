/**
 * GET /api/internal/ffcal/today — economic calendar proxy.
 *
 * v1.1 #3 — RESURRECTED. Replaces the 501-deprecation stub introduced in
 * session 5g. Rationale for resurrection:
 *
 *   - Anthropic's "Add custom MCP connector" UI requires OAuth, which the
 *     FFCal MCP server does not implement. So MCP-via-custom-connector is
 *     fundamentally blocked — the session-5g resolution ("attach the MCP
 *     connector") cannot be realized in the current Anthropic Routine UI.
 *   - Tailscale Funnel free tier is 1-port-only (empirically confirmed in
 *     session 5h), and the 1 port is held by MT5. So even an HTTPS wrapper
 *     in front of the FFCal MCP cannot share that port without rework.
 *   - The actual data the Planner needs (economic-calendar events, currency,
 *     impact, time, forecast/previous) is available as a public JSON feed
 *     at https://nfs.faireconomy.media/ff_calendar_thisweek.json — the same
 *     data ForexFactory itself serves and the FFCal MCP wrapped.
 *
 * Resolution: Vercel proxy fetches the public feed, applies window+impact
 * filter, returns structured JSON. Routines call this via Bash+curl with
 * INTERNAL_API_TOKEN — same auth pattern as news/last-24h.
 *
 * Query params (all optional):
 *   - window: "24" | "48" | "72" (hours forward from now). Default 48.
 *   - impact: "high" | "medium" | "all". Default "medium" = High+Medium+Holiday.
 *
 * Response shape: { event_count, time_window_start, time_window_end,
 *                   markdown, events[], degraded }.
 *
 * Degraded path (EC-002-1 graceful): on feed unreachable / non-OK / parse
 * error, return 200 with degraded:true + empty events. Routines treat this
 * as "calendar unavailable, use conservative defaults" and proceed without
 * aborting (mirrors news/last-24h's "feed down → empty list" pattern).
 *
 * Vercel function timeout: bumped to 15s for safety; the public feed
 * typically responds <2s.
 */

import { fetchAndRenderCalendar, type ImpactFilter } from '@caishen/routines/calendar';
import { validateInternalAuth } from '@/lib/internal-auth';
import { jsonRes } from '@/lib/internal-route-helpers';

export const maxDuration = 15;

const ALLOWED_WINDOWS = new Set([24, 48, 72]);
const ALLOWED_IMPACT = new Set<ImpactFilter>(['high', 'medium', 'all']);

function parseWindow(raw: string | null): number {
  if (raw === null || raw.length === 0) return 48;
  const n = Number(raw);
  if (!Number.isFinite(n) || !ALLOWED_WINDOWS.has(n)) return 48;
  return n;
}

function parseImpact(raw: string | null): ImpactFilter {
  if (raw === null || raw.length === 0) return 'medium';
  const lower = raw.toLowerCase();
  return ALLOWED_IMPACT.has(lower as ImpactFilter) ? (lower as ImpactFilter) : 'medium';
}

export async function GET(req: Request): Promise<Response> {
  const authFail = validateInternalAuth(req);
  if (authFail) return authFail;

  const url = new URL(req.url);
  const windowHours = parseWindow(url.searchParams.get('window'));
  const impact = parseImpact(url.searchParams.get('impact'));

  try {
    const result = await fetchAndRenderCalendar({ fetch, windowHours, impact });
    return jsonRes(200, result);
  } catch (e) {
    // fetchAndRenderCalendar catches its own fetch errors and returns a
    // degraded result; getting here means a programming bug (e.g.,
    // schema-incompat). Surface as 500 — this is OUR side that broke.
    const msg = e instanceof Error ? e.message : String(e);
    return jsonRes(500, { error: `ffcal/today: ${msg.slice(0, 256)}` });
  }
}
