import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { recordProdutoModificationAndPropagate } from './onProdutoChanged';

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

/**
 * Fixed event time for every test call — mirrors the CloudEvent `event.time`
 * the wrapper passes; a constant so the redelivery assertions can compare
 * content-identical docs (timestamp included).
 */
const EVENT_TIME_MICROS = Date.parse('2026-07-21T12:00:00.000Z') * 1000;

/**
 * The `historicoDeModificacoes` entries THIS test wrote by calling the core
 * directly — never the whole subcollection.
 *
 * The header above says the trigger wrapper needs no emulation. That was true
 * when this suite ran on firestore alone, but `ci-storage.yml` boots the
 * FUNCTIONS emulator too (`--only firestore,storage,functions`), so the real
 * `onProdutoChanged` is live: every `set()` on a produto here is a produto
 * write, fires it, and appends its own `create` entry. Counting the whole
 * subcollection therefore races that delivery — `toBe(1)` passes only when the
 * trigger has not landed yet, and the `empty` assertions fail once it does.
 *
 * The trigger stamps `timestamp` from the CloudEvent's real time while every
 * direct call here passes the fixed {@link EVENT_TIME_MICROS}, so filtering on
 * it isolates the core's own writes. The assertions stay meaningful: they still
 * fail if the core writes extra entries, or none.
 */
async function coreEntries(db: Firestore, produtoId: string) {
  const snap = await db
    .collection('produtos')
    .doc(produtoId)
    .collection('historicoDeModificacoes')
    .get();
  return snap.docs.filter((d) => d.data().timestamp === EVENT_TIME_MICROS);
}

