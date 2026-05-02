#!/usr/bin/env bun
/**
 * FR-005 AC-005-1 — channels-side healthcheck handler.
 *
 * Exposed by the systemd-managed Bun process under a tiny HTTP server that
 * listens on 127.0.0.1:8444 (also reachable via Tailscale Funnel under a
 * separate hostname, gated by HEALTH_BEARER_TOKEN). The Vercel cron at
 * /api/cron/channels-health hits this endpoint every 5 minutes (R5).
 *
 * Returns:
 *   { healthy: bool, uptimeSec: number, lastMessageHandledAt: string | null }
 *
 * Health signal (R5 correctness): MAX(replied_at) on telegram_interactions
 * EXCLUDING SYNTHETIC_PING rows. SYNTHETIC_PING heartbeats keep the table
 * dense, but a wrapper bug that writes ping rows without invoking the
 * subagent would inflate liveness if those rows counted.
 *
 * The handler is split into a pure compute step (computeHealthSignal — unit
 * testable, no DB) and a thin query layer (queryMaxNonPingRepliedAt — also
 * testable with a mock db). The HTTP wiring lives in `serve()` for
 * production runtime.
 */

import { createServer } from 'node:http';
import { sql } from 'drizzle-orm';

export interface HealthInput {
  tenantId: number;
  now: Date;
  lastNonPingRepliedAt: Date | null;
  processStartedAt: Date;
  /** Threshold in seconds — if (now - lastNonPingRepliedAt) > threshold, unhealthy. */
  thresholdSec: number;
}

export interface HealthSignal {
  tenantId: number;
  healthy: boolean;
  uptimeSec: number;
  lastMessageHandledAt: string | null;
}

/**
 * Pure: compute the health signal from already-fetched inputs. Used both
 * in production (after queryMaxNonPingRepliedAt populates lastNonPingRepliedAt)
 * and in tests.
 */
export function computeHealthSignal(input: HealthInput): HealthSignal {
  const uptimeMs = input.now.getTime() - input.processStartedAt.getTime();
  const uptimeSec = Math.floor(uptimeMs / 1000);

  let healthy: boolean;
  let lastMessageHandledAt: string | null;
  if (input.lastNonPingRepliedAt === null) {
    healthy = false;
    lastMessageHandledAt = null;
  } else {
    const ageMs = input.now.getTime() - input.lastNonPingRepliedAt.getTime();
    healthy = ageMs <= input.thresholdSec * 1000;
    lastMessageHandledAt = input.lastNonPingRepliedAt.toISOString();
  }
  return {
    tenantId: input.tenantId,
    healthy,
    uptimeSec,
    lastMessageHandledAt,
  };
}

/**
 * Drizzle-flavoured "execute"-like surface — narrows the test stub.
 */
export interface ExecuteCapableDb {
  execute: (q: { sql?: string; params?: unknown[] }) => Promise<{ max: Date | null }[]>;
}

/**
 * Query MAX(replied_at) FROM telegram_interactions WHERE tenant_id = $1
 * AND command_parsed != 'SYNTHETIC_PING' (R5).
 *
 * Returns Date | null.
 *
 * Note: we use raw SQL via Drizzle's sql template here because Drizzle's
 * MAX() typing in mixed-tenant ORM-style is awkward; this is one of the
 * <3 entries in `packages/db/src/lint/raw-sql-allowlist.txt` that are
 * justified per Q3 (raw SQL allowed when tenant_id appears in the WHERE
 * clause as it does here).
 */
export async function queryMaxNonPingRepliedAt(
  db: ExecuteCapableDb,
  tenantId: number,
): Promise<Date | null> {
  const rows = await db.execute({
    sql:
      'SELECT MAX(replied_at) AS max FROM telegram_interactions ' +
      "WHERE tenant_id = $1 AND command_parsed != 'SYNTHETIC_PING'",
    params: [tenantId],
  });
  const first = rows[0];
  if (!first) return null;
  return first.max ?? null;
}

const PROCESS_STARTED_AT = new Date();
const DEFAULT_THRESHOLD_SEC = 600; // 10 min — matches the FR-005 alert tier.

interface ServeArg {
  port: number;
  bearerToken: string;
  tenantId: number;
}

/**
 * Bun-runtime HTTP server. Uses Node's http module so this can also run
 * under plain Node should the operator choose.
 */
export function serve(arg: ServeArg): { close: () => void } {
  const server = createServer(async (req, res) => {
    if (req.method !== 'GET' || req.url !== '/healthz') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${arg.bearerToken}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    try {
      const { getTenantDb } = await import('@caishen/db/client');
      const tenantDb = getTenantDb(arg.tenantId);
      const lastRepliedAt = await queryMaxNonPingRepliedAt(
        tenantDb.drizzle as unknown as ExecuteCapableDb,
        arg.tenantId,
      );
      const signal = computeHealthSignal({
        tenantId: arg.tenantId,
        now: new Date(),
        lastNonPingRepliedAt: lastRepliedAt,
        processStartedAt: PROCESS_STARTED_AT,
        thresholdSec: DEFAULT_THRESHOLD_SEC,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(signal));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'internal',
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  });

  server.listen(arg.port, '127.0.0.1', () => {
    process.stdout.write(`[healthcheck-handler] listening on 127.0.0.1:${arg.port}/healthz\n`);
  });

  return { close: () => server.close() };
}

declare global {
  interface ImportMeta {
    main?: boolean;
  }
}

if (import.meta.main === true) {
  const port = parseInt(process.env.HEALTHCHECK_PORT ?? '8444', 10);
  const bearer = process.env.HEALTH_BEARER_TOKEN ?? '';
  const tenantId = parseInt(process.env.CAISHEN_TENANT_ID ?? '1', 10);
  if (bearer.length === 0) {
    process.stderr.write('healthcheck-handler: HEALTH_BEARER_TOKEN missing\n');
    process.exit(1);
  }
  serve({ port, bearerToken: bearer, tenantId });
}

// `sql` re-exported in case a downstream consumer wants to compose queries.
export { sql };
