import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { cascadeOperacaoDeletion } from './onOperacaoDeleted';

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

function operacaoRef(db: Firestore, operacaoId: string) {
  return db.collection('operacao').doc(operacaoId);
}

function regrasRef(db: Firestore, operacaoId: string) {
  return operacaoRef(db, operacaoId).collection('regras');
}

describe.skipIf(!EMULATED)('cascadeOperacaoDeletion (emulator)', () => {
  let operacaoId: string;

  beforeAll(async () => {
    operacaoId = `op${randomUUID().replace(/-/g, '')}`;
    const db = getDb();
    for (let i = 0; i < 3; i += 1) {
      await regrasRef(db, operacaoId).add({ cst: `0${i}`, timestamp: i });
    }
  });

  it('sweeps the operação regras records', async () => {
    const db = getDb();
    await cascadeOperacaoDeletion(db, operacaoId);
    expect((await regrasRef(db, operacaoId).get()).empty).toBe(true);
  });

  it('is idempotent when there are no regras', async () => {
    const db = getDb();
    await expect(
      cascadeOperacaoDeletion(db, `op${randomUUID().replace(/-/g, '')}`),
    ).resolves.toBeUndefined();
  });

  it('reclaims a subcollection nobody enumerated', async () => {
    // The walk is driven by `listCollections()`, not by the schema registry, so
    // an operação carrying a subcollection this repo never declared is still
    // reclaimed. Same property `onProdutoDeleted`/`onEstoqueDeleted` assert.
    const db = getDb();
    const orphanId = `op${randomUUID().replace(/-/g, '')}`;
    await operacaoRef(db, orphanId).collection('legado').add({ legado: true });

    await cascadeOperacaoDeletion(db, orphanId);

    expect((await operacaoRef(db, orphanId).collection('legado').get()).empty).toBe(true);
  });
});
