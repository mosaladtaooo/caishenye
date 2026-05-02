/**
 * Next.js 16 config — minimal scaffold for the 财神爷 dashboard.
 *
 * Constitution §17: no `any`, strict everywhere.
 * Turbopack lives at the top level in Next 16 (was experimental.turbopack
 * in Next 15) — kept defaults.
 */

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The dashboard talks to MT5 via the Tailscale Funnel from server-side
  // route handlers only. No client-side fetches to MT5; never expose the
  // bearer to a browser bundle.
  serverExternalPackages: ['postgres', '@caishen/db'],
  experimental: {
    // Mostly defaults; enabled here as we tighten under FR-021 + impeccable.
  },
};

export default nextConfig;
