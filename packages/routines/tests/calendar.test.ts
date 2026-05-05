/**
 * v1.1 #3 — calendar.ts unit tests.
 *
 * Output shape: { event_count, time_window_start, time_window_end, markdown,
 * events, degraded }.
 *
 * Behaviour:
 *   - Default 48h forward window from `now`
 *   - Default impact filter `medium` (High + Medium + Holiday)
 *   - Filter `high` keeps only High-impact events
 *   - Filter `all` keeps everything (incl. Low)
 *   - Items with non-parseable / missing date are dropped
 *   - Items outside the window are dropped
 *   - Items missing currency / impact are dropped
 *   - Events are sorted chronologically (earliest first)
 *   - Times are normalized to GMT/UTC ISO strings
 *
 * Degraded path (EC-002-1 graceful):
 *   - fetchAndRenderCalendar with unreachable feed → degraded:true, empty events
 *   - non-OK HTTP response → same
 *   - non-array JSON response → same
 */

import { describe, expect, it, vi } from 'vitest';
import {
  type CalendarFeedItem,
  fetchAndRenderCalendar,
  renderCalendarMarkdown,
} from '../src/calendar';

const NOW = new Date('2026-05-04T00:00:00Z');

function ev(
  partial: Partial<CalendarFeedItem> & {
    date: string;
    impact: string;
    country: string;
    title: string;
  },
): CalendarFeedItem {
  return {
    forecast: '',
    previous: '',
    ...partial,
  };
}

describe('renderCalendarMarkdown — output shape', () => {
  it('returns { event_count, time_window_start, time_window_end, markdown, events, degraded }', () => {
    const r = renderCalendarMarkdown([], { now: NOW });
    expect(r).toHaveProperty('event_count');
    expect(r).toHaveProperty('time_window_start');
    expect(r).toHaveProperty('time_window_end');
    expect(r).toHaveProperty('markdown');
    expect(r).toHaveProperty('events');
    expect(r).toHaveProperty('degraded');
    expect(r.degraded).toBe(false);
  });

  it('time_window_start = now ISO; time_window_end = now+48h ISO by default', () => {
    const r = renderCalendarMarkdown([], { now: NOW });
    expect(r.time_window_start).toBe('2026-05-04T00:00:00.000Z');
    expect(r.time_window_end).toBe('2026-05-06T00:00:00.000Z');
  });

  it('respects custom windowHours', () => {
    const r = renderCalendarMarkdown([], { now: NOW, windowHours: 24 });
    expect(r.time_window_end).toBe('2026-05-05T00:00:00.000Z');
  });
});

describe('renderCalendarMarkdown — empty input', () => {
  it('event_count = 0 and a "No events" markdown', () => {
    const r = renderCalendarMarkdown([], { now: NOW });
    expect(r.event_count).toBe(0);
    expect(r.events).toEqual([]);
    expect(r.markdown).toMatch(/No events in window/);
  });
});

describe('renderCalendarMarkdown — window filtering', () => {
  it('keeps events inside [now, now + windowHours]', () => {
    const items = [
      ev({ date: '2026-05-04T08:00:00Z', impact: 'High', country: 'USD', title: 'NFP' }),
      ev({ date: '2026-05-05T12:00:00Z', impact: 'High', country: 'EUR', title: 'ECB' }),
    ];
    const r = renderCalendarMarkdown(items, { now: NOW });
    expect(r.event_count).toBe(2);
  });

  it('drops events before now', () => {
    const items = [
      ev({ date: '2026-05-03T22:00:00Z', impact: 'High', country: 'USD', title: 'PAST' }),
      ev({ date: '2026-05-04T08:00:00Z', impact: 'High', country: 'USD', title: 'KEEP' }),
    ];
    const r = renderCalendarMarkdown(items, { now: NOW });
    expect(r.event_count).toBe(1);
    expect(r.events[0]?.title).toBe('KEEP');
  });

  it('drops events past the window end', () => {
    const items = [
      ev({ date: '2026-05-04T08:00:00Z', impact: 'High', country: 'USD', title: 'KEEP' }),
      ev({ date: '2026-05-07T08:00:00Z', impact: 'High', country: 'USD', title: 'TOO_FAR' }),
    ];
    const r = renderCalendarMarkdown(items, { now: NOW });
    expect(r.event_count).toBe(1);
    expect(r.events[0]?.title).toBe('KEEP');
  });

  it('handles upstream local-tz dates and normalizes to GMT', () => {
    // Feed default: ISO with -04:00 offset (EDT). 2026-05-04T08:00:00-04:00 = 12:00 GMT.
    const items = [
      ev({ date: '2026-05-04T08:00:00-04:00', impact: 'High', country: 'USD', title: 'EDT' }),
    ];
    const r = renderCalendarMarkdown(items, { now: NOW });
    expect(r.event_count).toBe(1);
    expect(r.events[0]?.time_gmt).toBe('2026-05-04T12:00:00.000Z');
  });
});

