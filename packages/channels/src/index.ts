/**
 * @caishen/channels — package entry point.
 *
 * The Always-On Channels session lives on the operator's VPS as a
 * subagent yaml + per-command scripts (R2 narrowed Write scope —
 * subagent CANNOT write to `agents/` or `scripts/`; ONLY `work/**`).
 *
 * This entry point exports the typed shapes consumed by FR-007 audit
 * writers (telegram_interactions rows the session produces) and the
 * FR-005 healthcheck handler. The session ITSELF is operator-managed;
 * the assets in this package compile + ship as static configuration.
 *
 * Subagent yaml + per-command scripts + recovery hint land in M4 step 23.
 */

export const PACKAGE_VERSION = '1.0.0';
