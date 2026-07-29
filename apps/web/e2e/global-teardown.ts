import { runTeardown } from '@delfrance/test-fixtures';
import { requiresAuthEnv } from './helpers/env';
import { deleteAuthUserByEmail } from './_helpers/admin-cleanup';
import { isAdminSdkError, sweepCurrentRunFixtures } from './_helpers/stale-sweep';
import { e2eUserEmail } from './_helpers/run-id';

/**
 * Playwright globalTeardown: removes all e2e fixtures from staging.
 *
 *  - `runTeardown()` deletes every collection prefixed with this run's
 *    namespace (e.g. `e2e_local_grupoEconomico`).
 *  - `sweepCurrentRunFixtures()` sweeps this run's docs out of the real
 *    collections, for every target in `E2E_FIXTURE_TARGETS` — the same registry
 *    the start-of-run orphan sweep uses. It replaces a hardcoded six-collection
 *    list that matched on **doc id only**, so it missed both the ~13 other
 *    collections the suite seeds and every row a test created through the UI
 *    (those get Firestore auto-ids and carry the prefix in a field). It also
 *    deletes recursively where a subcollection can exist, which the old
 *    `WriteBatch` sweep left stranded.
 *  - `deleteAuthUserByEmail` removes this run's ephemeral Firebase Auth user
 *    (`globalSetup` created it). A leak here is also caught next run by
 *    `sweepStaleE2EUsers`.
 *
 * Playwright does not run `globalTeardown` when the job is **cancelled**, and
 * every e2e workflow sets `cancel-in-progress: true`, so this used to be skipped
 * on exactly the runs that leak most. Two things now cover that: the
 * `if: always()` step in `e2e-reusable.yml` invokes this module directly (see
 * the bottom of the file), and the start-of-run sweep in `_setup/combined.ts`
 * reclaims whatever still got through (#712). Teardown is the fast path, not
 * the guarantee.
 *
 * Skip rule mirrors `requiresAuthEnv()` — when the Admin SDK env is
 * missing, globalSetup exits early, so there's nothing to tear down.
 * Without this alignment the teardown would call `db().listCollections()`
 * against an unconfigured project and crash the whole run with a stack
 * trace that "wasn't part of any test".
 *
 * Even when env IS complete, we swallow Admin-SDK errors inside teardown — a
 * failed cleanup shouldn't mask the spec results. Just log and move on.
 */
export default async function globalTeardown() {
  if (!requiresAuthEnv()) {
    console.warn(
      '[globalTeardown] skipping — auth env incomplete; specs skipped, ' + 'nothing to clean up.',
    );
    return;
  }

  try {
    await runTeardown();
  } catch (err) {
    if (!isAdminSdkError(err)) throw err;
    console.warn(`[globalTeardown] runTeardown failed (continuing): ${String(err)}`);
  }

  try {
    await sweepCurrentRunFixtures();
  } catch (err) {
    if (!isAdminSdkError(err)) throw err;
    console.warn(`[globalTeardown] fixture sweep failed (continuing): ${String(err)}`);
  }

  try {
    await deleteAuthUserByEmail(e2eUserEmail());
  } catch (err) {
    if (!isAdminSdkError(err)) throw err;
    console.warn(
      `[globalTeardown] deleting the ephemeral e2e user failed (continuing): ${String(err)}`,
    );
  }
}

/**
 * Direct invocation, so an `if: always()` CI step can run teardown after a
 * cancelled job — the case Playwright's own `globalTeardown` never reaches.
 * Mirrors the same block in `_helpers/stale-sweep.ts`.
 *
 * Always exits 0: this runs when the suite has already failed or been killed,
 * and a janitor must never be the thing that reds a job.
 */
const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('global-teardown.ts') ||
  process.argv[1]?.endsWith('global-teardown.js');

if (isDirectInvocation) {
  globalTeardown().catch((err: unknown) => {
    console.warn(`[globalTeardown] failed: ${String(err)}`);
  });
}
