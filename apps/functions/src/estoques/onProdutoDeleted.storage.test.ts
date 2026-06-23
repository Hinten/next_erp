import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';

import { sweepProdutoEstoques } from './estoqueCascade';

// Integration test — requires the firestore emulator. Skipped when run bare so
// the offline suite stays green. Drives the cascade CORE directly (not the
// onDocumentDeleted trigger) so it doesn't depend on Firestore-trigger delivery
// for the named `default` database — same split as the arquivo suite.
const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';

function getDb() {
  const app = getApps()[0] ?? initializeApp({ projectId });
  return getFirestore(app, process.env.FIREBASE_DATABASE_ID ?? 'default');
}

const DEPOSITOS = ['depA', 'depB'];

describe.skipIf(!EMULATED)('onProdutoDeleted cascade (emulator)', () => {
  let produtoId: string;

  beforeAll(async () => {
    produtoId = `p${randomUUID().replace(/-/g, '')}`;
    const db = getDb();
    // Two estoques, each holding two historicoEstoque records.
    for (const dep of DEPOSITOS) {
      const estRef = db
        .collection('produtos')
        .doc(produtoId)
        .collection('estoques')
        .doc(`est-${produtoId}-${dep}`);
      await estRef.set({
        parentId: produtoId,
        depositoOuterRef: `documents/depositos/${dep}`,
        quantidade: 3,
        quantidadeReservada: 0,
      });
      for (let i = 0; i < 2; i += 1) {
        await estRef.collection('historicoEstoque').add({ quantidade: 1, timestamp: i });
      }
    }
  });

  it('deletes every estoque doc and its nested historicoEstoque', async () => {
    const db = getDb();
    const swept = await sweepProdutoEstoques(db, produtoId);
    expect(swept).toEqual({ estoques: 2, historico: 4 });

    const estoques = await db.collection('produtos').doc(produtoId).collection('estoques').get();
    expect(estoques.empty).toBe(true);

    // Nested history is gone too (Firestore would otherwise orphan it).
    for (const dep of DEPOSITOS) {
      const hist = await db
        .collection('produtos')
        .doc(produtoId)
        .collection('estoques')
        .doc(`est-${produtoId}-${dep}`)
        .collection('historicoEstoque')
        .get();
      expect(hist.empty).toBe(true);
    }
  });

  it('is idempotent on an empty/absent subtree', async () => {
    const db = getDb();
    const swept = await sweepProdutoEstoques(db, `p${randomUUID().replace(/-/g, '')}`);
    expect(swept).toEqual({ estoques: 0, historico: 0 });
  });
});
