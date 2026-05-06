/**
 * AC-024-1 + R7-a stdout-shape -- one-tick logic tests.
 *
 * Per AC-024-1: each tick sequentially fetches:
 *   1. /api/cron/fire-due-executors
 *   2. /api/cron/close-due-sessions
 *   3. /api/cron/health
 * And logs a structured 6-key JSON line to process.stdout.write (NOT
 * console.log -- mirror channels topology).
 *
 * R7-a stdout-shape pin:
 *   - vi.spyOn(process.stdout, 'write') (not console.log)
 *   - JSON.parse(captured) has exactly { ts, tick_id, fire_status,
 *     close_status, health_status, duration_ms }
 *   - ts matches ISO8601 UTC regex
 *   - status fields are HTTP status numbers
 *   - duration_ms is a number
 *   - expect(stdoutSpy).toHaveBeenCalledTimes(1) catches wrong-spy regression
 */

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runOneTick } from '../src/tick';

const cronToken = randomBytes(32).toString('hex');

let fetchSpy: ReturnType<typeof vi.fn>;
// `vi.spyOn(process.stdout, 'write')` returns a MockInstance specialised to
// stdout.write's overload set; it does NOT assign to the bare-generic
// `ReturnType<typeof vi.spyOn>` (which uses `(...args: unknown[]) => unknown`).
// Annotating via `ReturnType<typeof vi.spyOn<typeof process.stdout, 'write'>>`
// also fails because the spyOn generic constraint excludes string-keyed
// methods on objects like WriteStream that mix data + method properties.
// The clean solution: hold the spy as `unknown` at the declaration site;
// at usage sites we only call `toHaveBeenCalledTimes` and `.mock.calls`,
// both of which are stable across MockInstance variants. Cast at usage to
// the minimal shape we need.
let stdoutSpy: unknown;

beforeEach(() => {
  process.env.CRON_SECRET = cronToken;
  process.env.VERCEL_BASE_URL = 'https://test.local';
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.VERCEL_BASE_URL;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AC-024-1 + R7-a -- runOneTick', () => {
  it('fires the 3 endpoints in order with CRON_SECRET bearer', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }));
    await runOneTick({ tickId: 1 });
    // 3 calls: fire, close, health.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const urls = fetchSpy.mock.calls.map((c) => c[0]) as string[];
    expect(urls[0]).toMatch(/\/api\/cron\/fire-due-executors$/);
    expect(urls[1]).toMatch(/\/api\/cron\/close-due-sessions$/);
    expect(urls[2]).toMatch(/\/api\/cron\/health$/);
    // Bearer is plumbed.
    for (const c of fetchSpy.mock.calls) {
      const init = c[1] as RequestInit;
      const auth = (init.headers as Record<string, string>).authorization;
      expect(auth).toBe(`Bearer ${cronToken}`);
    }
  });

  it('R7-a stdout-shape: emits one JSON line with 6 fields via process.stdout.write', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }));
    await runOneTick({ tickId: 42 });
    // The spy holds `unknown` at the let-declaration site (see top-of-file
    // comment for why); narrow at usage to the minimal MockInstance shape
    // we read here: `toHaveBeenCalledTimes` + `.mock.calls`.
    const stdout = stdoutSpy as {
      mock: { calls: unknown[][] };
    };
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const writeCall = stdout.mock.calls[0]?.[0];
    expect(typeof writeCall).toBe('string');
    const parsed = JSON.parse(String(writeCall).trim()) as Record<string, unknown>;
    // Exactly the 6 keys.
    const keys = Object.keys(parsed).sort();
    expect(keys).toEqual([
      'close_status',
      'duration_ms',
      'fire_status',
      'health_status',
      'tick_id',
      'ts',
    ]);
    // ts shape (ISO8601 UTC with optional fractional seconds).
    expect(typeof parsed.ts).toBe('string');
    expect(parsed.ts as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    // tick_id is a number.
    expect(typeof parsed.tick_id).toBe('number');
    expect(parsed.tick_id).toBe(42);
    // 3 status fields are HTTP numbers.
    expect(typeof parsed.fire_status).toBe('number');
    expect(typeof parsed.close_status).toBe('number');
    expect(typeof parsed.health_status).toBe('number');
    expect(parsed.fire_status).toBe(200);
    expect(parsed.close_status).toBe(200);
    expect(parsed.health_status).toBe(200);
    // duration_ms is a number.
    expect(typeof parsed.duration_ms).toBe('number');
  });

  it('AC-024-1 (b): one upstream timing out does NOT prevent the next two from running', async () => {
    // First call (fire) hangs/aborts; next two succeed.
    fetchSpy
      .mockRejectedValueOnce(new Error('AbortError: timeout'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const result = await runOneTick({ tickId: 7 });
    // The fire status is recorded as a sentinel (0 = network error / no
    // HTTP response received).
    expect(result.fire_status).toBe(0);
    expect(result.close_status).toBe(200);
    expect(result.health_status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('AC-024-1 (c): crash inside one fetch is caught + logged + does not throw', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    // No throw expected.
    const result = await runOneTick({ tickId: 11 });
    expect(result.close_status).toBe(0);
    // tick still completes -- next call reached.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
