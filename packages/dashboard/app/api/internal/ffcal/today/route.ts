/**
 * GET /api/internal/ffcal/today — proxy to ForexFactory MCP /today.
 *
 * Forwards to ${FFCAL_BASE_URL}/today with FFCAL_BEARER_TOKEN. No retry
 * (FFCal is a low-priority enrichment input; the Planner falls back to
 * a degraded plan via EC-002-1 if this 5xx's).
 */

import { validateInternalAuth } from '@/lib/internal-auth';
import { jsonRes } from '@/lib/internal-route-helpers';

const TIMEOUT_MS = 8000;

export async function GET(req: Request): Promise<Response> {
  const authFail = validateInternalAuth(req);
  if (authFail) return authFail;

  const baseUrl = process.env.FFCAL_BASE_URL ?? '';
  const bearer = process.env.FFCAL_BEARER_TOKEN ?? '';
  if (baseUrl.length === 0) {
    return jsonRes(500, { error: 'ffcal/today: server misconfigured (FFCAL_BASE_URL missing)' });
  }
  if (bearer.length === 0) {
    return jsonRes(500, {
      error: 'ffcal/today: server misconfigured (FFCAL_BEARER_TOKEN missing)',
    });
  }

  const url = `${baseUrl.replace(/\/$/, '')}/today`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${bearer}`,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!upstream.ok) {
      return jsonRes(502, {
        error: `ffcal/today: upstream HTTP ${upstream.status}`,
      });
    }
    const text = await upstream.text();
    return new Response(text, {
      status: 200,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error ? e.message : String(e);
    return jsonRes(502, { error: `ffcal/today: ${msg.slice(0, 256)}` });
  }
}
