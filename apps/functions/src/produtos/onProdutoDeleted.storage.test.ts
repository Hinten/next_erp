import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';

import { cascadeProdutoDeletion } from './onProdutoDeleted';

// Integration test — requires the firestore emulator. Skipped when run bare so the
// offline suite stays green. Drives the real `cascadeProdutoDeletion` core directly
// (not via Firestore-trigger delivery for the named `default` database — same split
// as the arquivo suite). Covers the full-subtree sweep (#136) and the variation-
// children cascade (#199).
const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';

function getDb() {
  const app = getApps()[0] ?? initializeApp({ projectId });
  return getFirestore(app, process.env.FIREBASE_DATABASE_ID ?? 'default');
}

function freshId(prefix = 'p') {
  return `${prefix}${randomUUID().replace(/-/g, '')}`;
}

describe.skipIf(!EMULATED)('cascadeProdutoDeletion — full subtree sweep (#136)', () => {
  let produtoId: string;
  // Every kind of subcollection a produto can carry: estoque + nested history,
  // fiscal override, price history, and a marketplace variation link.
  const SUBCOLLECTIONS = ['imposto', 'historicoDePrecos', 'historicoDeCusto', 'variacoesml'];

  beforeAll(async () => {
    produtoId = freshId();
    const db = getDb();
    const produtoRef = db.collection('produtos').doc(produtoId);
    await produtoRef.set({ nome: 'Produto com subcoleções', paiId: null });

    // estoque + nested historicoEstoque (two levels deep).
    const estRef = produtoRef.collection('estoques').doc(`est-${produtoId}`);
    await estRef.set({ parentId: produtoId, quantidade: 3, quantidadeReservada: 0 });
    await estRef.collection('historicoEstoque').add({ quantidade: 1, timestamp: 0 });

    // One doc in each of the other subcollections.
    for (const name of SUBCOLLECTIONS) {
      await produtoRef.collection(name).doc(`doc-${name}`).set({ seeded: true });
    }
  });

  it('reclaims every subcollection when the parent doc is already gone (including nested)', async () => {
    const db = getDb();
    const produtoRef = db.collection('produtos').doc(produtoId);
    // The onDocumentDeleted trigger fires AFTER the produto doc is deleted, so its
    // subcollections are already orphaned when the cascade runs. Delete the parent
    // first to exercise exactly that: recursiveDelete reclaims subcollections whose
    // owning doc no longer exists.
    await produtoRef.delete();

    await cascadeProdutoDeletion(db, produtoId);

    expect((await produtoRef.get()).exists).toBe(false);

    // estoques + the nested historicoEstoque are gone.
    expect((await produtoRef.collection('estoques').get()).empty).toBe(true);
    expect(
      (
        await produtoRef
          .collection('estoques')
          .doc(`est-${produtoId}`)
          .collection('historicoEstoque')
          .get()
      ).empty,
    ).toBe(true);

    // Every other subcollection is reclaimed too — no name enumeration in the core.
    for (const name of SUBCOLLECTIONS) {
      expect((await produtoRef.collection(name).get()).empty).toBe(true);
    }
  });
});

describe.skipIf(!EMULATED)('cascadeProdutoDeletion — variation children cascade (#199)', () => {
  let parentId: string;
  let childIds: string[];
  let strangerId: string;

  beforeAll(async () => {
    parentId = freshId('parent');
    childIds = [freshId('child'), freshId('child')];
    strangerId = freshId('stranger');
    const db = getDb();

    await db.collection('produtos').doc(parentId).set({ nome: 'Pai', paiId: null });

    // Two variation children pointing back at the parent, each carrying a
    // subcollection doc that must be swept along with the child.
    for (const cid of childIds) {
      const cRef = db.collection('produtos').doc(cid);
      await cRef.set({ nome: `Variação ${cid}`, paiId: parentId });
      await cRef.collection('estoques').doc(`est-${cid}`).set({ parentId: cid, quantidade: 1 });
    }

    // A produto that is NOT a child of the parent (different paiId) must survive.
    await db.collection('produtos').doc(strangerId).set({ nome: 'Alheio', paiId: 'someone-else' });
  });

  it('deletes the variation children and their subtrees, leaving non-children intact', async () => {
    const db = getDb();
    // Match the trigger: the parent doc is already deleted when the cascade runs
    // (children are found by their `paiId`, which survives the parent's deletion).
    await db.collection('produtos').doc(parentId).delete();

    await cascadeProdutoDeletion(db, parentId);

    for (const cid of childIds) {
      const cRef = db.collection('produtos').doc(cid);
      expect((await cRef.get()).exists).toBe(false);
      expect((await cRef.collection('estoques').get()).empty).toBe(true);
    }

    // The unrelated produto is untouched.
    expect((await db.collection('produtos').doc(strangerId).get()).exists).toBe(true);
  });
});

describe.skipIf(!EMULATED)('cascadeProdutoDeletion — idempotence', () => {
  it('is a no-op on an absent produto with no subtree or children', async () => {
    const db = getDb();
    await expect(cascadeProdutoDeletion(db, freshId('absent'))).resolves.toBeUndefined();
  });
});
