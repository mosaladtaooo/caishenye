/**
 * auth-audit -- single-row audit writer for FR-025 (EC-025-2 bad-signature)
 * + FR-023 (EC-023-2 counter-regression).
 *
 * Both event_types land in the same `routine_runs` table with distinct
 * event_type values per R10/R11 (single audit table consolidation).
 *
 * Schema mapping (lands via Drizzle migration 0002_v1_2_routine_runs_auth_audit.sql
 * shipped alongside the FR-023 + FR-025 build):
 *   - routine_name "auth_event": enum-extension adds this value alongside
 *     the existing planner / executor / spike_X / cap_status.
 *   - routine_fire_kind "auth_audit": enum-extension adds this value.
 *   - event_type   TEXT  (NEW column) -- 'auth_bad_signature' | 'auth_counter_regression'
 *   - details_json JSONB (NEW column) -- forensic payload (credential_id,
 *     stored_counter, request_path, etc.).
 *
 * The JSON shape (event_type + tenant_id + details_json) is the CONTRACT the
 * test asserts against (R11 column-by-column equality on
 * `auditWriteSpy.mock.calls[0][0]`). The implementation here is a thin shim
 * over Drizzle -- the test's whole point is that the SHAPE is locked.
 *
 * Constitution section 4 multi-tenant: every row carries `tenant_id`.
 * Constitution section 3 audit-or-abort caveat: this writer logs+continues
 * on failure (audit-best-effort, NOT audit-or-abort). The auth helper that
 * calls us has ALREADY returned 401; losing the audit row is a forensic gap,
 * NOT a security gap. Failing the 401 path on audit-row failure would be a
 * denial-of-service vector. The full audit-or-abort discipline applies to
 * the trading-side routines; this auth audit is a forensic add-on.
 */

export interface AuthAuditRow {
  /** Distinct event_type values: 'auth_bad_signature' | 'auth_counter_regression' */
  event_type: string;
  /** Tenant scope per constitution section 4. */
  tenant_id: number;
  /** Forensic payload -- shape varies per event_type; see lib helper docs. */
  details_json: Record<string, unknown>;
}

/**
 * Write a single auth audit row to `routine_runs` (best-effort).
 *
 * v1.2 implementation note: the Drizzle migration that adds
 * `event_type TEXT` + `details_json JSONB` columns + extends the
 * `routine_run_routine_name` and `routine_fire_kind` enums lands as part
 * of the FR-023 D4 + FR-025 D3 build. Until that migration is applied,
 * this writer logs the row to stderr in structured form so operators have
 * a forensic trail in Vercel logs. After migration, the function uses
 * `getTenantDb(...).drizzle.insert(routineRuns)` directly. The unit tests
 * for FR-023 + FR-025 mock this whole module via `vi.doMock` -- they assert
 * the SHAPE passed in, not the storage path.
 */
export async function writeAuthAuditRow(row: AuthAuditRow): Promise<void> {
  // Structured log at the boundary so the row is recoverable even before
  // the live DB column-add migration lands. Format chosen for grep-ability.
  const payload = {
    audit: 'auth-audit',
    event_type: row.event_type,
    tenant_id: row.tenant_id,
    details_json: row.details_json,
  };
  process.stderr.write(`[auth-audit] ${JSON.stringify(payload)}\n`);
  // Intentionally no DB write here in v1.2 first ship -- see the migration
  // header above. Once the migration has run, swap this to:
  //
  //   try {
  //     const tenantDb = getTenantDb(row.tenant_id);
  //     await tenantDb.drizzle.insert(routineRuns).values({
  //       tenantId: row.tenant_id,
  //       routineName: 'auth_event',
  //       routineFireKind: 'auth_audit',
  //       eventType: row.event_type,
  //       detailsJson: row.details_json,
  //       status: 'completed',
  //     });
  //   } catch (e) {
  //     const msg = e instanceof Error ? e.message : String(e);
  //     process.stderr.write(`[auth-audit] best-effort insert failed: ${msg}\n`);
  //   }
}
