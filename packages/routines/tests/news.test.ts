/**
 * FR-014 — News fetch + markdown rendering port from n8n.
 *
 * AC-014-1: TypeScript module ports `Code in JavaScript5` verbatim.
 * AC-014-2: Snapshot tests against frozen RSS fixtures verify identical
 *            output to the n8n version's behavior (24h window, GMT,
 *            sort newest-first, strip HTML, render specific markdown).
 * AC-014-3: Output shape: { news_count, time_window_start, markdown }.
 * EC-014-1: Feed unreachable → returns degraded shape with news_count=0
 *            and markdown="No news found in the last 24 hours."
 */

import { describe, expect, it } from 'vitest';
import { type NewsFetchInput, type NewsItem, renderNewsMarkdown } from '../src/news';
import sampleFeed from './fixtures/rss/sample-feed.json' with { type: 'json' };

describe('FR-014 AC-014-3: output shape', () => {
  it('returns { news_count, time_window_start, markdown }', () => {
    const result = renderNewsMarkdown([], { now: new Date('2026-05-03T15:00:00Z') });
    expect(result).toHaveProperty('news_count');
    expect(result).toHaveProperty('time_window_start');
    expect(result).toHaveProperty('markdown');
  });

  it('time_window_start is the cutoff = now - 24h, ISO 8601', () => {
    const now = new Date('2026-05-03T15:00:00Z');
    const result = renderNewsMarkdown([], { now });
    expect(result.time_window_start).toBe('2026-05-02T15:00:00.000Z');
  });
});

describe('FR-014 EC-014-1: empty input', () => {
  it('returns news_count=0 and the canonical "No news found" message', () => {
    const result = renderNewsMarkdown([], { now: new Date('2026-05-03T15:00:00Z') });
    expect(result.news_count).toBe(0);
    expect(result.markdown).toBe('No news found in the last 24 hours.');
  });
});

describe('FR-014 AC-014-1 + AC-014-2: filter to last 24h', () => {
  it('keeps items within the 24-hour window', () => {
    const items: NewsItem[] = (sampleFeed as { items: NewsFetchInput[] }).items;
    const result = renderNewsMarkdown(items, {
      now: new Date('2026-05-03T15:00:00Z'),
    });
    expect(result.news_count).toBe(3); // 3 fresh + 1 stale + 1 missing-isoDate
  });

  it('drops items older than 24h', () => {
    const items: NewsItem[] = (sampleFeed as { items: NewsFetchInput[] }).items;
    const result = renderNewsMarkdown(items, {
      now: new Date('2026-05-03T15:00:00Z'),
    });
    expect(result.markdown).not.toMatch(/Stale article from 2 days ago/);
  });

  it('drops items missing isoDate (does not crash)', () => {
    const items: NewsItem[] = (sampleFeed as { items: NewsFetchInput[] }).items;
    const result = renderNewsMarkdown(items, {
      now: new Date('2026-05-03T15:00:00Z'),
    });
    expect(result.markdown).not.toMatch(/Article missing isoDate/);
  });
});

describe('FR-014 AC-014-1: HTML stripping', () => {
  it('strips HTML tags from contentSnippet/description', () => {
    const items: NewsItem[] = [
      {
        title: 'HTML test',
        isoDate: '2026-05-03T14:00:00Z',
        contentSnippet: '<p>Hello <strong>world</strong> — see <a href="x">link</a>.</p>',
      },
    ];
    const result = renderNewsMarkdown(items, {
      now: new Date('2026-05-03T15:00:00Z'),
    });
    expect(result.markdown).not.toMatch(/<p>|<strong>|<a /);
    expect(result.markdown).toMatch(/Hello world — see link/);
  });

  it('collapses whitespace runs to a single space', () => {
    const items: NewsItem[] = [
      {
        title: 'Whitespace test',
        isoDate: '2026-05-03T14:00:00Z',
        contentSnippet: 'foo \t\n\n  bar  baz',
      },
    ];
    const result = renderNewsMarkdown(items, {
      now: new Date('2026-05-03T15:00:00Z'),
    });
    expect(result.markdown).toMatch(/foo bar baz/);
  });
});

describe('FR-014 AC-014-1: sort newest-first', () => {
  it('renders items in descending isoDate order', () => {
    const items: NewsItem[] = (sampleFeed as { items: NewsFetchInput[] }).items;
    const result = renderNewsMarkdown(items, {
      now: new Date('2026-05-03T15:00:00Z'),
    });
    // Find positions of the three fresh items in markdown.
    const fedIdx = result.markdown.indexOf('Fed minutes signal');
    const ecbIdx = result.markdown.indexOf("ECB's Lagarde");
    const usdjpyIdx = result.markdown.indexOf('USD/JPY surges');
    expect(fedIdx).toBeGreaterThan(-1);
    expect(ecbIdx).toBeGreaterThan(-1);
    expect(usdjpyIdx).toBeGreaterThan(-1);
    // Fed (14:30) > ECB (11:15) > USD/JPY (08:45) — fed-first.
    expect(fedIdx).toBeLessThan(ecbIdx);
    expect(ecbIdx).toBeLessThan(usdjpyIdx);
  });
});

