import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';

// Integration test — requires the firestore emulator. Exercises the same
// `recursiveDelete` over an estoque's `historicoEstoque` that `onEstoqueDeleted`
// runs (driven directly, not via trigger delivery). Skipped when run bare.
const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';

function getDb() {
  const app = getApps()[0] ?? initializeApp({ projectId });
  return getFirestore(app, process.env.FIREBASE_DATABASE_ID ?? 'default');
}

function historicoRef(db: Firestore, produtoId: string, estoqueId: string) {
  return db
    .collection('produtos')
    .doc(produtoId)
    .collection('estoques')
    .doc(estoqueId)
    .collection('historicoEstoque');
}

describe.skipIf(!EMULATED)('onEstoqueDeleted cascade (emulator)', () => {
  let produtoId: string;
  let estoqueId: string;

  beforeAll(async () => {
    produtoId = `p${randomUUID().replace(/-/g, '')}`;
    estoqueId = `est-${produtoId}-dep`;
    const db = getDb();
    for (let i = 0; i < 3; i += 1) {
      await historicoRef(db, produtoId, estoqueId).add({ quantidade: i, timestamp: i });
    }
  });

  it('sweeps the estoque historicoEstoque records', async () => {
    const db = getDb();
    await db.recursiveDelete(historicoRef(db, produtoId, estoqueId));
    expect((await historicoRef(db, produtoId, estoqueId).get()).empty).toBe(true);
  });

  it('is idempotent when there is no history', async () => {
    const db = getDb();
    await expect(
      db.recursiveDelete(historicoRef(db, produtoId, `est-${produtoId}-none`)),
    ).resolves.toBeUndefined();
  });
});
