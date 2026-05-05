/**
 * v1.1 — TwelveData technical-indicator fetch.
 *
 * The verbatim SPARTAN system prompt mandates indicator analysis
 * (Stochastic %K/%D, RSI levels, ATR for the SL+ATR-buffer mandate). The
 * n8n executor used a `technical indicators5` HTTP-tool that called
 * `https://api.twelvedata.com/{indicator}` directly. The new system needs
 * the same data path but routed through Vercel so:
 *   - the API key never leaves Vercel (Routine cannot exfiltrate it via
 *     `echo $TWELVEDATA_API_KEY` since the routine's Cloud Env doesn't have it)
 *   - all calls log against the same INTERNAL_API_TOKEN audit pattern as the
 *     other internal routes
 *
 * This module is the pure helper. The route handler at
 * `app/api/internal/indicators/route.ts` reads TWELVEDATA_API_KEY from env
 * and passes it in here.
 *
 * Allowed indicators (matches n8n's tool description):
 *   ema, rsi, macd, adx, bbands, stoch, atr, vwap
 *
 * Output shape:
 *   { indicator, symbol, interval, values[], meta, degraded }
 *
 * `values` is the upstream TwelveData "values" array verbatim — each
 * indicator has its own column shape (RSI: rsi; MACD: macd, macd_signal,
 * macd_hist; etc.). Pass-through keeps the helper indicator-agnostic.
 *
 * Degraded path (consistent with calendar.ts + news.ts):
 *   - upstream unreachable / non-OK / non-JSON → degraded:true, empty values
 *   - upstream returns `{status:"error", message:"..."}` → degraded:true,
 *     message preserved in `meta.error_message`
 *
 * Constitution §15 LOUD failure: caller (the route) is responsible for
 * 500'ing if TWELVEDATA_API_KEY env is missing — this helper trusts the
 * caller to pass a non-empty `apiKey`.
 */

const DEFAULT_BASE_URL = 'https://api.twelvedata.com';

export type IndicatorName = 'ema' | 'rsi' | 'macd' | 'adx' | 'bbands' | 'stoch' | 'atr' | 'vwap';

const VALID_INDICATORS = new Set<IndicatorName>([
  'ema',
  'rsi',
  'macd',
  'adx',
  'bbands',
  'stoch',
  'atr',
  'vwap',
]);

/** MT5 timeframes accepted by the route (consistent with mt5/candles). */
export type Mt5Timeframe = 'M1' | 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D1' | 'W1' | 'MN1';

/** TwelveData interval format. */
export type TwelveDataInterval =
  | '1min'
  | '5min'
  | '15min'
  | '30min'
  | '1h'
  | '4h'
  | '1day'
  | '1week'
  | '1month';

const TIMEFRAME_TO_INTERVAL: Record<Mt5Timeframe, TwelveDataInterval> = {
  M1: '1min',
  M5: '5min',
  M15: '15min',
  M30: '30min',
  H1: '1h',
  H4: '4h',
  D1: '1day',
  W1: '1week',
  MN1: '1month',
};

export function isValidIndicator(name: string): name is IndicatorName {
  return VALID_INDICATORS.has(name as IndicatorName);
}

export function isValidMt5Timeframe(tf: string): tf is Mt5Timeframe {
  return tf in TIMEFRAME_TO_INTERVAL;
}

export function mt5TimeframeToInterval(tf: Mt5Timeframe): TwelveDataInterval {
  return TIMEFRAME_TO_INTERVAL[tf];
}

/**
 * Normalize a forex pair to TwelveData's slash form. Accepts:
 *   - "EUR/USD" → "EUR/USD"
 *   - "EURUSD" → "EUR/USD"  (insert / after first 3 chars)
 *   - "XAU/USD" / "XAUUSD" → "XAU/USD"
 * Caller is expected to pass currency pairs / metals; equities/crypto
 * tickers may not roundtrip but aren't in v1 scope.
 */
