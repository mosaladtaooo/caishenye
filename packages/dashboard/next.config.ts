/**
 * Next.js 16 config — minimal scaffold for the 财神爷 dashboard.
 *
 * Constitution §17: no `any`, strict everywhere.
 * Turbopack lives at the top level in Next 16 (was experimental.turbopack
 * in Next 15) — kept defaults.
 */

import { resolve } from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The dashboard talks to MT5 via the Tailscale Funnel from server-side
  // route handlers only. No client-side fetches to MT5; never expose the
  // bearer to a browser bundle.
  serverExternalPackages: ['postgres', '@caishen/db'],
  // Monorepo build hint: in a Bun-workspace deploy where Vercel installs from
  // the repo root and builds via `bun --filter '@caishen/dashboard' run build`,
  // Next must trace files starting from the repo root so workspace-linked
  // packages (@caishen/db, @caishen/routines) ship into the deployment bundle.
  // Without this, `npm trace` warns and runtime imports of workspace siblings
  // fail at cold start.
  outputFileTracingRoot: resolve(__dirname, '..', '..'),
  experimental: {
    // Mostly defaults; enabled here as we tighten under FR-021 + impeccable.
  },
};

export default nextConfig;
