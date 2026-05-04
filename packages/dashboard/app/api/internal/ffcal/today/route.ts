/**
 * GET /api/internal/ffcal/today — DEPRECATED (returns 501).
 *
 * Session 5g — architectural correction. In the n8n workflow, ForexFactory
 * was an MCP server (Claude reached it via MCP protocol over stdio/SSE),
 * NOT a plain HTTP service. The session-5e proxy route was an architectural
 * error — there is no upstream HTTP endpoint to wrap.
 *
 * Resolution chosen (Path X — see routines-architecture.md § FFCal):
 * the Planner reaches FFCal via the ForexFactory MCP connector attached
 * to the routine itself, calling tools like `mcp__forexfactory__getEvents`
 * directly from Claude. The Vercel proxy plays no role in calendar fetch.
 *
 * This route stays in place (rather than being deleted) so that any
 * lingering operator system-prompt revisions or test fixtures get a clear
 * 501 with a pointer to the correct integration path, instead of a vague
 * 502 from a misconfigured upstream URL.
 *
 * If the operator later stands up an HTTP wrapper for the FFCal MCP on the
 * VPS, this route can be revived (Path Y — deferred from session 5g scope).
 */

import { validateInternalAuth } from '@/lib/internal-auth';
import { jsonRes } from '@/lib/internal-route-helpers';

const DEPRECATION_MESSAGE =
  'ffcal proxy deprecated — use the ForexFactory MCP connector attached to the routine ' +
  '(call e.g. mcp__forexfactory__* tools directly from Claude). ' +
  'See routines-architecture.md § FFCal for the architectural rationale.';

export async function GET(req: Request): Promise<Response> {
  const authFail = validateInternalAuth(req);
  if (authFail) return authFail;

  return jsonRes(501, { error: DEPRECATION_MESSAGE });
}
