'use client';

/**
 * Operator-side override forms — each fetches a fresh CSRF token, then
 * POSTs to its /api/overrides/* endpoint. All five live in one client
 * component so they share the result/feedback styling.
 *
 * Bound to the route handlers from session 3 (already CSRF-validated +
 * audit-row-wrapped on the server side).
 */

import { useId, useState } from 'react';

interface PostResult {
  ok: boolean;
  message: string;
}

async function postOverride(endpoint: string, body: Record<string, unknown>): Promise<PostResult> {
  const csrfRes = await fetch('/api/csrf', { method: 'GET' });
  if (!csrfRes.ok) return { ok: false, message: 'CSRF token fetch failed' };
  const { csrf } = (await csrfRes.json()) as { csrf: string };
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, csrf }),
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, message: `${res.status} ${text.slice(0, 200)}` };
  }
  return { ok: true, message: text.slice(0, 200) };
}

function ResultBox({ r }: { r: PostResult | null }): React.ReactElement | null {
  if (r === null) return null;
  return (
    <p
      className={r.ok ? 'muted' : 'error'}
      style={{ marginTop: '0.5rem', fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}
    >
      {r.ok ? '✓' : '✗'} {r.message}
    </p>
  );
}

export function PauseResumeForm({ paused }: { paused: boolean }): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PostResult | null>(null);

  async function handleClick(action: 'pause' | 'resume') {
    setBusy(true);
    const r = await postOverride(`/api/overrides/${action}`, {});
    setResult(r);
    setBusy(false);
  }

  return (
    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
      <button
        type="button"
        className="btn btn-warn"
        disabled={busy || paused}
        onClick={() => handleClick('pause')}
      >
        Pause agent + cancel today's schedules
      </button>
      <button
        type="button"
        className="btn"
        disabled={busy || !paused}
        onClick={() => handleClick('resume')}
      >
        Resume
      </button>
      <ResultBox r={result} />
    </div>
  );
}

export function EditPositionForm(): React.ReactElement {
  const ticketId = useId();
  const slId = useId();
  const tpId = useId();
  const [busy, setBusy] = useState(false);
  const [ticket, setTicket] = useState('');
  const [sl, setSl] = useState('');
  const [tp, setTp] = useState('');
  const [result, setResult] = useState<PostResult | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const r = await postOverride('/api/overrides/edit-position', {
      ticket: ticket.trim(),
      sl: parseFloat(sl) || 0,
      tp: parseFloat(tp) || 0,
    });
    setResult(r);
    setBusy(false);
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', flexWrap: 'wrap' }}
    >
      <div className="field">
        <label htmlFor={ticketId}>Ticket</label>
        <input
          id={ticketId}
          type="text"
          value={ticket}
          onChange={(e) => setTicket(e.target.value)}
          required
          placeholder="123456789"
          style={{ width: '12rem' }}
        />
      </div>
      <div className="field">
        <label htmlFor={slId}>SL</label>
        <input
          id={slId}
          type="number"
          step="0.0001"
          value={sl}
          onChange={(e) => setSl(e.target.value)}
          required
          style={{ width: '8rem' }}
        />
      </div>
      <div className="field">
        <label htmlFor={tpId}>TP</label>
        <input
          id={tpId}
          type="number"
          step="0.0001"
          value={tp}
          onChange={(e) => setTp(e.target.value)}
          required
          style={{ width: '8rem' }}
        />
      </div>
      <button type="submit" className="btn btn-primary" disabled={busy}>
        Apply edit
      </button>
      <div style={{ width: '100%' }}>
        <ResultBox r={result} />
      </div>
    </form>
  );
}

export function ClosePairForm({ pairs }: { pairs: string[] }): React.ReactElement {
  const pairInputId = useId();
  const datalistId = useId();
  const [busy, setBusy] = useState(false);
  const [pair, setPair] = useState(pairs[0] ?? '');
  const [result, setResult] = useState<PostResult | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const r = await postOverride('/api/overrides/close-pair', { pair });
    setResult(r);
    setBusy(false);
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', flexWrap: 'wrap' }}
    >
      <div className="field">
        <label htmlFor={pairInputId}>Pair</label>
        <input
          id={pairInputId}
          type="text"
          list={datalistId}
          value={pair}
          onChange={(e) => setPair(e.target.value)}
          required
          placeholder="EUR/USD"
          style={{ width: '12rem' }}
        />
        <datalist id={datalistId}>
          {pairs.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      </div>
      <button type="submit" className="btn btn-warn" disabled={busy || !pair}>
        Close all positions for {pair || '—'}
      </button>
      <div style={{ width: '100%' }}>
        <ResultBox r={result} />
      </div>
    </form>
  );
}

export function CloseAllForm(): React.ReactElement {
  const confId = useId();
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [result, setResult] = useState<PostResult | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const r = await postOverride('/api/overrides/close-all', {
      confirmation,
    });
    setResult(r);
    setBusy(false);
  }

  const armed = confirmation === 'CLOSE-ALL';

  return (
    <form
      onSubmit={handleSubmit}
      style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', flexWrap: 'wrap' }}
    >
      <div className="field">
        <label htmlFor={confId}>
          Type <span className="mono">CLOSE-ALL</span> to confirm
        </label>
        <input
          id={confId}
          type="text"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          style={{ width: '14rem' }}
        />
      </div>
      <button type="submit" className="btn btn-danger" disabled={busy || !armed}>
        Close ALL positions
      </button>
      <div style={{ width: '100%' }}>
        <ResultBox r={result} />
      </div>
    </form>
  );
}