describe.skipIf(!EMULATED)('onProdutoChanged core (emulator)', () => {
  it('records ONE entry for a parent precos+custo change, no legacy docs', async () => {
    const db = getDb();
    const produtoId = freshId();
    const eventId = freshId('evt');
    await db.collection('produtos').doc(produtoId).set({ nome: 'Produto', paiId: null });

    const before = { nome: 'Produto', paiId: null, precos: { l1: { valor: 10 } }, custo: 5 };
    const after = { nome: 'Produto', paiId: null, precos: { l1: { valor: 20 } }, custo: 10 };
    await recordProdutoModificationAndPropagate(
      db,
      produtoId,
      before,
      after,
      eventId,
      EVENT_TIME_MICROS,
    );

    const entryRef = db
      .collection('produtos')
      .doc(produtoId)
      .collection('historicoDeModificacoes')
      .doc(eventId);
    const entrySnap = await entryRef.get();
    expect(entrySnap.exists).toBe(true);
    const entry = entrySnap.data()!;
    expect(entry.kind).toBe('update');
    expect(entry.campos).toEqual(['custo', 'precos']);
    expect(entry.changes.precos).toEqual({
      old: { l1: { valor: 10 } },
      new: { l1: { valor: 20 } },
    });
    expect(entry.changes.custo).toEqual({ old: 5, new: 10 });
    expect(entry.timestamp).toBe(EVENT_TIME_MICROS);

    expect(await coreEntries(db, produtoId)).toHaveLength(1);

    // The legacy per-lista/per-custo subcollections this trigger used to write
    // are GONE — this PR replaces them with the single unified entry above.
    const legacyPrecos = await db
      .collection('produtos')
      .doc(produtoId)
      .collection('historicoDePrecos')
      .get();
    expect(legacyPrecos.empty).toBe(true);

    const legacyCusto = await db
      .collection('produtos')
      .doc(produtoId)
      .collection('historicoDeCusto')
      .get();
    expect(legacyCusto.empty).toBe(true);
  });

  it('redelivery (same event) rewrites a content-identical entry, never a duplicate', async () => {
    const db = getDb();
    const produtoId = freshId();
    const eventId = freshId('evt');
    await db.collection('produtos').doc(produtoId).set({ nome: 'Produto', paiId: null });

    const before = { nome: 'Produto', paiId: null, precos: { l1: { valor: 10 } } };
    const after = { nome: 'Produto', paiId: null, precos: { l1: { valor: 20 } } };
    await recordProdutoModificationAndPropagate(
      db,
      produtoId,
      before,
      after,
      eventId,
      EVENT_TIME_MICROS,
    );

    const entryRef = db
      .collection('produtos')
      .doc(produtoId)
      .collection('historicoDeModificacoes')
      .doc(eventId);
    const firstDelivery = (await entryRef.get()).data();

    await recordProdutoModificationAndPropagate(
      db,
      produtoId,
      before,
      after,
      eventId,
      EVENT_TIME_MICROS,
    );
    const redelivered = (await entryRef.get()).data();
    expect(redelivered).toEqual(firstDelivery);

    expect(await coreEntries(db, produtoId)).toHaveLength(1);
  });

  it('a create (before undefined) has kind "create" and null "old" sides', async () => {
    const db = getDb();
    const produtoId = freshId();
    const eventId = freshId('evt');

    const after = { nome: 'Novo Produto', paiId: null, precos: { l1: { valor: 20 } }, custo: 10 };
    await recordProdutoModificationAndPropagate(
      db,
      produtoId,
      undefined,
      after,
      eventId,
      EVENT_TIME_MICROS,
    );

    const entry = (
      await db
        .collection('produtos')
        .doc(produtoId)
        .collection('historicoDeModificacoes')
        .doc(eventId)
        .get()
    ).data()!;
    expect(entry.kind).toBe('create');
    expect(entry.changes.nome).toEqual({ old: null, new: 'Novo Produto' });
    expect(entry.changes.precos.old).toBeNull();
    expect(entry.changes.custo).toEqual({ old: null, new: 10 });
  });

  it('propagates precos to a differing child, leaves an identical child untouched', async () => {
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
    await recordProdutoModificationAndPropagate(
      db,
      parentId,
      before,
      after,
      eventId,
      EVENT_TIME_MICROS,
    );

    const same = (await db.collection('produtos').doc(childSame).get()).data()!;
    const diff = (await db.collection('produtos').doc(childDiff).get()).data()!;
    expect(same.precos).toEqual({ l1: { valor: 20 } });
    expect(diff.precos).toEqual({ l1: { valor: 20 } });
  });

  it('propagatePriceToChildren=false records the entry but skips propagation', async () => {
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
    await recordProdutoModificationAndPropagate(
      db,
      parentId,
      before,
      after,
      eventId,
      EVENT_TIME_MICROS,
    );

    expect(await coreEntries(db, parentId)).not.toHaveLength(0);

    const child = (await db.collection('produtos').doc(childId).get()).data()!;
    expect(child.precos).toEqual({ l1: { valor: 5 } }); // untouched
  });

  it('a child write changing ONLY precos records no entry (echo suppressed)', async () => {
    const db = getDb();
    const childId = freshId('echo');
    const eventId = freshId('evt');
    await db
      .collection('produtos')
      .doc(childId)
      .set({ nome: 'Variação', paiId: 'algumPai', precos: { l1: { valor: 5 } } });

    const before = { nome: 'Variação', paiId: 'algumPai', precos: { l1: { valor: 5 } } };
    const after = { nome: 'Variação', paiId: 'algumPai', precos: { l1: { valor: 20 } } };
    await recordProdutoModificationAndPropagate(
      db,
      childId,
      before,
      after,
      eventId,
      EVENT_TIME_MICROS,
    );

    expect(await coreEntries(db, childId)).toHaveLength(0);
  });

  it('a child write changing nome records an entry without precos in campos', async () => {
    const db = getDb();
    const childId = freshId('rename');
    const eventId = freshId('evt');
    await db
      .collection('produtos')
      .doc(childId)
      .set({ nome: 'Antigo', paiId: 'algumPai', precos: { l1: { valor: 5 } } });

    const before = { nome: 'Antigo', paiId: 'algumPai', precos: { l1: { valor: 5 } } };
    const after = { nome: 'Novo', paiId: 'algumPai', precos: { l1: { valor: 20 } } };
    await recordProdutoModificationAndPropagate(
      db,
      childId,
      before,
      after,
      eventId,
      EVENT_TIME_MICROS,
    );

    const entries = await coreEntries(db, childId);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!.data();
    expect(entry.campos).toEqual(['nome']);
  });

  it('is a no-op for a delete event (after undefined) — no entry, no propagation', async () => {
    const db = getDb();
    const produtoId = freshId('deleted');
    const eventId = freshId('evt');
    const before = { nome: 'Deletado', paiId: null, precos: { l1: { valor: 5 } } };

    await expect(
      recordProdutoModificationAndPropagate(
        db,
        produtoId,
        before,
        undefined,
        eventId,
        EVENT_TIME_MICROS,
      ),
    ).resolves.toBeUndefined();

    // No `set()` in this test, so no produto doc and no trigger delivery — the
    // subcollection can only hold what the core wrote, which is nothing.
    expect(await coreEntries(db, produtoId)).toHaveLength(0);
  });
});
