import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';

import { deleteHistoricoEstoque } from './estoqueCascade';

// Integration test — requires the firestore emulator. Drives the sweep CORE
// directly (not the trigger). Skipped when run bare.
const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';

function getDb() {
  const app = getApps()[0] ?? initializeApp({ projectId });
  return getFirestore(app, process.env.FIREBASE_DATABASE_ID ?? 'default');
}

describe.skipIf(!EMULATED)('onEstoqueDeleted cascade (emulator)', () => {
  let produtoId: string;
  let estoqueId: string;

  beforeAll(async () => {
    produtoId = `p${randomUUID().replace(/-/g, '')}`;
    estoqueId = `est-${produtoId}-dep`;
    const db = getDb();
    const histCol = db
      .collection('produtos')
      .doc(produtoId)
      .collection('estoques')
      .doc(estoqueId)
      .collection('historicoEstoque');
    for (let i = 0; i < 3; i += 1) {
      await histCol.add({ quantidade: i, timestamp: i });
    }
  });

  it('sweeps the estoque historicoEstoque records', async () => {
    const db = getDb();
    const swept = await deleteHistoricoEstoque(db, produtoId, estoqueId);
    expect(swept).toBe(3);

    const hist = await db
      .collection('produtos')
      .doc(produtoId)
      .collection('estoques')
      .doc(estoqueId)
      .collection('historicoEstoque')
      .get();
    expect(hist.empty).toBe(true);
  });

  it('is idempotent when there is no history', async () => {
    const db = getDb();
    const swept = await deleteHistoricoEstoque(db, produtoId, `est-${produtoId}-none`);
    expect(swept).toBe(0);
  });
});
