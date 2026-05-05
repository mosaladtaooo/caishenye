/**
 * v1.1 — indicators.ts unit tests.
 *
 * Helper validates:
 *   - Indicator allowlist (8 names)
 *   - MT5 timeframe → TwelveData interval mapping
 *   - Symbol normalization (slash insert, uppercase)
 *   - Twelvedata URL construction (apikey + format + timezone + outputsize, optional time_period)
 *   - Pass-through of TwelveData "values" + "meta"
 *   - Degraded paths: fetch throws / non-OK / non-object body / status:error body
 */

import { describe, expect, it, vi } from 'vitest';
import {
  fetchIndicator,
  isValidIndicator,
  isValidMt5Timeframe,
  mt5TimeframeToInterval,
  normalizeSymbol,
} from '../src/indicators';

describe('indicator allowlist', () => {
  it('accepts the 8 documented indicators', () => {
    for (const i of ['ema', 'rsi', 'macd', 'adx', 'bbands', 'stoch', 'atr', 'vwap']) {
      expect(isValidIndicator(i)).toBe(true);
    }
  });

  it('rejects unknown indicator names', () => {
    for (const i of ['', 'foo', 'EMA', 'cci', 'sma']) {
      expect(isValidIndicator(i)).toBe(false);
    }
  });
});

describe('MT5 timeframe → TwelveData interval', () => {
  it('maps every MT5 timeframe', () => {
    expect(mt5TimeframeToInterval('M1')).toBe('1min');
    expect(mt5TimeframeToInterval('M5')).toBe('5min');
    expect(mt5TimeframeToInterval('M15')).toBe('15min');
    expect(mt5TimeframeToInterval('M30')).toBe('30min');
    expect(mt5TimeframeToInterval('H1')).toBe('1h');
    expect(mt5TimeframeToInterval('H4')).toBe('4h');
    expect(mt5TimeframeToInterval('D1')).toBe('1day');
    expect(mt5TimeframeToInterval('W1')).toBe('1week');
    expect(mt5TimeframeToInterval('MN1')).toBe('1month');
  });

  it('isValidMt5Timeframe accepts every MT5 form, rejects others', () => {
    expect(isValidMt5Timeframe('H4')).toBe(true);
    expect(isValidMt5Timeframe('M15')).toBe(true);
    expect(isValidMt5Timeframe('h4')).toBe(false);
    expect(isValidMt5Timeframe('4h')).toBe(false);
    expect(isValidMt5Timeframe('')).toBe(false);
  });
});

describe('normalizeSymbol', () => {
  it('passes slash-form through unchanged (uppercased)', () => {
    expect(normalizeSymbol('EUR/USD')).toBe('EUR/USD');
    expect(normalizeSymbol('eur/usd')).toBe('EUR/USD');
    expect(normalizeSymbol('XAU/USD')).toBe('XAU/USD');
  });

  it('inserts a slash for 6-char concatenated form', () => {
    expect(normalizeSymbol('EURUSD')).toBe('EUR/USD');
    expect(normalizeSymbol('xauusd')).toBe('XAU/USD');
    expect(normalizeSymbol('GBPJPY')).toBe('GBP/JPY');
  });

  it('leaves non-6-char ambiguous strings alone (e.g. crypto, indices)', () => {
    // Not in v1 scope; helper doesn't try to be clever.
    expect(normalizeSymbol('SPX500')).toBe('SPX500');
    expect(normalizeSymbol('btc/usdt')).toBe('BTC/USDT');
  });
});

