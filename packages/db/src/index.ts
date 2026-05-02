/**
 * @caishen/db — package entry point.
 *
 * Public API:
 *   - schema/* — Drizzle table definitions (FR-008)
 *   - client.ts — tenant-scoped client factory (constitution §4)
 *   - audit.ts — withAuditOrAbort wrapper (constitution §3)
 */

export * as schema from './schema';
