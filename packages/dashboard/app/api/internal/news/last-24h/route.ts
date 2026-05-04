/**
 * GET /api/internal/news/last-24h — wraps FR-014 news.ts, returns the
 * 24h news markdown block the Planner system prompt depends on.
 *
 * Session 5g — added route. The n8n workflow used a "Code in JavaScript5"
 * RSS-fetch + render node against https://investinglive.com/feed/ to
 * produce the {NEWS_MARKDOWN} substitution in the spartan + planner
 * prompts. The session-5e proxy rollout missed this entirely; the
 * Planner /fire returned a degraded plan with no news context.
 *
 * Implementation: imports `fetchAndRenderNews` from
 * @caishen/routines/news (the verbatim FR-014 port) and exposes the
 * result over HTTP. The route is bearer-gated like every other
 * /api/internal/* route.
 *
 * EC-014-1 (feed unreachable) is handled inside fetchAndRenderNews — it
 * returns a degraded { news_count: 0, markdown: 'No news found in the
 * last 24 hours.' } shape rather than throwing. The route therefore
 * always returns 200 with a valid shape; observability of "feed was
 * down" is via news_count === 0 (operator can correlate with prior
 * non-zero runs to detect outages).
 *
 * Vercel timeout: the RSS fetch is typically <2s but the public feed
 * occasionally stalls. We bump maxDuration to 15s for safety.
 */

import { fetchAndRenderNews } from '@caishen/routines/news';
import { validateInternalAuth } from '@/lib/internal-auth';
import { jsonRes } from '@/lib/internal-route-helpers';

export const maxDuration = 15;

export async function GET(req: Request): Promise<Response> {
  const authFail = validateInternalAuth(req);
  if (authFail) return authFail;

  try {
    const result = await fetchAndRenderNews({ fetch });
    // Shape: { news_count, time_window_start, markdown }.
    return jsonRes(200, result);
  } catch (e) {
    // fetchAndRenderNews catches its own fetch errors; getting here
    // means a programming bug (e.g., schema-incompat input). Surface as
    // 500 rather than 502 — this is OUR side that broke, not upstream.
    const msg = e instanceof Error ? e.message : String(e);
    return jsonRes(500, { error: `news/last-24h: ${msg.slice(0, 256)}` });
  }
}