describe('fetchIndicator — URL + parameters', () => {
  function captureFetch() {
    const calls: string[] = [];
    const fakeFetch = vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ meta: {}, values: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    return { fakeFetch, calls };
  }

  it('builds a /atr URL with required params', async () => {
    const { fakeFetch, calls } = captureFetch();
    await fetchIndicator(
      { fetch: fakeFetch as unknown as typeof fetch, apiKey: 'K' },
      {
        indicator: 'atr',
        symbol: 'XAU/USD',
        interval: '4h',
        time_period: 14,
      },
    );
    expect(calls).toHaveLength(1);
    const url = calls[0]!;
    expect(url).toMatch(/^https:\/\/api\.twelvedata\.com\/atr\?/);
    expect(url).toContain('symbol=XAU%2FUSD');
    expect(url).toContain('interval=4h');
    expect(url).toContain('apikey=K');
    expect(url).toContain('format=JSON');
    expect(url).toContain('timezone=Etc%2FGMT');
    expect(url).toContain('outputsize=30');
    expect(url).toContain('time_period=14');
  });

  it('omits time_period when not provided', async () => {
    const { fakeFetch, calls } = captureFetch();
    await fetchIndicator(
      { fetch: fakeFetch as unknown as typeof fetch, apiKey: 'K' },
      { indicator: 'rsi', symbol: 'EUR/USD', interval: '1h' },
    );
    expect(calls[0]).not.toContain('time_period');
  });

  it('honours custom outputsize', async () => {
    const { fakeFetch, calls } = captureFetch();
    await fetchIndicator(
      { fetch: fakeFetch as unknown as typeof fetch, apiKey: 'K' },
      { indicator: 'rsi', symbol: 'EUR/USD', interval: '15min', outputsize: 100 },
    );
    expect(calls[0]).toContain('outputsize=100');
  });

  it('honours injected baseUrl override', async () => {
    const { fakeFetch, calls } = captureFetch();
    await fetchIndicator(
      {
        fetch: fakeFetch as unknown as typeof fetch,
        apiKey: 'K',
        baseUrl: 'http://localhost:9999',
      },
      { indicator: 'rsi', symbol: 'EUR/USD', interval: '1h' },
    );
    expect(calls[0]).toMatch(/^http:\/\/localhost:9999\/rsi\?/);
  });
});

describe('fetchIndicator — happy path', () => {
  it('passes through values + meta on a normal upstream response', async () => {
    const upstream = {
      meta: {
        symbol: 'EUR/USD',
        interval: '1h',
        currency_base: 'Euro',
        currency_quote: 'US Dollar',
      },
      values: [
        { datetime: '2026-05-05 14:00:00', rsi: '53.21' },
        { datetime: '2026-05-05 13:00:00', rsi: '51.10' },
      ],
    };
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(upstream), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const r = await fetchIndicator(
      { fetch: fakeFetch as unknown as typeof fetch, apiKey: 'K' },
      { indicator: 'rsi', symbol: 'EUR/USD', interval: '1h' },
    );
    expect(r.degraded).toBe(false);
    expect(r.values).toHaveLength(2);
    expect(r.values[0]?.rsi).toBe('53.21');
    expect(r.meta.symbol).toBe('EUR/USD');
  });
});

describe('fetchIndicator — degraded paths', () => {
  it('fetch throws → degraded:true with error_message', async () => {
    const fakeFetch = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const r = await fetchIndicator(
      { fetch: fakeFetch as unknown as typeof fetch, apiKey: 'K' },
      { indicator: 'atr', symbol: 'XAU/USD', interval: '4h' },
    );
    expect(r.degraded).toBe(true);
    expect(r.values).toEqual([]);
    expect(r.error_message).toMatch(/ENOTFOUND/);
  });

  it('non-OK HTTP response → degraded:true', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(new Response('boom', { status: 503 }));
    const r = await fetchIndicator(
      { fetch: fakeFetch as unknown as typeof fetch, apiKey: 'K' },
      { indicator: 'atr', symbol: 'XAU/USD', interval: '4h' },
    );
    expect(r.degraded).toBe(true);
    expect(r.error_message).toMatch(/HTTP 503/);
  });

  it('non-object JSON body → degraded:true', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(['array', 'not', 'object']), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const r = await fetchIndicator(
      { fetch: fakeFetch as unknown as typeof fetch, apiKey: 'K' },
      { indicator: 'atr', symbol: 'XAU/USD', interval: '4h' },
    );
    expect(r.degraded).toBe(true);
  });

  it('TwelveData error body { status:"error", message } → degraded:true with the message', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'error',
          code: 401,
          message: 'You have exceeded the API request limit',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const r = await fetchIndicator(
      { fetch: fakeFetch as unknown as typeof fetch, apiKey: 'BAD' },
      { indicator: 'atr', symbol: 'XAU/USD', interval: '4h' },
    );
    expect(r.degraded).toBe(true);
    expect(r.error_message).toMatch(/exceeded the API request limit/);
  });
});
