import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';

import { cascadeNfeDeletion } from './onNfeDeleted';

// Integration test — requires the firestore emulator. Skipped when run bare so the
// offline suite stays green. Drives the real `cascadeNfeDeletion` core directly
// (not via Firestore-trigger delivery for the named `default` database — same split
// as the produto/estoque suites). Covers the single-NF-e `cartacorrecao` sweep
// on a DIRECT nfev4 delete (#518).
const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';

function getDb() {
  const app = getApps()[0] ?? initializeApp({ projectId });
  return getFirestore(app, process.env.FIREBASE_DATABASE_ID ?? 'default');
}

function nfeRef(db: Firestore, pedidoId: string, nfeId: string) {
  return db.collection('pedidos').doc(pedidoId).collection('nfev4').doc(nfeId);
}

function cartaCorrecaoRef(db: Firestore, pedidoId: string, nfeId: string) {
  return nfeRef(db, pedidoId, nfeId).collection('cartacorrecao');
}

describe.skipIf(!EMULATED)('cascadeNfeDeletion — direct nfev4 delete (#518)', () => {
  let pedidoId: string;
  let nfeId: string;

  beforeAll(async () => {
    pedidoId = `ped${randomUUID().replace(/-/g, '')}`;
    nfeId = `nfe-${pedidoId}`;
    const db = getDb();
    await nfeRef(db, pedidoId, nfeId).set({ estado: 'autorizada' });
    // A handful of CC-e events under the NF-e.
    for (let i = 0; i < 3; i += 1) {
      await cartaCorrecaoRef(db, pedidoId, nfeId).add({
        nSeqEvento: i + 1,
        xCorrecao: `correção ${i}`,
      });
    }
  });

  it('sweeps the NF-e cartacorrecao records when the nfev4 doc is already gone', async () => {
    const db = getDb();
    // The onDocumentDeleted trigger fires AFTER the nfev4 doc is deleted, so its
    // cartacorrecao subcollection is already orphaned when the cascade runs.
    // Delete the parent first to exercise exactly that: the cascade reclaims a
    // subcollection whose owning doc no longer exists.
    await nfeRef(db, pedidoId, nfeId).delete();

    await cascadeNfeDeletion(db, pedidoId, nfeId);

    expect((await nfeRef(db, pedidoId, nfeId).get()).exists).toBe(false);
    expect((await cartaCorrecaoRef(db, pedidoId, nfeId).get()).empty).toBe(true);
  });
});

describe.skipIf(!EMULATED)('cascadeNfeDeletion — idempotence', () => {
  it('is a no-op on an absent NF-e doc (no double-delete conflict with the pedido subtree walk)', async () => {
    const db = getDb();
    const pedidoId = `ped${randomUUID().replace(/-/g, '')}`;
    await expect(cascadeNfeDeletion(db, pedidoId, `nfe-${pedidoId}-none`)).resolves.toBeUndefined();
  });
});