export function normalizeSymbol(raw: string): string {
  const t = raw.trim().toUpperCase();
  if (t.includes('/')) return t;
  // Only insert a slash for the 6-letter forex/metals form (e.g. EURUSD,
  // XAUUSD). Numeric / mixed strings (SPX500, NAS100, BTC50, …) pass
  // through unchanged — those aren't in v1 scope and shouldn't be silently
  // mangled.
  if (t.length === 6 && /^[A-Z]{6}$/.test(t)) {
    return `${t.slice(0, 3)}/${t.slice(3)}`;
  }
  return t;
}

export interface IndicatorResult {
  indicator: IndicatorName;
  symbol: string;
  interval: TwelveDataInterval;
  /** TwelveData "values" array verbatim. Each entry has at least a `datetime` plus indicator-specific cols. */
  values: ReadonlyArray<Record<string, string>>;
  /** Upstream "meta" block (symbol, interval, currency_base, currency_quote, ...). May be empty if degraded. */
  meta: Record<string, string>;
  degraded: boolean;
  /** Populated when degraded:true — upstream error message OR transport error string. */
  error_message?: string;
}

export interface FetchIndicatorDeps {
  fetch: typeof fetch;
  /** Twelvedata API key. Caller (route) reads from env; helper doesn't peek at process.env. */
  apiKey: string;
  /** Override base URL — test injection. */
  baseUrl?: string;
}

export interface FetchIndicatorArgs {
  indicator: IndicatorName;
  /** TwelveData-form symbol e.g. "EUR/USD". Use normalizeSymbol() at the route layer if you receive "EURUSD". */
  symbol: string;
  /** TwelveData interval form. Use mt5TimeframeToInterval() to translate from MT5 form. */
  interval: TwelveDataInterval;
  /** Number of historical values to return. Defaults to 30. */
  outputsize?: number;
  /** Indicator-specific period (e.g., RSI period 14, ATR period 14). Optional — TwelveData has sane defaults. */
  time_period?: number;
}

export async function fetchIndicator(
  deps: FetchIndicatorDeps,
  args: FetchIndicatorArgs,
): Promise<IndicatorResult> {
  const base = deps.baseUrl ?? DEFAULT_BASE_URL;
  const params = new URLSearchParams({
    symbol: args.symbol,
    interval: args.interval,
    apikey: deps.apiKey,
    format: 'JSON',
    timezone: 'Etc/GMT',
    outputsize: String(args.outputsize ?? 30),
  });
  if (typeof args.time_period === 'number' && args.time_period > 0) {
    params.set('time_period', String(args.time_period));
  }
  const url = `${base.replace(/\/$/, '')}/${args.indicator}?${params.toString()}`;

  const baseDegraded = (msg: string): IndicatorResult => ({
    indicator: args.indicator,
    symbol: args.symbol,
    interval: args.interval,
    values: [],
    meta: {},
    degraded: true,
    error_message: msg,
  });

  let raw: unknown;
  try {
    const resp = await deps.fetch(url, { method: 'GET' });
    if (!resp.ok) {
      return baseDegraded(`upstream HTTP ${resp.status}`);
    }
    raw = await resp.json();
  } catch (e) {
    return baseDegraded(e instanceof Error ? e.message : String(e));
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return baseDegraded('upstream returned non-object body');
  }
  const body = raw as Record<string, unknown>;

  // TwelveData error response shape: { status: "error", message: "...", code: ... }
  if (body.status === 'error') {
    const msg = typeof body.message === 'string' ? body.message : 'unknown twelvedata error';
    return baseDegraded(msg);
  }

  const values = Array.isArray(body.values) ? (body.values as Record<string, string>[]) : [];
  const meta =
    body.meta && typeof body.meta === 'object' ? (body.meta as Record<string, string>) : {};

  return {
    indicator: args.indicator,
    symbol: args.symbol,
    interval: args.interval,
    values,
    meta,
    degraded: false,
  };
}
