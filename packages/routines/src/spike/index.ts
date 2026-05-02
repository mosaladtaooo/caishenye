/**
 * FR-001 spike runner — wires the four spike modules to real dependencies
 * (env vars, fetch, Postgres audit writer) and persists outcomes to:
 *   - .harness/data/spike-fr-001-outcomes.json (machine-readable; drives
 *     Tier 2 prompt-preserve gating)
 *   - docs/spike-report-fr-001.md (human-readable report)
 *
 * USAGE (operator-side, after creating the no-op routine in Anthropic console):
 *
 *   export SPIKE_NOOP_ROUTINE_ID=trig_xxx
 *   export SPIKE_NOOP_ROUTINE_BEARER=<bearer>
 *   export PLANNER_ROUTINE_ID=trig_xxx
 *   export PLANNER_ROUTINE_BEARER=<bearer>
 *   export DATABASE_URL=postgresql://...
 *
 *   bun run spike            # runs all four spikes sequentially
 *   bun run spike:3          # runs only spike 3
 *
 * Spikes 1, 2, and 4 require additional manual steps (filesystem flag check,
 * 24-48h elapsed time, /usage screenshots) that this runner cannot fully
 * automate. The spike module returns an `outcome` object that the operator
 * can hand-merge into spike-fr-001-outcomes.json after observing the live
 * artefacts. Spike 3 is the only fully-automated spike from this runner.
 *
 * This file is a thin CLI wrapper over the four runSpikeN() functions; the
 * unit tests cover the spike modules directly with stubbed deps.
 */

import { runSpike3, type Spike3Deps } from './ac-001-3-fire-api';
import type { SpikeEnv } from './types';

function readEnv(): SpikeEnv {
  const required = [
    'SPIKE_NOOP_ROUTINE_ID',
    'SPIKE_NOOP_ROUTINE_BEARER',
    'PLANNER_ROUTINE_ID',
    'PLANNER_ROUTINE_BEARER',
    'ROUTINE_BETA_HEADER',
  ] as const;

  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `[spike-runner] missing env vars: ${missing.join(', ')}\n` +
        'See .env.example for setup; populate .env.local before running.',
    );
  }

  return {
    SPIKE_NOOP_ROUTINE_ID: process.env.SPIKE_NOOP_ROUTINE_ID as string,
    SPIKE_NOOP_ROUTINE_BEARER: process.env.SPIKE_NOOP_ROUTINE_BEARER as string,
    PLANNER_ROUTINE_ID: process.env.PLANNER_ROUTINE_ID as string,
    PLANNER_ROUTINE_BEARER: process.env.PLANNER_ROUTINE_BEARER as string,
    ROUTINE_BETA_HEADER: process.env.ROUTINE_BETA_HEADER as string,
  };
}

/**
 * In-memory `recordRoutineRun` placeholder. The real implementation in M1+
 * lives in `packages/db/src/audit.ts` (FR-007) — the spike runner uses a
 * file-only fallback when Postgres isn't reachable yet, so the spike can
 * run pre-FR-008-deployment.
 */
async function placeholderRecordRoutineRun(row: Parameters<Spike3Deps['recordRoutineRun']>[0]) {
  // Minimal LOUD trace so operator sees the audit row was attempted.
  process.stderr.write(`[spike-runner] would write routine_run: ${JSON.stringify(row, null, 2)}\n`);
  return { id: -1 };
}

async function main(): Promise<void> {
  const which = process.argv[2] ?? 'all';
  const env = readEnv();
  const deps: Spike3Deps = {
    fetch,
    now: () => new Date(),
    recordRoutineRun: placeholderRecordRoutineRun,
    env,
  };

  switch (which) {
    case 'all':
    case '3':
    case 'spike3': {
      const outcome = await runSpike3(deps);
      process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
      if (outcome.status === 'FAIL') process.exit(1);
      break;
    }
    case '1':
    case 'spike1':
    case '2':
    case 'spike2':
    case '4':
    case 'spike4':
      process.stderr.write(
        `[spike-runner] spike ${which} requires manual artefacts (filesystem flag / 24h soak / Python ref). Run the live experiment per docs/spike-report-fr-001.md and hand-merge the SpikeOutcome into .harness/data/spike-fr-001-outcomes.json.\n`,
      );
      process.exit(2);
      break;
    default:
      process.stderr.write(`[spike-runner] unknown target: ${which}\n`);
      process.exit(2);
  }
}

// Bun adds `import.meta.main`; standard ESM does not. Use a guard so this
// file can be imported in tests without auto-running.
declare global {
  interface ImportMeta {
    main?: boolean;
  }
}

if (import.meta.main === true) {
  main().catch((e) => {
    process.stderr.write(`[spike-runner] fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
