import { db, namespace } from './admin';

async function deleteCollection(path: string, batchSize = 200) {
  const ref = db().collection(path);
  const snap = await ref.limit(batchSize).get();
  if (snap.empty) return;
  const batch = db().batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  if (snap.size === batchSize) {
    await deleteCollection(path, batchSize);
  }
}

/**
 * Clear every collection prefixed with the current run's namespace. Used to
 * scrub e2e fixtures between runs against staging.
 */
export async function runTeardown(): Promise<void> {
  const ns = namespace();
  const collections = await db().listCollections();
  const targets = collections.map((c) => c.id).filter((id) => id.startsWith(`${ns}_`));
  for (const id of targets) {
    // eslint-disable-next-line no-console
    console.log(`[teardown] clearing ${id}`);
    await deleteCollection(id);
  }
}

/**
 * Delete every doc in `collectionPath` whose id starts with `prefix`. E2e
 * tests write records straight to live collections (e.g. `clientes/`) with
 * `e2e-` prefixed ids so cleanup can sweep them without touching real data.
 */
export async function cleanupE2EDocs(
  collectionPath: string,
  prefix: string,
): Promise<number> {
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
