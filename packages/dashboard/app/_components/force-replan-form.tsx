'use client';

/**
 * Force-replan client form. Fetches a CSRF token from /api/csrf, then POSTs
 * to /api/overrides/replan. Handles the AC-018-3 cap-confirm flow: a 409
 * response prompts the operator to retry with confirm_low_cap=true.
 */

import { useState } from 'react';

export function ForceReplanForm(): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>('');

  async function handleClick(forceLowCap: boolean): Promise<void> {
    setBusy(true);
    setResult('');
    try {
      const csrfRes = await fetch('/api/csrf', { method: 'GET' });
      if (!csrfRes.ok) throw new Error('csrf token fetch failed');
      const { csrf } = (await csrfRes.json()) as { csrf: string };
      const body: Record<string, unknown> = { csrf };
      if (forceLowCap) body.confirm_low_cap = true;
      const res = await fetch('/api/overrides/replan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 409) {
        const j = (await res.json()) as { capRemaining: number };
        setResult(
          `Cap warning: only ${j.capRemaining} slots remain today. Confirm by clicking Force re-plan (low cap) below.`,
        );
        setBusy(false);
        return;
      }
      if (!res.ok) {
        const t = await res.text();
        setResult(`Replan failed (${res.status}): ${t.slice(0, 200)}`);
        setBusy(false);
        return;
      }
      const j = (await res.json()) as { anthropicOneOffId: string };
      setResult(`Replan fired. New anthropic_one_off_id: ${j.anthropicOneOffId}`);
    } catch (e) {
      setResult(`Replan error: ${e instanceof Error ? e.message : String(e)}`);
    }
    setBusy(false);
  }

  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy}
        onClick={() => handleClick(false)}
      >
        Force re-plan
      </button>
      <button
        type="button"
        className="btn btn-warn"
        disabled={busy}
        onClick={() => handleClick(true)}
      >
        Force re-plan (low cap)
      </button>
      {result ? (
        <p
          style={{
            width: '100%',
            color: 'var(--fg-muted)',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.8125rem',
          }}
        >
          {result}
        </p>
      ) : null}
    </div>
  );
}