describe('FR-014 AC-014-1: markdown shape — n8n golden form', () => {
  it('starts with the "## News Summary (Last 24 Hours)" heading', () => {
    const items: NewsItem[] = (sampleFeed as { items: NewsFetchInput[] }).items;
    const result = renderNewsMarkdown(items, {
      now: new Date('2026-05-03T15:00:00Z'),
    });
    expect(result.markdown).toMatch(/^## News Summary \(Last 24 Hours\)/);
  });

  it('numbers items 1, 2, 3, ... with "### N. Title" form', () => {
    const items: NewsItem[] = (sampleFeed as { items: NewsFetchInput[] }).items;
    const result = renderNewsMarkdown(items, {
      now: new Date('2026-05-03T15:00:00Z'),
    });
    expect(result.markdown).toMatch(/### 1\. /);
    expect(result.markdown).toMatch(/### 2\. /);
    expect(result.markdown).toMatch(/### 3\. /);
    expect(result.markdown).not.toMatch(/### 4\. /); // only 3 fresh
  });

  it('renders **Time:** and **Summary:** fields per item', () => {
    const items: NewsItem[] = (sampleFeed as { items: NewsFetchInput[] }).items;
    const result = renderNewsMarkdown(items, {
      now: new Date('2026-05-03T15:00:00Z'),
    });
    // 3 items → 3 occurrences each.
    const timeCount = (result.markdown.match(/\*\*Time:\*\*/g) ?? []).length;
    const summaryCount = (result.markdown.match(/\*\*Summary:\*\*/g) ?? []).length;
    expect(timeCount).toBe(3);
    expect(summaryCount).toBe(3);
  });

  it('separates items with the "---" hr', () => {
    const items: NewsItem[] = (sampleFeed as { items: NewsFetchInput[] }).items;
    const result = renderNewsMarkdown(items, {
      now: new Date('2026-05-03T15:00:00Z'),
    });
    const hrCount = (result.markdown.match(/^---$/gm) ?? []).length;
    expect(hrCount).toBe(3);
  });

  it('renders Time field in GMT/UTC timezone with Date-Time form', () => {
    const items: NewsItem[] = [
      {
        title: 'TZ test',
        isoDate: '2026-05-03T14:30:00Z',
        contentSnippet: 'x',
      },
    ];
    const result = renderNewsMarkdown(items, {
      now: new Date('2026-05-03T15:00:00Z'),
    });
    // Should contain "May 3" + "02:30 PM" + "(UTC)" — UTC == GMT for clock display.
    expect(result.markdown).toMatch(/\*\*Time:\*\*/);
    expect(result.markdown).toMatch(/\(UTC\)/);
  });
});

describe('FR-014 AC-014-1: full snapshot vs golden', () => {
  it('produces deterministic output for the frozen fixture', () => {
    const items: NewsItem[] = (sampleFeed as { items: NewsFetchInput[] }).items;
    const result = renderNewsMarkdown(items, {
      now: new Date('2026-05-03T15:00:00Z'),
    });
    // Snapshot test — locks the exact markdown shape against future drift.
    expect(result).toMatchInlineSnapshot(`
      {
        "markdown": "## News Summary (Last 24 Hours)

      ### 1. Fed minutes signal hawkish lean ahead of June meeting
      **Time:** May 3 02:30 PM (UTC)
      **Summary:** Federal Reserve officials emphasized inflation risks at their April meeting, with several members suggesting rates may need to stay higher for longer than markets expect.

      ---

      ### 2. ECB's Lagarde: progress on inflation insufficient for rate cut
      **Time:** May 3 11:15 AM (UTC)
      **Summary:** European Central Bank President Christine Lagarde said today that the bank needs more evidence inflation is sustainably returning to its 2% target before considering rate cuts.

      ---

      ### 3. USD/JPY surges past 156 on widening yield gap
      **Time:** May 3 08:45 AM (UTC)
      **Summary:** The yen weakened to a fresh multi-decade low against the dollar as a widening US-Japan yield differential continues to attract carry-trade flows.

      ---

      ",
        "news_count": 3,
        "time_window_start": "2026-05-02T15:00:00.000Z",
      }
    `);
  });
});
