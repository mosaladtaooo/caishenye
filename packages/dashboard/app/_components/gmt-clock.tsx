'use client';

/**
 * GMT-clock readout in the topbar. Updates every second client-side. No
 * SWR, no polling — pure local time formatted in monospace so the operator
 * always sees the system reference frame.
 */

import { useEffect, useState } from 'react';

function fmt(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}:${ss} GMT`;
}

export function GmtClock(): React.ReactElement {
  const [now, setNow] = useState<string>(() => fmt(new Date()));
  useEffect(() => {
    const id = setInterval(() => setNow(fmt(new Date())), 1_000);
    return () => clearInterval(id);
  }, []);
  return <span className="mono subtle">{now}</span>;
}
