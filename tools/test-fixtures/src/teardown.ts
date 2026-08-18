import { E2E_PROBE_COLLECTION, db, e2eRunId } from './admin';

/**
 * Drop this run's rules-probe document.
 *
 * The probe is the ONLY doc the suite writes outside the real collections, and
 * its key is the run id — so this is a single keyed delete: **no
 * `listCollections()`, no query, no read**. It used to enumerate the root and
 * prefix-match `e2e_<runId>_*` collection NAMES, which is why the leak was both
 * expensive to reclaim and impossible to reclaim across runs.
 *
 * Deleting an absent doc is a no-op, so this is safe to run twice — and it
 * normally IS a no-op: `verifyE2ENamespaceAccess` deletes the probe inline,
 * seconds after writing it. This covers the case where the process died in
 * between. The cross-run backstop is `sweepStaleE2EProbes` in
 * `apps/web/e2e/_helpers/stale-sweep.ts`, for when no teardown runs at all.
 */
export async function runTeardown(): Promise<void> {
  const runId = e2eRunId();
  // eslint-disable-next-line no-console
  console.log(`[teardown] clearing ${E2E_PROBE_COLLECTION}/${runId}`);
  await db().collection(E2E_PROBE_COLLECTION).doc(runId).delete();
}

/**
 * Delete every doc in `collectionPath` whose id starts with `prefix`. E2e
 * tests write records straight to live collections (e.g. `clientes/`) with
 * `e2e-` prefixed ids so cleanup can sweep them without touching real data.
 */
export async function cleanupE2EDocs(collectionPath: string, prefix: string): Promise<number> {
  const ref = db().collection(collectionPath);
  const snap = await ref.get();
  const toDelete = snap.docs.filter((d) => d.id.startsWith(prefix));
  if (toDelete.length === 0) return 0;
  // Firestore batches max 500 ops.
  for (let i = 0; i < toDelete.length; i += 400) {
    const batch = db().batch();
    toDelete.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  return toDelete.length;
}

const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('teardown.ts') ||
  process.argv[1]?.endsWith('teardown.js');

if (isDirectInvocation) {
  runTeardown().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