describe('renderCalendarMarkdown — impact filter', () => {
  const mixed = [
    ev({ date: '2026-05-04T08:00:00Z', impact: 'High', country: 'USD', title: 'NFP' }),
    ev({ date: '2026-05-04T09:00:00Z', impact: 'Medium', country: 'EUR', title: 'PMI' }),
    ev({ date: '2026-05-04T10:00:00Z', impact: 'Low', country: 'AUD', title: 'M3' }),
    ev({ date: '2026-05-04T11:00:00Z', impact: 'Holiday', country: 'JPY', title: 'GoldenWeek' }),
  ];

  it('default (medium): keeps High + Medium + Holiday, drops Low', () => {
    const r = renderCalendarMarkdown(mixed, { now: NOW });
    expect(r.event_count).toBe(3);
    expect(r.events.map((e) => e.title)).toEqual(['NFP', 'PMI', 'GoldenWeek']);
  });

  it('high: keeps only High', () => {
    const r = renderCalendarMarkdown(mixed, { now: NOW, impact: 'high' });
    expect(r.event_count).toBe(1);
    expect(r.events[0]?.title).toBe('NFP');
  });

  it('all: keeps everything', () => {
    const r = renderCalendarMarkdown(mixed, { now: NOW, impact: 'all' });
    expect(r.event_count).toBe(4);
  });
});

describe('renderCalendarMarkdown — defensive drops', () => {
  it('drops items without a parseable date', () => {
    const items = [
      ev({ date: '', impact: 'High', country: 'USD', title: 'NoDate' }),
      ev({ date: 'not-a-date', impact: 'High', country: 'USD', title: 'BadDate' }),
      ev({ date: '2026-05-04T08:00:00Z', impact: 'High', country: 'USD', title: 'OK' }),
    ];
    const r = renderCalendarMarkdown(items, { now: NOW });
    expect(r.event_count).toBe(1);
    expect(r.events[0]?.title).toBe('OK');
  });

  it('drops items missing currency', () => {
    const items = [
      ev({ date: '2026-05-04T08:00:00Z', impact: 'High', country: '', title: 'NoCurrency' }),
      ev({ date: '2026-05-04T09:00:00Z', impact: 'High', country: 'USD', title: 'OK' }),
    ];
    const r = renderCalendarMarkdown(items, { now: NOW });
    expect(r.event_count).toBe(1);
    expect(r.events[0]?.title).toBe('OK');
  });

  it('drops items with unrecognized impact', () => {
    const items = [
      ev({ date: '2026-05-04T08:00:00Z', impact: 'Critical', country: 'USD', title: 'Bad' }),
      ev({ date: '2026-05-04T09:00:00Z', impact: 'High', country: 'USD', title: 'OK' }),
    ];
    const r = renderCalendarMarkdown(items, { now: NOW });
    expect(r.event_count).toBe(1);
    expect(r.events[0]?.title).toBe('OK');
  });
});

describe('renderCalendarMarkdown — sort + render', () => {
  it('sorts events chronologically (earliest first)', () => {
    const items = [
      ev({ date: '2026-05-05T12:00:00Z', impact: 'High', country: 'EUR', title: 'LATER' }),
      ev({ date: '2026-05-04T08:00:00Z', impact: 'High', country: 'USD', title: 'EARLIER' }),
    ];
    const r = renderCalendarMarkdown(items, { now: NOW });
    expect(r.events.map((e) => e.title)).toEqual(['EARLIER', 'LATER']);
  });

  it('renders a markdown table with Time/Currency/Impact/Title columns', () => {
    const items = [
      ev({
        date: '2026-05-04T08:00:00Z',
        impact: 'High',
        country: 'USD',
        title: 'NFP',
        forecast: '180k',
        previous: '150k',
      }),
    ];
    const r = renderCalendarMarkdown(items, { now: NOW });
    expect(r.markdown).toMatch(
      /Time \(GMT\) \| Currency \| Impact \| Title \| Forecast \| Previous/,
    );
    expect(r.markdown).toMatch(/2026-05-04T08:00:00\.000Z \| USD \| High \| NFP \| 180k \| 150k/);
  });

  it('escapes pipe chars in titles to keep the markdown table valid', () => {
    const items = [
      ev({ date: '2026-05-04T08:00:00Z', impact: 'High', country: 'USD', title: 'A|B Test' }),
    ];
    const r = renderCalendarMarkdown(items, { now: NOW });
    expect(r.markdown).toMatch(/A\\\|B Test/);
  });
});

describe('fetchAndRenderCalendar — graceful degradation', () => {
  it('feed unreachable (fetch throws) → degraded:true with empty events', async () => {
    const fakeFetch = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const r = await fetchAndRenderCalendar({
      fetch: fakeFetch as unknown as typeof fetch,
      now: NOW,
    });
    expect(r.degraded).toBe(true);
    expect(r.event_count).toBe(0);
    expect(r.markdown).toMatch(/Feed unreachable/);
  });

  it('non-OK HTTP response → degraded:true', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response);
    const r = await fetchAndRenderCalendar({
      fetch: fakeFetch as unknown as typeof fetch,
      now: NOW,
    });
    expect(r.degraded).toBe(true);
  });

  it('non-array JSON body → degraded:true', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: 'bad shape' }),
    } as unknown as Response);
    const r = await fetchAndRenderCalendar({
      fetch: fakeFetch as unknown as typeof fetch,
      now: NOW,
    });
    expect(r.degraded).toBe(true);
  });

  it('OK + array → renders normally', async () => {
    const feedJson = [
      {
        title: 'NFP',
        country: 'USD',
        date: '2026-05-04T08:00:00Z',
        impact: 'High',
        forecast: '',
        previous: '',
      },
    ];
    const fakeFetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => feedJson } as unknown as Response);
    const r = await fetchAndRenderCalendar({
      fetch: fakeFetch as unknown as typeof fetch,
      now: NOW,
    });
    expect(r.degraded).toBe(false);
    expect(r.event_count).toBe(1);
    expect(r.events[0]?.title).toBe('NFP');
  });
});
