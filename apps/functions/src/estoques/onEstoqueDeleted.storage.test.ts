import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { cascadeEstoqueDeletion } from './onEstoqueDeleted';

// Integration test — requires the firestore emulator. Drives the PRODUCTION
// core directly (trigger delivery on a named database is awkward to exercise in
// the emulator), so a change to how the cascade sweeps is caught here.
//
// It used to re-implement the sweep inline against the historico collection ref
// and import nothing from the module under test — so it would have stayed green
// through #728's rewrite while asserting nothing about the shipped code.
// Importing `cascadeEstoqueDeletion` is the point of the file.
const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';

function getDb() {
  const app = getApps()[0] ?? initializeApp({ projectId });
  return getFirestore(app, process.env.FIREBASE_DATABASE_ID ?? 'default');
}

function estoqueRef(db: Firestore, produtoId: string, estoqueId: string) {
  return db.collection('produtos').doc(produtoId).collection('estoques').doc(estoqueId);
}

function historicoRef(db: Firestore, produtoId: string, estoqueId: string) {
  return estoqueRef(db, produtoId, estoqueId).collection('historicoEstoque');
}

describe.skipIf(!EMULATED)('cascadeEstoqueDeletion (emulator)', () => {
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
    await cascadeEstoqueDeletion(db, produtoId, estoqueId);
    expect((await historicoRef(db, produtoId, estoqueId).get()).empty).toBe(true);
  });

  it('is idempotent when there is no history', async () => {
    const db = getDb();
    await expect(
      cascadeEstoqueDeletion(db, produtoId, `est-${produtoId}-none`),
    ).resolves.toBeUndefined();
  });

  it('reclaims a subcollection nobody enumerated', async () => {
    // The walk is driven by `listCollections()`, not by the schema registry, so
    // an estoque carrying a subcollection this repo never declared is still
    // reclaimed. Same property `onProdutoDeleted` asserts with `variacoesml`.
    const db = getDb();
    const orphanId = `est-${produtoId}-legacy`;
    await estoqueRef(db, produtoId, orphanId).collection('histestq').add({ legado: true });

    await cascadeEstoqueDeletion(db, produtoId, orphanId);

    expect((await estoqueRef(db, produtoId, orphanId).collection('histestq').get()).empty).toBe(
      true,
    );
  });
});
