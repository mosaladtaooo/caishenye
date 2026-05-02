/**
 * FR-005 AC-005-1 healthcheck signal — RED.
 *
 * The endpoint exposes `{healthy, uptimeSec, lastMessageHandledAt}` derived
 * from the channels-side state. The signal source is:
 *
 *   SELECT MAX(replied_at) FROM telegram_interactions
 *   WHERE tenant_id = $1
 *     AND command_parsed != 'SYNTHETIC_PING'
 *
 * R5 correctness: synthetic-ping rows are EXCLUDED so a dead session can't
 * keep its heartbeat fresh by virtue of the cron's own writes. The cron's
 * synthetic ping flows through the SAME wrapper that writes a real audit
 * row, so a healthy session updates `replied_at` on those rows too — but
 * the *liveness signal* is "have you handled an actual operator message
 * recently OR managed a synthetic-ping reply" (AC-005-1 says either is fine
 * provided the cycle works end-to-end). However, per R5 in the proposal,
 * the conservative interpretation is: exclude SYNTHETIC_PING from
 * MAX(replied_at) so that a wrapper bug that writes a SYNTHETIC_PING row
 * but fails to invoke the subagent doesn't artificially inflate liveness.
 *
 * Per the contract: the dashboard's /api/cron/channels-health hits THIS
 * endpoint via Tailscale Funnel + bearer; the cron computes "healthy" as
 * `now - lastMessageHandledAt < threshold` and inserts a channels_health
 * row.
 */

import { describe, expect, it, vi } from 'vitest';
import { computeHealthSignal, type HealthInput } from '../scripts/healthcheck-handler';

describe('computeHealthSignal — happy path', () => {
  it('returns healthy=true when last replied_at is within threshold', () => {
    const now = new Date('2026-05-04T12:00:00Z');
    const lastRepliedAt = new Date('2026-05-04T11:55:00Z'); // 5 min ago
    const input: HealthInput = {
      tenantId: 1,
      now,
      lastNonPingRepliedAt: lastRepliedAt,
      processStartedAt: new Date('2026-05-04T08:00:00Z'),
      thresholdSec: 600, // 10 min
    };
    const result = computeHealthSignal(input);
    expect(result.healthy).toBe(true);
    expect(result.tenantId).toBe(1);
    expect(result.lastMessageHandledAt).toBe('2026-05-04T11:55:00.000Z');
    // 4h uptime — 14400s.
    expect(result.uptimeSec).toBe(14_400);
  });

  it('returns healthy=true exactly at the threshold boundary', () => {
    const now = new Date('2026-05-04T12:00:00Z');
    const tenMinAgo = new Date('2026-05-04T11:50:00Z'); // 600s ago
    const input: HealthInput = {
      tenantId: 1,
      now,
      lastNonPingRepliedAt: tenMinAgo,
      processStartedAt: new Date('2026-05-04T08:00:00Z'),
      thresholdSec: 600,
    };
    const result = computeHealthSignal(input);
    expect(result.healthy).toBe(true);
  });
});

describe('computeHealthSignal — unhealthy', () => {
  it('returns healthy=false when last replied_at is beyond threshold', () => {
    const now = new Date('2026-05-04T12:00:00Z');
    const lastRepliedAt = new Date('2026-05-04T11:30:00Z'); // 30 min ago
    const input: HealthInput = {
      tenantId: 1,
      now,
      lastNonPingRepliedAt: lastRepliedAt,
      processStartedAt: new Date('2026-05-04T08:00:00Z'),
      thresholdSec: 600,
    };
    const result = computeHealthSignal(input);
    expect(result.healthy).toBe(false);
    expect(result.lastMessageHandledAt).toBe('2026-05-04T11:30:00.000Z');
  });

  it('returns healthy=false when no non-ping interaction has ever happened', () => {
    const now = new Date('2026-05-04T12:00:00Z');
    const input: HealthInput = {
      tenantId: 1,
      now,
      lastNonPingRepliedAt: null,
      processStartedAt: new Date('2026-05-04T08:00:00Z'),
      thresholdSec: 600,
    };
    const result = computeHealthSignal(input);
    expect(result.healthy).toBe(false);
    expect(result.lastMessageHandledAt).toBeNull();
  });
});

describe('queryMaxNonPingRepliedAt — DB query shape (AC-005-1 + R5)', () => {
  it('builds query that excludes SYNTHETIC_PING and is tenant-scoped', async () => {
    const { queryMaxNonPingRepliedAt } = await import('../scripts/healthcheck-handler');
    const captured: { sql: string; params: unknown[] }[] = [];
    const mockDb = {
      execute: vi.fn(async (q: { sql?: string; params?: unknown[] }) => {
        captured.push({ sql: q.sql ?? '', params: q.params ?? [] });
        return [{ max: new Date('2026-05-04T11:55:00Z') }];
      }),
    };
    const result = await queryMaxNonPingRepliedAt(mockDb as never, 1);

    expect(result).toEqual(new Date('2026-05-04T11:55:00Z'));
    expect(captured).toHaveLength(1);
    const sqlText = captured[0]?.sql ?? '';
    // Must filter on tenant_id and exclude SYNTHETIC_PING.
    expect(sqlText.toLowerCase()).toContain('telegram_interactions');
    expect(sqlText.toLowerCase()).toContain('tenant_id');
    expect(sqlText).toContain('SYNTHETIC_PING');
    expect(sqlText.toLowerCase()).toContain('replied_at');
  });

  it('returns null when no rows match', async () => {
    const { queryMaxNonPingRepliedAt } = await import('../scripts/healthcheck-handler');
    const mockDb = {
      execute: vi.fn(async () => [{ max: null }]),
    };
    const result = await queryMaxNonPingRepliedAt(mockDb as never, 1);
    expect(result).toBeNull();
  });
});
