'use client';

/**
 * Stale-state banner — AC-006-3.
 *
 * Polls /api/overview every 5s via SWR. Computes age = now - lastFetchOk.
 * Renders a yellow banner at >30s, red at >60s. Hidden when fresh.
 *
 * The actual `/api/overview` route handler ships in the next iteration —
 * for now this client component returns null when the endpoint is missing
 * (we degrade gracefully rather than fail the SSR pass).
 */

import { useEffect, useState } from 'react';
import useSWR from 'swr';

interface OverviewSnapshot {
  ts: string;
  balance: number | null;
  equity: number | null;
  openPositions: number;
}

const POLL_MS = 5_000;
const YELLOW_AGE_MS = 30_000;
const RED_AGE_MS = 60_000;

async function fetcher(url: string): Promise<OverviewSnapshot> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`overview: ${res.status}`);
  return (await res.json()) as OverviewSnapshot;
}

export function OverviewLiveBanner(): React.ReactElement | null {
  const { data, error } = useSWR<OverviewSnapshot>('/api/overview', fetcher, {
    refreshInterval: POLL_MS,
    revalidateOnFocus: false,
  });
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  if (error !== undefined) {
    return (
      <output className="banner banner-red">
        Live data unavailable — {error instanceof Error ? error.message : 'unknown error'}
      </output>
    );
  }
  if (!data) return null;

  const lastTs = Date.parse(data.ts);
  const age = now - lastTs;
  if (age <= YELLOW_AGE_MS) return null; // fresh
  const tone = age > RED_AGE_MS ? 'red' : 'yellow';
  return (
    <output className={`banner banner-${tone}`}>
      Stale: last MT5 read {Math.round(age / 1000)}s ago.
    </output>
  );
}
