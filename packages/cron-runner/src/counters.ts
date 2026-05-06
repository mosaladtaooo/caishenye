/**
 * cron-runner counters -- AC-024-8 + AC-024-9.
 *
 * Per-endpoint independent consecutive-non-2xx counter with alert-emit
 * thresholds + 1-alert-per-hour-per-failure-mode cap.
 *
 * AC-024-8 (DB-write detection): cron/health failures at >=5 consecutive
 * non-2xx -> kind='db_write_failure' alert.
 *
 * AC-024-9 (alive-but-failing): fire-due-executors / close-due-sessions
 * failures at >=3 consecutive non-2xx -> kind='alive_but_failing' alert.
 *
 * Counter resets on 2xx for that endpoint. Alerts cap at 1 per hour per
 * (kind, endpoint) tuple.
 */

const FIRE = 'fire-due-executors' as const;
const CLOSE = 'close-due-sessions' as const;
const HEALTH = 'cron/health' as const;

export type EndpointName = typeof FIRE | typeof CLOSE | typeof HEALTH;

const DB_FAILURE_THRESHOLD = 5;
const ALIVE_BUT_FAILING_THRESHOLD = 3;
const ALERT_COOLDOWN_MS = 60 * 60_000; // 1 hour

interface CounterEntry {
  consecutive: number;
}

export interface CounterState {
  perEndpoint: Map<EndpointName, CounterEntry>;
  /** Last alert emit timestamp keyed by `${kind}|${endpoint}`. */
  lastAlertAt: Map<string, number>;
}

export interface AlertEvent {
  kind: 'db_write_failure' | 'alive_but_failing';
  endpoint: EndpointName;
  consecutive: number;
  status: number;
}

export interface TickResult {
  alertsToEmit: AlertEvent[];
}

export function newCounters(): CounterState {
  return {
    perEndpoint: new Map(),
    lastAlertAt: new Map(),
  };
}

/**
 * Process one tick's per-endpoint HTTP statuses; mutate counter state and
 * return any alerts that should be emitted this tick.
 */
export function recordTickResult(
  state: CounterState,
  statusByEndpoint: Record<EndpointName, number>,
): TickResult {
  const alertsToEmit: AlertEvent[] = [];
  for (const endpoint of [FIRE, CLOSE, HEALTH] as EndpointName[]) {
    const status = statusByEndpoint[endpoint];
    const entry = state.perEndpoint.get(endpoint) ?? { consecutive: 0 };

    if (status >= 200 && status < 300) {
      entry.consecutive = 0;
    } else {
      entry.consecutive += 1;

      // Threshold check -- emit at the threshold tick only (avoid spam on
      // higher counts within the same streak).
      const kind: AlertEvent['kind'] | null =
        endpoint === HEALTH
          ? entry.consecutive === DB_FAILURE_THRESHOLD
            ? 'db_write_failure'
            : null
          : entry.consecutive === ALIVE_BUT_FAILING_THRESHOLD
            ? 'alive_but_failing'
            : null;

      if (kind !== null) {
        const cooldownKey = `${kind}|${endpoint}`;
        const lastAt = state.lastAlertAt.get(cooldownKey) ?? 0;
        const now = Date.now();
        if (now - lastAt >= ALERT_COOLDOWN_MS) {
          alertsToEmit.push({
            kind,
            endpoint,
            consecutive: entry.consecutive,
            status,
          });
          state.lastAlertAt.set(cooldownKey, now);
        }
      }
    }

    state.perEndpoint.set(endpoint, entry);
  }
  return { alertsToEmit };
}
