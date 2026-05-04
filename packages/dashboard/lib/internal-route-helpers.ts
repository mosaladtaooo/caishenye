/**
 * Tiny shared helpers for /api/internal/* routes (ADR-012 proxy gateway).
 *
 * Centralises the JSON response + upstream-error-mapping shape so each
 * route file stays under 80 lines and uniform. Used together with
 * validateInternalAuth from internal-auth.ts.
 */

export function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Map an upstream error to (status, body). Distinguishes server-side env
 * misconfig (500) from upstream-down (502). The convention: any error
 * message containing "missing in env" or "MISSING in env" maps to 500
 * (the proxy itself is misconfigured); everything else is 502 (the
 * upstream is down or returned non-2xx).
 *
 * Rationale: a clean 500 vs 502 distinction lets the operator triage
 * fast — 500 means "fix YOUR Vercel env"; 502 means "the upstream is down,
 * not your config".
 */
export function mapUpstreamError(e: unknown, label: string): Response {
  const message = e instanceof Error ? e.message : String(e);
  if (/missing in env/i.test(message)) {
    return jsonRes(500, { error: `${label}: server misconfigured (${message})` });
  }
  return jsonRes(502, { error: `${label}: ${message.slice(0, 256)}` });
}
