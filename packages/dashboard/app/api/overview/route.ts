/**
 * GET /api/overview -- live snapshot poll for the Overview page (FR-006 AC-006-3).
 *
 * Returns balance + equity + open-position count + a server timestamp the
 * client compares to compute stale-state banner age (yellow >30s, red >60s).
 *
 * Auth: session-required.
 *
 * v1.2 FR-025 D3: auth swept to lib/resolve-operator-auth (replaces the v1.1.1
 * inline operator-session-or-Auth.js pattern). Internal-token bearer is also
 * accepted for monitoring callers (read-only path).
 *
 * Live MT5 fetch happens via mt5-server.ts (which itself uses MT5_BASE_URL
 * + MT5_BEARER_TOKEN). When those env vars aren't set yet, we degrade
 * gracefully -- return null for balance/equity and 0 positions. The dashboard
 * banner surfaces the degraded state.
 */

import { mt5Get } from '@/lib/mt5-server';
import { resolveOperatorAuth } from '@/lib/resolve-operator-auth';

interface AccountData {
  balance?: number;
  equity?: number;
}

interface PositionData {
  symbol: string;
  pnl?: number;
}

export async function GET(req: Request): Promise<Response> {
  const auth = await resolveOperatorAuth(req);
  if (!auth.ok) {
    return jsonRes(auth.status, { ok: false, error: auth.reason });
  }

  let balance: number | null = null;
  let equity: number | null = null;
  let openPositions = 0;
  let degraded: string | null = null;

  try {
    const account = (await mt5Get('/account')) as AccountData;
    balance = typeof account.balance === 'number' ? account.balance : null;
    equity = typeof account.equity === 'number' ? account.equity : null;
  } catch (e) {
    degraded = `mt5-account: ${e instanceof Error ? e.message : 'unknown'}`;
  }

  try {
    const positions = (await mt5Get('/positions')) as PositionData[];
    openPositions = Array.isArray(positions) ? positions.length : 0;
  } catch (e) {
    if (degraded === null)
      degraded = `mt5-positions: ${e instanceof Error ? e.message : 'unknown'}`;
  }

  return jsonRes(200, {
    ts: new Date().toISOString(),
    balance,
    equity,
    openPositions,
    degraded,
  });
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
