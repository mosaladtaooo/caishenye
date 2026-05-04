/**
 * GET /api/internal/mt5/positions[?symbol=XYZ] — proxy to MT5 REST positions.
 *
 * Session 5g — corrected paths to the n8n-canonical `/api/v1/...` shape:
 *   - no symbol query → GET /api/v1/positions (full open book)
 *   - symbol=EURUSD → GET /api/v1/positions/symbol/EURUSD (filtered)
 *
 * Symbol is sanitised (alphanumeric only, uppercased) — same hardening the
 * n8n workflow's $fromAI("symbol", ...).replace(/[^a-zA-Z0-9]/g,"").toUpperCase()
 * step performs. Defence against curl-from-Routine path-injection.
 *
 * Same auth + error-mapping shape as account.
 */

import { validateInternalAuth } from '@/lib/internal-auth';
import { jsonRes, mapUpstreamError } from '@/lib/internal-route-helpers';
import { mt5Get } from '@/lib/mt5-server';

function sanitiseSymbol(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

export async function GET(req: Request): Promise<Response> {
  const authFail = validateInternalAuth(req);
  if (authFail) return authFail;

  const url = new URL(req.url);
  const rawSymbol = url.searchParams.get('symbol') ?? '';
  const path =
    rawSymbol.length === 0
      ? '/api/v1/positions'
      : `/api/v1/positions/symbol/${sanitiseSymbol(rawSymbol)}`;

  try {
    const upstream = await mt5Get(path);
    return jsonRes(200, upstream);
  } catch (e) {
    return mapUpstreamError(e, 'mt5/positions');
  }
}
