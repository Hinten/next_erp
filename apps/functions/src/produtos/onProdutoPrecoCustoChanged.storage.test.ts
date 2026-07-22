import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { recordProdutoHistoryAndPropagate } from './onProdutoPrecoCustoChanged';

// Integration test — requires the firestore emulator. Drives the I/O core
// directly (the trigger wrapper needs no emulation: its guards are unit-tested
// and it only forwards to the core). Skipped bare, same idiom as the
// sincronizarEstoquePedido / onProdutoDeleted storage suites.
const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';

function getDb(): Firestore {
  const app = getApps()[0] ?? initializeApp({ projectId });
  return getFirestore(app, process.env.FIREBASE_DATABASE_ID ?? 'default');
}

function freshId(prefix = 'p') {
  return `${prefix}${randomUUID().replace(/-/g, '')}`;
}

describe.skipIf(!EMULATED)('onProdutoPrecoCustoChanged core (emulator)', () => {
  it('writes deterministic history docs and is idempotent on redelivery', async () => {
    const db = getDb();
    const produtoId = freshId();
    const eventId = freshId('evt');
    await db.collection('produtos').doc(produtoId).set({ nome: 'Produto', paiId: null });

    const after = { nome: 'Produto', paiId: null, precos: { l1: { valor: 20 } }, custo: 10 };
    await recordProdutoHistoryAndPropagate(
      db,
      produtoId,
      undefined,
      after,
      eventId,
      EVENT_TIME_MILLIS,
    );

    const precoRef = db
      .collection('produtos')
      .doc(produtoId)
      .collection('historicoDePrecos')
      .doc(`${eventId}-l1`);
    const precoDoc = await precoRef.get();
    expect(precoDoc.exists).toBe(true);
    expect(precoDoc.data()).toMatchObject({
      listaDePrecoHistoricoOuterRef: 'documents/listaDePrecos/l1',
      valorOriginal: null,
      valorFinal: 20,
      timestamp: EVENT_TIME_MILLIS,
    });

    // Redelivery idempotency: the SAME event (same id + same event time)
    // rewrites a content-IDENTICAL doc — including the timestamp, which is
    // event-derived rather than wall-clock (Copilot review, PR #609).
    const firstDelivery = precoDoc.data();
    await recordProdutoHistoryAndPropagate(
      db,
      produtoId,
      undefined,
      after,
      eventId,
      EVENT_TIME_MILLIS,
    );
    const redelivered = await precoRef.get();
    expect(redelivered.data()).toEqual(firstDelivery);
    const allPrecoHist = await db
      .collection('produtos')
      .doc(produtoId)
      .collection('historicoDePrecos')
      .get();
    expect(allPrecoHist.size).toBe(1);

    const custoRef = db
      .collection('produtos')
      .doc(produtoId)
      .collection('historicoDeCusto')
      .doc(`${eventId}-custo`);
    expect((await custoRef.get()).data()).toMatchObject({ valor: 10 });

    // Redelivery — same event id, same before/after: rewrites the exact same
    // docs (harmless), never a second record.
    await recordProdutoHistoryAndPropagate(
      db,
      produtoId,
      undefined,
      after,
      eventId,
      EVENT_TIME_MILLIS,
    );
    const precoSnap = await db
      .collection('produtos')
      .doc(produtoId)
      .collection('historicoDePrecos')
      .get();
    expect(precoSnap.size).toBe(1);
  });

  it('propagates the new precos to a differing child, leaves an identical child untouched', async () => {
    const db = getDb();
    const parentId = freshId('parent');
    const childSame = freshId('childsame');
    const childDiff = freshId('childdiff');
    const eventId = freshId('evt');

    await db.collection('produtos').doc(parentId).set({ nome: 'Pai', paiId: null });
    await db
      .collection('produtos')
      .doc(childSame)
      .set({ nome: 'Igual', paiId: parentId, precos: { l1: { valor: 20 } } });
    await db
      .collection('produtos')
      .doc(childDiff)
      .set({ nome: 'Diferente', paiId: parentId, precos: { l1: { valor: 5 } } });

    const before = { nome: 'Pai', paiId: null, precos: { l1: { valor: 10 } } };
    const after = { nome: 'Pai', paiId: null, precos: { l1: { valor: 20 } } };
    await recordProdutoHistoryAndPropagate(db, parentId, before, after, eventId, EVENT_TIME_MILLIS);

    const same = (await db.collection('produtos').doc(childSame).get()).data()!;
    const diff = (await db.collection('produtos').doc(childDiff).get()).data()!;
    expect(same.precos).toEqual({ l1: { valor: 20 } });
    expect(diff.precos).toEqual({ l1: { valor: 20 } });
  });

  it('propagatePriceToChildren=false records history but skips propagation', async () => {
    const db = getDb();
    const parentId = freshId('parentnp');
    const childId = freshId('childnp');
    const eventId = freshId('evt');

    await db
      .collection('produtos')
      .doc(parentId)
      .set({ nome: 'Pai sem propagação', paiId: null, propagatePriceToChildren: false });
    await db
      .collection('produtos')
      .doc(childId)
      .set({ nome: 'Filho', paiId: parentId, precos: { l1: { valor: 5 } } });

    const before = { nome: 'Pai sem propagação', paiId: null, precos: null };
    const after = {
      nome: 'Pai sem propagação',
      paiId: null,
      precos: { l1: { valor: 30 } },
      propagatePriceToChildren: false,
    };
    await recordProdutoHistoryAndPropagate(db, parentId, before, after, eventId, EVENT_TIME_MILLIS);

    const historico = await db
      .collection('produtos')
      .doc(parentId)
      .collection('historicoDePrecos')
      .get();
    expect(historico.empty).toBe(false);

    const child = (await db.collection('produtos').doc(childId).get()).data()!;
    expect(child.precos).toEqual({ l1: { valor: 5 } }); // untouched
  });

  it('is a no-op for a variation child (paiId set) — no history, no propagation', async () => {
    const db = getDb();
    const childId = freshId('lonechild');
    const eventId = freshId('evt');
    await db
      .collection('produtos')
      .doc(childId)
      .set({ nome: 'Variação', paiId: 'algumPai', precos: { l1: { valor: 5 } } });

    const before = { nome: 'Variação', paiId: 'algumPai', precos: null };
    const after = { nome: 'Variação', paiId: 'algumPai', precos: { l1: { valor: 5 } } };
    await recordProdutoHistoryAndPropagate(db, childId, before, after, eventId, EVENT_TIME_MILLIS);

    const historico = await db
      .collection('produtos')
      .doc(childId)
      .collection('historicoDePrecos')
      .get();
    expect(historico.empty).toBe(true);
  });

  it('is a no-op for a delete event (after undefined)', async () => {
    const db = getDb();
    const produtoId = freshId('deleted');
    const eventId = freshId('evt');
    const before = { nome: 'Deletado', paiId: null, precos: { l1: { valor: 5 } } };

    await expect(
      recordProdutoHistoryAndPropagate(
        db,
        produtoId,
        before,
        undefined,
        eventId,
        EVENT_TIME_MILLIS,
      ),
    ).resolves.toBeUndefined();

    const historico = await db
      .collection('produtos')
      .doc(produtoId)
      .collection('historicoDePrecos')
      .get();
    expect(historico.empty).toBe(true);
  });
});
