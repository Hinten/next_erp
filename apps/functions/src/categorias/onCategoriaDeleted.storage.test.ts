import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { cascadeCategoriaDeletion } from './onCategoriaDeleted';

// Integration test — requires the firestore emulator. Drives the PRODUCTION
// core directly (trigger delivery on a named database is awkward to exercise in
// the emulator), so a change to how the cascade sweeps is caught here — same
// convention as `onEstoqueDeleted.storage.test.ts`.
const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';

function getDb() {
  const app = getApps()[0] ?? initializeApp({ projectId });
  return getFirestore(app, process.env.FIREBASE_DATABASE_ID ?? 'default');
}

function categoriaRef(db: Firestore, categoriaId: string) {
  return db.collection('categorias').doc(categoriaId);
}

function impostoRef(db: Firestore, categoriaId: string) {
  return categoriaRef(db, categoriaId).collection('imposto');
}

describe.skipIf(!EMULATED)('cascadeCategoriaDeletion (emulator)', () => {
  let categoriaId: string;

  beforeAll(async () => {
    categoriaId = `cat${randomUUID().replace(/-/g, '')}`;
    const db = getDb();
    for (let i = 0; i < 3; i += 1) {
      await impostoRef(db, categoriaId).add({ operacaoOuterRef: `operacao/op${i}`, timestamp: i });
    }
  });

  it('sweeps the categoria imposto records', async () => {
    const db = getDb();
    await cascadeCategoriaDeletion(db, categoriaId);
    expect((await impostoRef(db, categoriaId).get()).empty).toBe(true);
  });

  it('is idempotent when there is no imposto', async () => {
    const db = getDb();
    await expect(
      cascadeCategoriaDeletion(db, `cat${randomUUID().replace(/-/g, '')}`),
    ).resolves.toBeUndefined();
  });

  it('reclaims a subcollection nobody enumerated', async () => {
    // The walk is driven by `listCollections()`, not by the schema registry, so
    // a categoria carrying a subcollection this repo never declared is still
    // reclaimed. Same property `onProdutoDeleted`/`onEstoqueDeleted` assert.
    const db = getDb();
    const orphanId = `cat${randomUUID().replace(/-/g, '')}`;
    await categoriaRef(db, orphanId).collection('legado').add({ legado: true });

    await cascadeCategoriaDeletion(db, orphanId);

    expect((await categoriaRef(db, orphanId).collection('legado').get()).empty).toBe(true);
  });
});
