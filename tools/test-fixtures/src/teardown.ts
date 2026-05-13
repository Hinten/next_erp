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

async function main() {
  const ns = namespace();
  const collections = await db().listCollections();
  const targets = collections.map((c) => c.id).filter((id) => id.startsWith(`${ns}_`));
  for (const id of targets) {
    // eslint-disable-next-line no-console
    console.log(`[teardown] clearing ${id}`);
    await deleteCollection(id);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
