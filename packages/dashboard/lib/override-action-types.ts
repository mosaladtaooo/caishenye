/**
 * Override action types — mirrors the override_action_type pgEnum in
 * @caishen/db schema. Kept here as a tiny stand-alone module so the
 * override-handler library does NOT pull in the full Drizzle/pg dep tree
 * for unit tests (vitest under node).
 *
 * Source-of-truth invariant: this list MUST stay in sync with
 * packages/db/src/schema/enums.ts → overrideActionType. The schema-shape
 * test asserts the DB enum matches; if you add a new action here,
 * also add it there.
 */

export const OVERRIDE_ACTION_TYPES = [
  'close_pair',
  'close_all',
  'edit_sl_tp',
  'pause',
  'resume',
  'replan',
] as const;

export type OverrideActionType = (typeof OVERRIDE_ACTION_TYPES)[number];
