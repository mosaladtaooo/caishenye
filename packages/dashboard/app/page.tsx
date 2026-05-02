/**
 * Dashboard root — Overview screen (FR-006 AC-006-2 #1).
 *
 * Read-only in v1: balance + equity + active positions + today's schedule
 * countdown + cap-progress bar + last Telegram interaction.
 *
 * Implementation note: this is the M3 read-only scaffold. Polished content
 * (live SWR polling, the impeccable design tokens, the full layout) lands
 * in the M3 step 18 + D22 design pass. Here we ship a structurally-correct
 * server component that renders without errors so middleware + auth can
 * be tested end-to-end.
 */

import { redirect } from 'next/navigation';

export default function OverviewPage(): React.ReactElement {
  // The middleware already redirects unauthed users; this is defense-in-depth.
  // In a fully wired build, replace with `const session = await auth();`
  // from the auth.ts factory once a route-handler-side initialisation has
  // happened. For the scaffold, we stub with a server-side check that
  // mirrors what the middleware does.
  if (!hasSessionCookie()) {
    redirect('/login');
  }

  return (
    <main style={{ padding: '2rem' }}>
      <h1>财神爷 — Overview</h1>
      <p>Mission control. Polished content lands in D22.</p>
      <ul>
        <li>Balance + Equity + Open Positions</li>
        <li>Today&apos;s Schedule with countdown</li>
        <li>Cap progress (FR-021)</li>
        <li>Last Telegram interaction (FR-005)</li>
      </ul>
    </main>
  );
}

function hasSessionCookie(): boolean {
  // RSC server component — would normally read via next/headers cookies().
  // Stub returns true so the page renders during scaffold-time tsc; the
  // real check happens in middleware.ts and the wired auth() call.
  return true;
}
