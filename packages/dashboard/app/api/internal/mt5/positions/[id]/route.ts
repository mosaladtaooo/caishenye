/**
 * MT5 position by-id — DELETE (close) + PATCH (modify SL/TP).
 *
 * v1.1 — adds the in-trade management primitives the verbatim SPARTAN
 * prompt assumes (the n8n executor had `delete_positions_{id}` for closing
 * and `put_positions_{id}` for modifying SL/TP; both were missing from
 * v1's Vercel proxy).
 *
 * Upstream MT5 REST shape (from n8n Agent.json):
 *   - close: DELETE /api/v1/positions/{id}      → no body
 *   - modify: PUT  /api/v1/positions/{id}       → body: { stop_loss?, take_profit? }
 *
 * Routine-facing contract (this proxy — kept ergonomic for Claude):
 *   - DELETE /api/internal/mt5/positions/{id}   → no body (full close)
 *   - PATCH  /api/internal/mt5/positions/{id}   → body: { sl?, tp? }
 *
 * Why PATCH on our side but PUT upstream: PATCH is the semantically correct
 * verb for "modify subset of resource fields" (SL/TP only — not the whole
 * position state). The proxy translates to PUT to match the upstream's
 * legacy shape.
 *
 * Path-segment id is sanitised: digits only (MT5 ticket IDs are integers).
 * Anything non-numeric → 400. Defence against curl-from-Routine
 * path-injection via crafted ids like `123/../foo`.
 */

import { validateInternalAuth } from '@/lib/internal-auth';
import { jsonRes, mapUpstreamError } from '@/lib/internal-route-helpers';
import { mt5Delete, mt5Put } from '@/lib/mt5-server';

interface ModifyBody {
  sl?: number;
  tp?: number;
}

interface UpstreamModifyBody {
  stop_loss?: number;
  take_profit?: number;
}

function validateId(raw: string): string | null {
  if (raw.length === 0) return null;
  // MT5 ticket ids are integers (positive). No leading zeros allowed for
  // strict canonical form; reject things like "12 34", "0x1f", "1.5".
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  return raw;
}

function validateModifyBody(raw: unknown): ModifyBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const out: ModifyBody = {};
  if (r.sl !== undefined) {
    if (typeof r.sl !== 'number' || !Number.isFinite(r.sl)) return null;
    out.sl = r.sl;
  }
  if (r.tp !== undefined) {
    if (typeof r.tp !== 'number' || !Number.isFinite(r.tp)) return null;
    out.tp = r.tp;
  }
  if (out.sl === undefined && out.tp === undefined) return null;
  return out;
}

function toUpstream(body: ModifyBody): UpstreamModifyBody {
  const out: UpstreamModifyBody = {};
  if (typeof body.sl === 'number') out.stop_loss = body.sl;
  if (typeof body.tp === 'number') out.take_profit = body.tp;
  return out;
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(req: Request, ctx: RouteContext): Promise<Response> {
  const authFail = validateInternalAuth(req);
  if (authFail) return authFail;

  const { id: rawId } = await ctx.params;
  const id = validateId(rawId);
  if (id === null) {
    return jsonRes(400, { error: 'mt5/positions/[id]: invalid id (must be a positive integer)' });
  }

  try {
    const upstream = await mt5Delete(`/api/v1/positions/${id}`);
    return jsonRes(200, upstream);
  } catch (e) {
    return mapUpstreamError(e, 'mt5/positions/[id] DELETE');
  }
}

export async function PATCH(req: Request, ctx: RouteContext): Promise<Response> {
  const authFail = validateInternalAuth(req);
  if (authFail) return authFail;

  const { id: rawId } = await ctx.params;
  const id = validateId(rawId);
  if (id === null) {
    return jsonRes(400, { error: 'mt5/positions/[id]: invalid id (must be a positive integer)' });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonRes(400, { error: 'mt5/positions/[id] PATCH: invalid JSON body' });
  }
  const body = validateModifyBody(raw);
  if (body === null) {
    return jsonRes(400, {
      error:
        'mt5/positions/[id] PATCH: body must be { sl?: number, tp?: number } with at least one',
    });
  }

  try {
    const upstream = await mt5Put(`/api/v1/positions/${id}`, toUpstream(body));
    return jsonRes(200, upstream);
  } catch (e) {
    return mapUpstreamError(e, 'mt5/positions/[id] PATCH');
  }
}
