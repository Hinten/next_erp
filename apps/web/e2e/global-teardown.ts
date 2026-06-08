import { cleanupE2EDocs, runTeardown } from '@delfrance/test-fixtures';
import { requiresAuthEnv } from './helpers/env';
import { deleteAuthUserByEmail } from './_helpers/admin-cleanup';
import { e2eUserEmail, getRunId } from './_helpers/run-id';

/**
 * Playwright globalTeardown: removes all e2e fixtures from staging.
 *
 *  - `runTeardown()` deletes every collection prefixed with this run's
 *    namespace (e.g. `e2e_local_grupoEconomico`).
 *  - `cleanupE2EDocs(path, prefix)` sweeps real collections (`clientes`,
 *    `categorias`) for stray docs left when a spec failed before its own
 *    afterEach cleanup. In CI it scopes the sweep to this run's prefix
 *    (`e2e-<runId>-`) so the two parallel e2e workflows (which share these
 *    real collections) don't delete each other's in-flight docs; locally,
 *    with no GITHUB_RUN_ID, it keeps the broad `e2e-` sweep to also clear
 *    cruft left by earlier local runs.
 *  - `deleteAuthUserByEmail` removes this run's ephemeral Firebase Auth user
 *    (`globalSetup` created it). A leak here is also caught next run by
 *    `sweepStaleE2EUsers`.
 *
 * Skip rule mirrors `requiresAuthEnv()` — when the Admin SDK env is
 * missing, globalSetup exits early, so there's nothing to tear down.
 * Without this alignment the teardown would call `db().listCollections()`
 * against an unconfigured project and crash the whole run with a stack
 * trace that "wasn't part of any test".
 *
 * Even when env IS complete, we swallow errors inside teardown — a
 * failed cleanup shouldn't mask the spec results. Just log and move on.
 */
export default async function globalTeardown() {
  if (!requiresAuthEnv()) {
    // eslint-disable-next-line no-console
    console.warn(
      '[globalTeardown] skipping — auth env incomplete; specs skipped, ' + 'nothing to clean up.',
    );
    return;
  }

  try {
    await runTeardown();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[globalTeardown] runTeardown failed (continuing): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const collections = [
    'clientes',
    'categorias',
    'depositos',
    'motivosincidentes',
    'bandeirasCartao',
  ];
  // CI: GITHUB_RUN_ID is stable across the runner + workers, so a run-scoped
  // prefix matches every doc this run seeded (`e2e-<runId>-<tag>-NNN`) and
  // nothing from the sibling workflow. Local: getRunId() is a per-call
  // timestamp, so fall back to the broad prefix.
  const runPrefix = process.env.GITHUB_RUN_ID ? `e2e-${getRunId()}-` : 'e2e-';
  for (const c of collections) {
    try {
      const deleted = await cleanupE2EDocs(c, runPrefix);
      if (deleted > 0) {
        // eslint-disable-next-line no-console
        console.log(`[globalTeardown] swept ${deleted} stray e2e docs from ${c}/`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[globalTeardown] cleanupE2EDocs(${c}) failed (continuing): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  try {
    await deleteAuthUserByEmail(e2eUserEmail());
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[globalTeardown] deleting the ephemeral e2e user failed (continuing): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
