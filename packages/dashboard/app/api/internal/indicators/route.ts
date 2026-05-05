/**
 * GET /api/internal/indicators — TwelveData technical-indicator proxy.
 *
 * v1.1 — adds the indicator path the verbatim SPARTAN system prompt
 * mandates (Stoch %K/%D, RSI levels, ATR for the SL+ATR-buffer mandate).
 * The n8n executor used `https://api.twelvedata.com/{indicator}` directly;
 * the new system routes through Vercel so the API key never leaves the
 * server-side env (Routines never see TWELVEDATA_API_KEY).
 *
 * Query params (all required unless noted):
 *   - indicator:  one of ema|rsi|macd|adx|bbands|stoch|atr|vwap
 *   - symbol:     "EUR/USD" or "EURUSD" (6-letter forex form auto-slashed);
 *                 metals like "XAU/USD" / "XAUUSD" supported
 *   - timeframe:  MT5 form (M1|M5|M15|M30|H1|H4|D1|W1|MN1) — translated
 *                 to TwelveData's interval form server-side
 *   - time_period: optional indicator-specific period (RSI 14, ATR 14, etc.)
 *   - outputsize:  optional history count (default 30, max 5000 per upstream)
 *
 * Response shape: { indicator, symbol, interval, values[], meta, degraded,
 * error_message? }. `values` is the upstream array verbatim (each
 * indicator has its own column shape — RSI: rsi; MACD: macd, macd_signal,
 * macd_hist; etc.).
 *
 * Degraded path (consistent with calendar / news): on upstream unreachable
 * / non-OK / TwelveData error body, return 200 with `degraded:true` +
 * empty values + `error_message`. Routine treats as "indicator
 * unavailable, fall back to inline-computed approximations from candle
 * OHLC". Does NOT 5xx — that would force a hard abort the verbatim prompt
 * doesn't expect.
 *
 * Constitution §15 LOUD: 500 if TWELVEDATA_API_KEY env is missing — that's
 * a server config bug, not a transient upstream failure.
 *
 * Vercel timeout: 15s. TwelveData typically <1s but freemium tier has
 * occasional slow path during regional spikes.
 */

import {
  fetchIndicator,
  type IndicatorName,
  isValidIndicator,
  isValidMt5Timeframe,
  type Mt5Timeframe,
  mt5TimeframeToInterval,
  normalizeSymbol,
} from '@caishen/routines/indicators';
import { validateInternalAuth } from '@/lib/internal-auth';
import { jsonRes } from '@/lib/internal-route-helpers';

export const maxDuration = 15;

const MAX_OUTPUTSIZE = 5000;

function parseOutputsize(raw: string | null): number | null {
  if (raw === null || raw.length === 0) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_OUTPUTSIZE) return null;
  return Math.floor(n);
}

function parseTimePeriod(raw: string | null): number | null {
  if (raw === null || raw.length === 0) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

export async function GET(req: Request): Promise<Response> {
  const authFail = validateInternalAuth(req);
  if (authFail) return authFail;

  const apiKey = process.env.TWELVEDATA_API_KEY ?? '';
  if (apiKey.length === 0) {
    return jsonRes(500, {
      error: 'indicators: server misconfigured (TWELVEDATA_API_KEY missing in Vercel env)',
    });
  }

  const url = new URL(req.url);
  const rawIndicator = (url.searchParams.get('indicator') ?? '').toLowerCase();
  const rawSymbol = url.searchParams.get('symbol') ?? '';
  const rawTimeframe = url.searchParams.get('timeframe') ?? '';

  if (!isValidIndicator(rawIndicator)) {
    return jsonRes(400, {
      error: `indicators: invalid 'indicator'; must be one of ema, rsi, macd, adx, bbands, stoch, atr, vwap`,
    });
  }
  if (rawSymbol.length === 0) {
    return jsonRes(400, { error: `indicators: missing 'symbol' query param` });
  }
  if (!isValidMt5Timeframe(rawTimeframe)) {
    return jsonRes(400, {
      error: `indicators: invalid 'timeframe'; must be one of M1, M5, M15, M30, H1, H4, D1, W1, MN1`,
    });
  }

  const indicator: IndicatorName = rawIndicator;
  const timeframe: Mt5Timeframe = rawTimeframe;
  const symbol = normalizeSymbol(rawSymbol);
  const interval = mt5TimeframeToInterval(timeframe);
  const outputsize = parseOutputsize(url.searchParams.get('outputsize'));
  const time_period = parseTimePeriod(url.searchParams.get('time_period'));

  try {
    const result = await fetchIndicator(
      { fetch, apiKey },
      {
        indicator,
        symbol,
        interval,
        ...(outputsize !== null && { outputsize }),
        ...(time_period !== null && { time_period }),
      },
    );
    return jsonRes(200, result);
  } catch (e) {
    // fetchIndicator catches its own fetch errors and returns degraded;
    // getting here means a programming bug.
    const msg = e instanceof Error ? e.message : String(e);
    return jsonRes(500, { error: `indicators: ${msg.slice(0, 256)}` });
  }
}
