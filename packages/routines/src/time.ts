/**
 * Constitution §5: GMT/UTC time helpers.
 *
 * Every datetime in this codebase is GMT/UTC. The dashboard view layer is
 * the ONLY place local-time conversion happens — anywhere else (Planner
 * output, Executor input, audit rows, Telegram messages, dashboard API
 * responses) MUST stay in UTC.
 *
 * NFR-008: DST-day correctness. The functions below all use UTC accessors
 * (Date.getUTC*, toISOString) so DST has no effect.
 */

export type SessionName = 'EUR' | 'NY' | 'ASIA';

interface SessionWindow {
  /** Hours-of-day GMT, inclusive start. */
  startHour: number;
  /** Hours-of-day GMT, EXCLUSIVE end (for non-wrapping windows). */
  endHour: number;
  /** True if the window crosses midnight (e.g., ASIA 22:00–04:00). */
  wrapsMidnight: boolean;
}

const SESSION_WINDOWS: Record<SessionName, SessionWindow> = {
  EUR: { startHour: 7, endHour: 12, wrapsMidnight: false },
  NY: { startHour: 12, endHour: 17, wrapsMidnight: false },
  // ASIA wraps midnight — we encode as start 22:00, end 04:00 next-day.
  ASIA: { startHour: 22, endHour: 4, wrapsMidnight: true },
};

/**
 * Parse an ISO 8601 string and assert it carries the explicit UTC marker.
 *
 * Strings without a Z (or +00:00) suffix are rejected — bare YYYY-MM-DDTHH:MM:SS
 * has no defined timezone and would silently use the host TZ.
 */
export function parseGmtIsoString(s: string): Date {
  if (!/Z$|[+-]00:00$/.test(s)) {
    throw new Error(
      `parseGmtIsoString: input "${s}" is missing UTC marker (expected Z or +00:00 suffix)`,
    );
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`parseGmtIsoString: invalid ISO string "${s}"`);
  }
  return d;
}

/** ISO 8601 with Z suffix; same shape Postgres timestamptz returns. */
export function formatGmtTimestamp(d: Date): string {
  return d.toISOString();
}

/** YYYY-MM-DD in GMT. */
export function todayGmtIsoDate(d: Date = new Date()): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * True iff the given Date falls inside the GMT window for the named session.
 *
 * Used by:
 *   - Planner: filter session windows that align with NEWS-quarantine logic
 *   - Executor: assert it's actually IN its scheduled window before placing trades
 *   - Dashboard: highlight the current session in the Schedule view
 */
export function isGmtSessionWindow(d: Date, session: SessionName): boolean {
  const window = SESSION_WINDOWS[session];
  if (!window) {
    throw new Error(
      `isGmtSessionWindow: unknown session "${session}". Valid: ${Object.keys(SESSION_WINDOWS).join(', ')}`,
    );
  }
  const hour = d.getUTCHours();
  if (window.wrapsMidnight) {
    return hour >= window.startHour || hour < window.endHour;
  }
  return hour >= window.startHour && hour < window.endHour;
}
