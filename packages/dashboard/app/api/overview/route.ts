/**
 * GET /api/overview — live snapshot poll for the Overview page (FR-006 AC-006-3).
 *
 * Returns balance + equity + open-position count + a server timestamp the
 * client compares to compute stale-state banner age (yellow >30s, red >60s).
 *
 * Auth: session-required.
 *
 * Live MT5 fetch happens via mt5-server.ts (which itself uses
 * MT5_BASE_URL + MT5_BEARER_TOKEN). When those env vars aren't set yet,
 * we degrade gracefully — return null for balance/equity and 0 positions.
 * The dashboard banner surfaces the degraded state.
 */

import { mt5Get } from '@/lib/mt5-server';
import { OPERATOR_COOKIE_NAME, verifyOperatorCookie } from '@/lib/operator-session';
import { resolveOperatorFromSession } from '@/lib/override-bind';

const SESSION_COOKIE_NAMES = ['__Secure-authjs.session-token', 'authjs.session-token'];

interface AccountData {
  balance?: number;
  equity?: number;
}

interface PositionData {
  symbol: string;
  pnl?: number;
}

export async function GET(req: Request): Promise<Response> {
  // v1.1.1 KI-005 workaround: accept the operator-session cookie (token-based
  // login) in addition to the Auth.js cookie. v1.2 will replace both with a
  // proper SimpleWebAuthn flow.
  const operatorCookieValue = readCookieByName(req, OPERATOR_COOKIE_NAME);
  let authed = false;
  if (
    typeof operatorCookieValue === 'string' &&
    (await verifyOperatorCookie(operatorCookieValue))
  ) {
    authed = true;
  } else {
    try {
      const resolved = await resolveOperatorFromSession(readSessionCookie(req));
      if (resolved !== null) authed = true;
    } catch {
      // fall through to 401
    }
  }
  if (!authed) {
    return jsonRes(401, { ok: false, error: 'unauthorized' });
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

function readSessionCookie(req: Request): string | undefined {
  const raw = req.headers.get('cookie');
  if (raw === null) return undefined;
  const parts = raw.split(';').map((p) => p.trim());
  for (const name of SESSION_COOKIE_NAMES) {
    const match = parts.find((p) => p.startsWith(`${name}=`));
    if (match !== undefined) return match.slice(name.length + 1);
  }
  return undefined;
}

function readCookieByName(req: Request, name: string): string | undefined {
  const raw = req.headers.get('cookie');
  if (raw === null) return undefined;
  const parts = raw.split(';').map((p) => p.trim());
  const match = parts.find((p) => p.startsWith(`${name}=`));
  return match === undefined ? undefined : match.slice(name.length + 1);
}
