/**
 * FR-014 — News fetch + markdown rendering port from n8n.
 *
 * Verbatim port of `Code in JavaScript5` from `财神爷 Agent.json`. The
 * Planner system prompt downstream depends on this output shape — see
 * AC-014-3.
 *
 * Output shape:
 *   { news_count, time_window_start, markdown }
 *
 * Behavior:
 *   - 24h sliding window from `now`
 *   - Items missing isoDate are dropped (defensive)
 *   - HTML tags stripped from contentSnippet/description
 *   - Whitespace runs collapsed to single space
 *   - Sorted newest-first
 *   - Rendered as `## News Summary (Last 24 Hours)\n\n### N. Title\n**Time:** ...\n**Summary:** ...\n\n---\n`
 *   - Empty result yields the canonical "No news found in the last 24 hours."
 *
 * Constitution §5 — all timestamps GMT/UTC.
 */

const TARGET_TIMEZONE = 'UTC';
const HOURS_TO_LOOK_BACK = 24;

/** Single RSS item as the n8n RSS-Feed-Read node delivers it. */
export interface NewsFetchInput {
  title?: string;
  isoDate?: string;
  contentSnippet?: string;
  description?: string;
}

export type NewsItem = NewsFetchInput;

export interface NewsRenderResult {
  news_count: number;
  /** ISO 8601 UTC string — the cutoff used for filtering. */
  time_window_start: string;
  markdown: string;
}

export interface NewsRenderOptions {
  /** Injected clock — tests pass a frozen Date so the 24h window is deterministic. */
  now?: Date;
}

function getGMTTime(isoDate: string): string {
  return new Date(isoDate).toLocaleTimeString('en-US', {
    timeZone: TARGET_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function getGMTDateDisplay(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString('en-US', {
    timeZone: TARGET_TIMEZONE,
    month: 'short',
    day: 'numeric',
  });
}

function stripHtmlAndCollapse(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/<[^>]*>?/gm, '')
    .trim();
}

/**
 * Render the news markdown block the Planner system prompt expects.
 *
 * Pure function — does not perform network I/O. Callers fetch the RSS feed
 * and pass parsed items here. This isolation makes the function trivially
 * testable against frozen fixtures.
 */
export function renderNewsMarkdown(
  items: readonly NewsFetchInput[],
  opts: NewsRenderOptions = {},
): NewsRenderResult {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - HOURS_TO_LOOK_BACK * 60 * 60 * 1000);

  const filtered = items
    .filter((item): item is NewsFetchInput & { isoDate: string } => {
      if (!item.isoDate) return false;
      const itemDate = new Date(item.isoDate);
      if (Number.isNaN(itemDate.getTime())) return false;
      return itemDate >= cutoff;
    })
    .map((item) => {
      const cleanDesc = stripHtmlAndCollapse(item.contentSnippet ?? item.description ?? '');
      return {
        title: item.title ?? '(untitled)',
        isoDate: item.isoDate,
        dateDisplay: `${getGMTDateDisplay(item.isoDate)} ${getGMTTime(item.isoDate)}`,
        description: cleanDesc,
      };
    })
    .sort((a, b) => new Date(b.isoDate).getTime() - new Date(a.isoDate).getTime());

  let markdown: string;
  if (filtered.length === 0) {
    markdown = `No news found in the last ${HOURS_TO_LOOK_BACK} hours.`;
  } else {
    markdown = `## News Summary (Last ${HOURS_TO_LOOK_BACK} Hours)\n\n`;
    filtered.forEach((news, index) => {
      markdown += `### ${index + 1}. ${news.title}\n`;
      markdown += `**Time:** ${news.dateDisplay} (${TARGET_TIMEZONE})\n`;
      markdown += `**Summary:** ${news.description}\n`;
      markdown += `\n---\n\n`;
    });
  }

  return {
    news_count: filtered.length,
    time_window_start: cutoff.toISOString(),
    markdown,
  };
}

/**
 * Convenience wrapper: fetch the RSS feed via the operator's existing
 * connector + render. Caller can inject `fetch` for testability.
 *
 * The Planner routine will call this from inside its Bash step.
 *
 * The default URL is the same `investinglive.com/feed/` the n8n workflow
 * uses; operator can override via `feedUrl` env if needed.
 */
export interface FetchAndRenderDeps {
  fetch: typeof fetch;
  feedUrl?: string;
  now?: Date;
  /**
   * Pluggable RSS parser — defaults to a minimal regex-based parser that
   * handles the feed's actual shape. Operator may swap in a heavier
   * dedicated parser if the feed shape changes.
   */
  parseRss?: (xml: string) => NewsFetchInput[];
}

export async function fetchAndRenderNews(deps: FetchAndRenderDeps): Promise<NewsRenderResult> {
  const url = deps.feedUrl ?? 'https://investinglive.com/feed/';
  let items: NewsFetchInput[] = [];
  try {
    const resp = await deps.fetch(url, { method: 'GET' });
    if (!resp.ok) {
      return renderNewsMarkdown([], { now: deps.now });
    }
    const xml = await resp.text();
    const parser = deps.parseRss ?? parseRssMinimal;
    items = parser(xml);
  } catch {
    // EC-014-1: feed unreachable — fall through to the empty-input branch.
    return renderNewsMarkdown([], { now: deps.now });
  }
  return renderNewsMarkdown(items, { now: deps.now });
}

/**
 * Minimal RSS 2.0 parser — extracts <item> children with title, pubDate,
 * description. Sufficient for investinglive.com's feed shape; not a
 * general-purpose RSS parser. Operator can swap in a heavier alternative
 * via the `parseRss` injection if the feed structure changes.
 */
export function parseRssMinimal(xml: string): NewsFetchInput[] {
  const items: NewsFetchInput[] = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  for (const match of xml.matchAll(itemRe)) {
    const block = match[1] ?? '';
    items.push({
      title: extractTag(block, 'title'),
      isoDate: parsePubDate(extractTag(block, 'pubDate') ?? extractTag(block, 'dc:date')),
      contentSnippet: extractTag(block, 'description'),
    });
  }
  return items;
}

function extractTag(block: string, tag: string): string | undefined {
  // Handle <tag>...</tag> AND <tag><![CDATA[...]]></tag>.
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'i');
  const m = block.match(re);
  if (!m) return undefined;
  return (m[1] ?? '').trim();
}

function parsePubDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}
